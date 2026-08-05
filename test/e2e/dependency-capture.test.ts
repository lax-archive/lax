// The first end-to-end proof of the host dependency-capture path (real lake,
// fake mathlib, fake ghcr): an upstream submission is built, sealed, pushed
// through the real GhcrCaptureStore to the fake registry, and registered in a
// lax-database snapshot; a downstream submission requiring it then resolves
// the record, pulls the capture blob anonymously by digest, verifies it, and
// builds and replays against the captured oleans without recompiling — or
// even being able to reach — the upstream. Successor of the old
// pipeline.test.ts "builds against a registered upstream and rejects
// unregistered triples".

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAPTURES_REPOSITORY } from "../../src/shared/constants.js";
import { startFakeGhcr, type FakeGhcr } from "../fake-ghcr.js";
import {
  archiveWith,
  publishLocalCapture,
  type PublishedUpstream,
} from "../support/captures.js";
import {
  buildOnHost,
  freshLaxHome,
  gitInitCommit,
  makeHostSubmission,
  messages,
  rules,
  tmpDir,
} from "../support/host.js";

// The upstream's registered source triple. The repository does not exist:
// any attempt to clone or fetch it — instead of using the published capture —
// would fail the build, so a passing downstream build is itself the proof
// that the capture supplied the upstream bits.
const UPSTREAM_REPOSITORY = "https://github.com/lax-e2e/upstream";

let ghcr: FakeGhcr;
let upstream: PublishedUpstream;
let down: string;

function downstreamRequireBlock(commit: string): string {
  return `
[[require]]
name = "Lax10"
git = "${UPSTREAM_REPOSITORY}"
rev = "${commit}"
subDir = "concepts"
`;
}

beforeAll(async () => {
  freshLaxHome();
  ghcr = await startFakeGhcr();
  process.env.LAX_CAPTURE_REGISTRY_URL = ghcr.url;

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
  upstream = await publishLocalCapture("lax-10", up, UPSTREAM_REPOSITORY);

  down = makeHostSubmission("lax-11", {
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
axiom myclaim : 4 = 4
end Lax11.More
`,
    "proofs/Lax11Proofs.lean": "import Lax11Proofs.Basic\n",
    "proofs/Lax11Proofs/Basic.lean": `import Lax11.More

namespace Lax11Proofs

/--
---
conclusion: Lax11.More.myclaim
assumptions:
  - Lax10.Number.claim
---
uses the upstream statement
-/
theorem my : 4 = 4 := by
  have h := Lax10.Number.claim
  rfl

/--
---
conclusion: Lax10.Number.claim
---
discharges the upstream obligation
-/
theorem theirs : 3 = 3 := rfl

end Lax11Proofs
`,
  });
  for (const kind of ["concepts", "proofs"]) {
    fs.appendFileSync(
      path.join(down, kind, "lakefile.toml"),
      downstreamRequireBlock(upstream.source.commit),
    );
  }
  gitInitCommit(down);
});

afterAll(async () => {
  delete process.env.LAX_CAPTURE_REGISTRY_URL;
  await ghcr.close();
});

describe("cross-submission dependency captures (real lake, fake ghcr)", () => {
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

  it("resolves the upstream, materializes its capture from the registry, and builds and replays against it", async () => {
    const jobDir = path.join(tmpDir("lax-down-job-"), "work");
    const before = ghcr.requests.length;
    const report = await buildOnHost(down, {
      id: "lax-11",
      archive: archiveWith(upstream),
      replay: true,
      jobDir,
    });
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);

    // The dependency edge landed in the derived outputs.
    const out = report.buildOutput!;
    expect(out.requiredByConcepts).toEqual(["Lax10"]);
    expect(out.requiredByProofs).toEqual(["Lax10"]);
    expect(out.concepts[0]!.imports).toEqual(["Lax10.Number"]);
    expect(out.proofs.map((proof) => proof.conclusion).sort()).toEqual([
      "Lax10.Number.claim",
      "Lax11.More.myclaim",
    ]);
    expect(out.proofs.find((proof) => proof.conclusion === "Lax11.More.myclaim")!.assumptions)
      .toEqual(["Lax10.Number.claim"]);

    // The upstream oleans came from the registry, digest-addressed and
    // anonymous: a tokenless pull-token request, then the blob by digest.
    const pulls = ghcr.requests.slice(before);
    const token = pulls.find((request) => request.path.startsWith("/token"));
    expect(token).toBeDefined();
    expect(token?.authorization).toBeUndefined();
    expect(
      pulls.some(
        (request) =>
          request.method === "GET" &&
          request.path.endsWith(`/blobs/sha256:${upstream.published.digest}`),
      ),
    ).toBe(true);
    expect(pulls.some((request) => request.method === "PUT" || request.method === "POST")).toBe(false);

    // Materialized read-only — recompiling the upstream is impossible, and
    // the downstream build trees never grew their own Lax10 artifacts (the
    // "Replayed, not rebuilt" witness; the nonexistent upstream repository
    // already rules out a clone).
    const olean = path.join(jobDir, "dependencies", "lax-10", "concepts", "lib", "Lax10", "Number.olean");
    expect(fs.existsSync(olean)).toBe(true);
    expect(fs.statSync(olean).mode & 0o222).toBe(0);
    for (const kind of ["concepts", "proofs"]) {
      expect(fs.existsSync(path.join(down, kind, ".lake", "build", "lib", "lean", "Lax10"))).toBe(false);
      expect(fs.existsSync(path.join(down, kind, ".lake", "packages"))).toBe(false);
    }
  });

  it("fails closed with a digest violation when the registry blob is tampered with", async () => {
    const digest = `sha256:${upstream.published.digest}`;
    const genuine = ghcr.state.blobs.get(digest)!;
    const tampered = Buffer.from(genuine);
    tampered[Math.floor(tampered.length / 2)]! ^= 0xff;
    ghcr.state.blobs.set(digest, tampered);
    try {
      const report = await buildOnHost(down, { id: "lax-11", archive: archiveWith(upstream) });
      expect(report.ok).toBe(false);
      expect(rules(report)).toContain("dependency-capture");
      expect(messages(report)).toContain("capture archive digest mismatch for lax-10");
    } finally {
      ghcr.state.blobs.set(digest, genuine);
    }
  });

  it("rejects an unregistered source triple at resolution", async () => {
    const lakefile = path.join(down, "concepts", "lakefile.toml");
    const original = fs.readFileSync(lakefile, "utf8");
    fs.writeFileSync(
      lakefile,
      original.replace(upstream.source.commit, "0123456789abcdef0123456789abcdef01234567"),
    );
    try {
      const report = await buildOnHost(down, { id: "lax-11", archive: archiveWith(upstream) });
      expect(report.ok).toBe(false);
      expect(rules(report)).toContain("dependency-source");
      expect(messages(report)).toContain("does not match the Archive source triple");
    } finally {
      fs.writeFileSync(lakefile, original);
    }
  });

  it("accepts a draft upstream with a warning", async () => {
    const report = await buildOnHost(down, {
      id: "lax-11",
      archive: archiveWith([upstream, "draft"]),
    });
    expect(report.violations).toEqual([]);
    expect(report.warnings.map((warning) => warning.message).join("\n"))
      .toContain("dependency Lax10 belongs to draft submission lax-10");
  });
});
