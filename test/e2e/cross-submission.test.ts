// Cross-submission dependencies end to end (real lake, fake mathlib, fake
// ghcr): upstream submissions are built, sealed, pushed through the real
// GhcrCaptureStore, and registered in a lax-database snapshot; a downstream
// local host build then resolves the records and builds the whole dependency
// closure **from source** — the seeded manifest's locked git entries make
// lake clone each upstream at exactly the rev its record pins and build it
// in-workspace, never touching the capture registry. Captures remain the
// trusted container path's mechanism (captures/materialize.ts, covered by
// test/unit/submission-validation-captures.test.ts, the workflow tests, and
// the docker smoke); locally they exist only as database-record metadata.
//
// The upstream repository URLs do not exist. Lake's clones reach the local
// fixture repos through git's own url.<base>.insteadOf rewriting, delivered
// via GIT_CONFIG_* environment variables — pure git configuration on the
// test process, no production seam. A build that fetched anything else, or
// pulled a capture blob, would fail loudly (the fake ghcr records every
// request, and the store snapshot pins byte-identity).
//
// This file also carries the empirical spike verdicts for the source-build
// design at the pinned lake v4.30.0:
//   (a) `lake build` materializes git-type manifest entries — clone at the
//       locked rev — without `lake update` and without post_update hooks;
//   (b) `.lake/package-overrides.json` applies to the materialized packages'
//       inherited requires (their mathlib resolves to the warm store: no
//       mathlib clone ever appears);
//   (c) LAKE_ARTIFACT_CACHE=false stays effective throughout (the sealed
//       read-only store comes out byte-identical; any write would EACCES).

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAPTURES_REPOSITORY } from "../../src/shared/constants.js";
import { epoch } from "../../src/submission-validation/environments.js";
import { warmDir } from "../../src/submission-validation/host/warmstore.js";
import { startFakeGhcr, type FakeGhcr } from "../fake-ghcr.js";
import { sharedWarmBase } from "../paths.js";
import {
  archiveWith,
  publishLocalCapture,
  withSuccessor,
  type PublishedUpstream,
} from "../support/captures.js";
import {
  buildOnHost,
  freshLaxHome,
  git,
  gitInitCommit,
  makeHostSubmission,
  messages,
  rules,
  tmpDir,
} from "../support/host.js";

// The registered source triples. None of these repositories exist: every
// fetch lake performs is redirected to a local fixture by the git rewrites
// below — except "vanished", which has no rewrite and proves the failure
// mode when an upstream repository disappears.
const UPSTREAM_REPOSITORY = "https://github.com/lax-e2e/upstream";
const MIDDLE_REPOSITORY = "https://github.com/lax-e2e/middle";
const VANISHED_REPOSITORY = "https://github.com/lax-e2e/vanished";

let ghcr: FakeGhcr;
let upstream: PublishedUpstream;
let middle: PublishedUpstream;
let vanished: PublishedUpstream;
let down: string;

function requireBlock(name: string, repository: string, commit: string): string {
  return `
[[require]]
name = "${name}"
git = "${repository}"
rev = "${commit}"
subDir = "concepts"
`;
}

const GIT_REWRITE_KEYS: string[] = [];

/** Point git (and therefore lake's clones) of `repository` at `fixture`. */
function rewriteRepository(repository: string, fixture: string): void {
  const index = Number(process.env.GIT_CONFIG_COUNT ?? "0");
  process.env[`GIT_CONFIG_KEY_${index}`] = `url.file://${fixture}.insteadOf`;
  process.env[`GIT_CONFIG_VALUE_${index}`] = repository;
  process.env.GIT_CONFIG_COUNT = String(index + 1);
  GIT_REWRITE_KEYS.push(`GIT_CONFIG_KEY_${index}`, `GIT_CONFIG_VALUE_${index}`);
}

/** Every entry under dir keyed by its stat identity — the byte-for-byte
 * "nothing in the sealed store was touched" witness (spike verdict c). */
function snapshotTree(dir: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const filename = path.join(current, entry.name);
      const stat = fs.lstatSync(filename);
      snapshot.set(
        path.relative(dir, filename),
        `${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ino}`,
      );
      if (entry.isDirectory()) walk(filename);
    }
  };
  walk(dir);
  return snapshot;
}

beforeAll(async () => {
  freshLaxHome();
  ghcr = await startFakeGhcr();
  process.env.LAX_CAPTURE_REGISTRY_URL = ghcr.url;

  // lax-10: the root upstream.
  const up = makeHostSubmission("lax-10", {
    "concepts/Lax10.lean": "import Lax10.Number\n",
    "concepts/Lax10/Number.lean": `/-!
---
title: Three
type: theorem
---
three equals three
-/
namespace Lax10.Number
/-- the claim -/
axiom claim : 3 = 3
end Lax10.Number
`,
  });
  gitInitCommit(up);
  rewriteRepository(UPSTREAM_REPOSITORY, up);
  upstream = await publishLocalCapture("lax-10", up, UPSTREAM_REPOSITORY);

  // lax-13: registered with a repository nothing rewrites — the vanished-
  // upstream case a downstream build must fail loudly on.
  const gone = makeHostSubmission("lax-13", {
    "concepts/Lax13.lean": "import Lax13.Gone\n",
    "concepts/Lax13/Gone.lean": `/-!
---
title: Gone
type: theorem
---
five equals five
-/
namespace Lax13.Gone
/-- the claim -/
axiom claim : 5 = 5
end Lax13.Gone
`,
  });
  gitInitCommit(gone);
  vanished = await publishLocalCapture("lax-13", gone, VANISHED_REPOSITORY);
  // Rewrite the vanished repository to a local path that does not exist:
  // lake's clone attempt fails instantly instead of prompting the network.
  rewriteRepository(VANISHED_REPOSITORY, path.join(tmpDir("lax-vanished-"), "missing"));

  // lax-11: the middle of the chain, itself requiring lax-10 from source.
  const mid = makeHostSubmission("lax-11", {
    "concepts/Lax11.lean": "import Lax11.More\n",
    "concepts/Lax11/More.lean": `import Lax10.Number
/-!
---
title: Four
type: theorem
---
four equals four, building on Three
-/
namespace Lax11.More
/-- the claim -/
axiom claim : 4 = 4
end Lax11.More
`,
  });
  fs.appendFileSync(
    path.join(mid, "concepts", "lakefile.toml"),
    requireBlock("Lax10", UPSTREAM_REPOSITORY, upstream.source.commit),
  );
  gitInitCommit(mid);
  rewriteRepository(MIDDLE_REPOSITORY, mid);
  middle = await publishLocalCapture("lax-11", mid, MIDDLE_REPOSITORY, archiveWith(upstream));

  // lax-12: the downstream under test. Its concept package requires only
  // Lax11 — Lax10 enters that build purely through the transitive closure.
  // The proof package also requires Lax10 directly so it may discharge the
  // transitive statement (Inspect admits conclusions only from declared
  // requires).
  down = makeHostSubmission("lax-12", {
    "concepts/Lax12.lean": "import Lax12.Even\n",
    "concepts/Lax12/Even.lean": `import Lax11.More
/-!
---
title: Six
type: theorem
---
six equals six, building on Four
-/
namespace Lax12.Even
/-- the claim -/
axiom myclaim : 6 = 6
end Lax12.Even
`,
    "proofs/Lax12Proofs.lean": "import Lax12Proofs.Basic\n",
    "proofs/Lax12Proofs/Basic.lean": `import Lax12.Even
import Lax10.Number

namespace Lax12Proofs

/--
---
conclusion: Lax12.Even.myclaim
assumptions:
  - Lax11.More.claim
---
uses the direct upstream statement
-/
theorem my : 6 = 6 := by
  have h := Lax11.More.claim
  rfl

/--
---
conclusion: Lax10.Number.claim
---
discharges the transitive upstream obligation
-/
theorem theirs : 3 = 3 := rfl

end Lax12Proofs
`,
  });
  fs.appendFileSync(
    path.join(down, "concepts", "lakefile.toml"),
    requireBlock("Lax11", MIDDLE_REPOSITORY, middle.source.commit),
  );
  fs.appendFileSync(
    path.join(down, "proofs", "lakefile.toml"),
    requireBlock("Lax11", MIDDLE_REPOSITORY, middle.source.commit) +
      requireBlock("Lax10", UPSTREAM_REPOSITORY, upstream.source.commit),
  );
  gitInitCommit(down);
});

afterAll(async () => {
  delete process.env.LAX_CAPTURE_REGISTRY_URL;
  delete process.env.GIT_CONFIG_COUNT;
  for (const key of GIT_REWRITE_KEYS.splice(0)) delete process.env[key];
  await ghcr.close();
});

describe("cross-submission dependencies (real lake, source builds, fake ghcr)", () => {
  it("published the sealed upstream capture through the real store", () => {
    const digest = `sha256:${upstream.published.digest}`;
    expect(upstream.published.registryBlob).toBe(`ghcr.io/${CAPTURES_REPOSITORY}@${digest}`);
    // The blob landed byte-exact under its content address...
    expect(ghcr.state.blobs.has(digest)).toBe(true);
    // ...via an authenticated push (Basic token exchange, upload, manifest tag).
    const token = ghcr.requests.find((request) => request.path.startsWith("/token"));
    expect(token?.authorization).toMatch(/^Basic /u);
    expect(
      ghcr.requests.some(
        (request) => request.method === "PUT" && request.path.includes("/blobs/uploads/"),
      ),
    ).toBe(true);
    expect(
      ghcr.requests.some(
        (request) => request.method === "PUT" && request.path.includes("/manifests/cap-"),
      ),
    ).toBe(true);
  });

  it("builds the transitive dependency closure from source at the locked revs, replays against it, and never touches the registry", async () => {
    const jobDir = path.join(tmpDir("lax-down-job-"), "work");
    const warm = fs.realpathSync(warmDir(epoch(), sharedWarmBase()));
    const storeBefore = snapshotTree(warm);
    const requestsBefore = ghcr.requests.length;
    const report = await buildOnHost(down, {
      id: "lax-12",
      archive: archiveWith(upstream, middle),
      replay: true,
      jobDir,
    });
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);

    // The dependency edges landed in the derived outputs.
    const out = report.buildOutput!;
    expect(out.requiredByConcepts).toEqual(["Lax11"]);
    expect(out.requiredByProofs).toEqual(["Lax10", "Lax11"]);
    expect(out.concepts[0]!.imports).toEqual(["Lax11.More"]);
    expect(out.proofs.map((proof) => proof.conclusion).sort()).toEqual([
      "Lax10.Number.claim",
      "Lax12.Even.myclaim",
    ]);
    expect(out.proofs.find((proof) => proof.conclusion === "Lax12.Even.myclaim")!.assumptions)
      .toEqual(["Lax11.More.claim"]);

    // Spike verdict (a): both closure members — the declared Lax11 AND the
    // transitively required Lax10 — were materialized by plain `lake build`
    // as clones at exactly the locked revisions.
    for (const kind of ["concepts", "proofs"]) {
      for (const [name, source] of [
        ["Lax11", middle.source],
        ["Lax10", upstream.source],
      ] as const) {
        const clone = path.join(down, kind, ".lake", "packages", name);
        expect(fs.existsSync(clone), clone).toBe(true);
        expect(git(clone, "rev-parse", "HEAD")).toBe(source.commit);
        expect(
          fs.existsSync(path.join(clone, "concepts", ".lake", "build", "lib", "lean", name)),
        ).toBe(true);
      }
      // Spike verdict (b): the overrides file redirected the materialized
      // packages' inherited mathlib requires to the warm store — no mathlib
      // clone anywhere in the workspace.
      expect(fs.existsSync(path.join(down, kind, ".lake", "packages", "mathlib"))).toBe(false);
    }

    // Spike verdict (c): the sealed store is byte-identical — the artifact
    // cache stayed off for the dependency builds too (a single write against
    // the read-only store would have failed the build with EACCES).
    expect(snapshotTree(warm)).toEqual(storeBefore);

    // Never touched the registry: not one request left the build — captures
    // are database metadata locally, and the job dir has no dependency
    // materialization at all.
    expect(ghcr.requests.length).toBe(requestsBefore);
    expect(fs.existsSync(path.join(jobDir, "dependencies"))).toBe(false);
  });

  it("rebuilds incrementally offline: materialized clones are reused without any fetch", async () => {
    const depOlean = path.join(
      down, "concepts", ".lake", "packages", "Lax11", "concepts",
      ".lake", "build", "lib", "lean", "Lax11", "More.olean",
    );
    const before = fs.statSync(depOlean).mtimeMs;
    // Break every rewrite target: any attempt to clone or fetch during the
    // rebuild now hits a nonexistent local path and fails the build fast.
    const saved = GIT_REWRITE_KEYS.filter((key) => key.startsWith("GIT_CONFIG_KEY"))
      .map((key) => [key, process.env[key]!] as const);
    saved.forEach(([key], index) => {
      process.env[key] = `url.file:///lax-e2e-offline-${index}.insteadOf`;
    });
    try {
      const report = await buildOnHost(down, { id: "lax-12", archive: archiveWith(upstream, middle) });
      expect(report.violations).toEqual([]);
      expect(report.ok).toBe(true);
    } finally {
      for (const [key, value] of saved) process.env[key] = value;
    }
    expect(fs.statSync(depOlean).mtimeMs).toBe(before);
  });

  it("fails the compile loudly when a dependency's upstream repository has vanished", async () => {
    // The recorded tradeoff of source-built local dependencies: CI still has
    // the capture, but a local build needs the upstream repository to exist.
    const root = makeHostSubmission("lax-14", {
      "concepts/Lax14.lean": "import Lax14.Top\n",
      "concepts/Lax14/Top.lean": `import Lax13.Gone
/-!
---
title: Top
type: theorem
---
builds on Gone
-/
namespace Lax14.Top
/-- the claim -/
axiom claim : 7 = 7
end Lax14.Top
`,
    });
    fs.appendFileSync(
      path.join(root, "concepts", "lakefile.toml"),
      requireBlock("Lax13", VANISHED_REPOSITORY, vanished.source.commit),
    );
    const report = await buildOnHost(root, { id: "lax-14", archive: archiveWith(vanished) });
    expect(report.ok).toBe(false);
    expect(rules(report)).toContain("build");
    expect(messages(report)).toContain("`lake build` failed in concepts/");
  });

  it("rejects an unregistered source triple at resolution", async () => {
    const lakefile = path.join(down, "concepts", "lakefile.toml");
    const original = fs.readFileSync(lakefile, "utf8");
    fs.writeFileSync(
      lakefile,
      original.replace(middle.source.commit, "0123456789abcdef0123456789abcdef01234567"),
    );
    try {
      const report = await buildOnHost(down, { id: "lax-12", archive: archiveWith(upstream, middle) });
      expect(report.ok).toBe(false);
      expect(rules(report)).toContain("dependency-source");
      expect(messages(report)).toContain("does not match the Archive source triple");
    } finally {
      fs.writeFileSync(lakefile, original);
    }
  });

  it("accepts a draft upstream with a warning", async () => {
    const report = await buildOnHost(down, {
      id: "lax-12",
      archive: archiveWith(upstream, [middle, "draft"]),
    });
    expect(report.violations).toEqual([]);
    expect(report.warnings.map((warning) => warning.message).join("\n"))
      .toContain("dependency Lax11 belongs to draft submission lax-11");
  });

  it("accepts a superseded upstream with a warning", async () => {
    // A newer version of lax-11 exists; the rev-pinned require keeps
    // building, so the author is nudged rather than stopped.
    const report = await buildOnHost(down, {
      id: "lax-12",
      archive: withSuccessor(archiveWith(upstream, middle), "lax-11", "lax-20"),
    });
    expect(report.violations).toEqual([]);
    expect(report.warnings.map((warning) => warning.message).join("\n")).toContain(
      "lax-11 (Lax11) is superseded by lax-20 — consider building on the latest version",
    );
  });
});
