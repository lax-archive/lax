// Full-pipeline tests that run the real host `lake` as a subprocess against
// the fake mathlib (see test/fake-mathlib.ts). These are the executable proof
// that local `lax build` works end to end: in place, incrementally, with the
// same shared Static/Resolution/Inspect judging the trusted workflow runs.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { warmDir } from "../../src/submission-validation/host/warmstore.js";
import { sharedWarmBase } from "../paths.js";
import {
  buildOnHost,
  freshLaxHome,
  git,
  gitInitCommit,
  linkSharedDirs,
  makeHostSubmission,
  tmpDir,
} from "../support/host.js";

beforeAll(() => {
  freshLaxHome();
});

/** Every entry under dir keyed by its stat identity (atime excluded): a
 * byte-for-byte "nothing in the store was touched" witness. */
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

describe("host pipeline (real lake, fake mathlib)", () => {
  it("passes on the scaffolded empty submission", async () => {
    const root = makeHostSubmission("lax-1");
    const report = await buildOnHost(root, { id: "lax-1" });
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.buildOutput).toBeDefined();
    expect(report.buildOutput!.concepts).toEqual([]);
    expect(report.runtime.image).toBe("host");
  });

  it("passes a concept+proof submission with replay, derives output, and rebuilds incrementally", async () => {
    const root = makeHostSubmission("lax-2", {
      "concepts/Lax2.lean": "import Lax2.Zero\nimport Lax2.One\n",
      "concepts/Lax2/Zero.lean": `/-!
---
title: Zero equals zero
type: theorem
---
The trivial claim.

# Review notes

Nothing to review yet.
-/

namespace Lax2.Zero

/-- zero equals zero -/
axiom zeroEq : 0 = 0

end Lax2.Zero
`,
      "concepts/Lax2/One.lean": `/-!
---
title: One equals one
type: theorem
---
The other trivial claim.
-/

namespace Lax2.One

/-- one equals one -/
axiom oneEq : 1 = 1

end Lax2.One
`,
      "proofs/Lax2Proofs.lean": "import Lax2Proofs.Basic\n",
      "proofs/Lax2Proofs/Basic.lean": `import Lax2.Zero
import Lax2.One

namespace Lax2Proofs

/--
---
conclusion: Lax2.Zero.zeroEq
---
by rfl
-/
theorem zero_eq : 0 = 0 := rfl

/--
---
conclusion: Lax2.One.oneEq
assumptions:
  - Lax2.Zero.zeroEq
---
uses the other statement

# Strategy

By rfl after touching the assumption.
-/
theorem one_eq : 1 = 1 := by
  have h := Lax2.Zero.zeroEq
  rfl

end Lax2Proofs
`,
    });
    // the warm store is sealed (files *and* directories read-only) and must
    // come out of the builds byte-for-byte untouched — consumers use it in
    // place through package overrides, never by writing anything near it
    const warm = fs.realpathSync(warmDir(sharedWarmBase()));
    expect(fs.statSync(warm).mode & 0o222).toBe(0);
    expect(fs.statSync(path.join(warm, ".lake", "packages", "mathlib")).mode & 0o222).toBe(0);
    const storeBefore = snapshotTree(warm);

    const report = await buildOnHost(root, { id: "lax-2", replay: true });
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    const out = report.buildOutput!;
    expect(out.concepts.map((c) => c.id).sort()).toEqual(["Lax2.One", "Lax2.Zero"]);
    const zero = out.concepts.find((c) => c.id === "Lax2.Zero")!;
    const one = out.concepts.find((c) => c.id === "Lax2.One")!;
    expect(zero.title).toBe("Zero equals zero");
    expect(zero.type).toBe("theorem");
    expect(zero.description).toBe("The trivial claim.");
    expect(zero.sections).toEqual([{ title: "Review notes", markdown: "Nothing to review yet." }]);
    expect(zero.statements.map((s) => s.id)).toEqual(["Lax2.Zero.zeroEq"]);
    expect(zero.statements.map((s) => s.doc)).toEqual(["zero equals zero"]);
    expect(one.statements.map((s) => s.id)).toEqual(["Lax2.One.oneEq"]);
    expect(zero.mathlibImports).toEqual([]);
    expect(out.proofs.map((p) => [p.conclusion, p.assumptions])).toEqual([
      ["Lax2.One.oneEq", ["Lax2.Zero.zeroEq"]],
      ["Lax2.Zero.zeroEq", []],
    ]);
    expect(out.proofs[0]!.description).toBe("uses the other statement");
    expect(out.proofs[0]!.sections).toEqual([
      { title: "Strategy", markdown: "By rfl after touching the assumption." },
    ]);

    // The overrides design leaves no dependency clones in the submission:
    // no `.lake/packages` at all, just the lax-written overrides file
    // pointing every warm package at the store, while the generated manifest
    // keeps the warm git-type pin entries verbatim.
    for (const kind of ["concepts", "proofs"]) {
      expect(fs.existsSync(path.join(root, kind, ".lake", "packages"))).toBe(false);
      const overrides = JSON.parse(
        fs.readFileSync(path.join(root, kind, ".lake", "package-overrides.json"), "utf8"),
      ) as { packages: { type: string; name: string; dir: string }[] };
      const mathlib = overrides.packages.find((pkg) => pkg.name === "mathlib")!;
      expect(mathlib.type).toBe("path");
      expect(mathlib.dir).toBe(path.join(warm, ".lake", "packages", "mathlib"));
      const manifest = JSON.parse(
        fs.readFileSync(path.join(root, kind, "lake-manifest.json"), "utf8"),
      ) as { packages: { type: string; name: string }[] };
      expect(manifest.packages.find((pkg) => pkg.name === "mathlib")!.type).toBe("git");
    }

    // The build ran in place: the author's own .lake trees carry the
    // artifacts, and an immediate rebuild reuses them untouched.
    const rootOlean = path.join(root, "concepts", ".lake", "build", "lib", "lean", "Lax2.olean");
    expect(fs.existsSync(rootOlean)).toBe(true);
    const before = fs.statSync(rootOlean).mtimeMs;

    // A stale `.lake/packages` clone from the hardlink-farm era must never be
    // consulted: the override replaces the manifest entry outright. Poison it
    // — if lake read this, the rebuild would fail.
    const stale = path.join(root, "concepts", ".lake", "packages", "mathlib");
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, "lakefile.toml"), "this is not a lakefile\n");

    const again = await buildOnHost(root, { id: "lax-2" });
    expect(again.violations).toEqual([]);
    expect(fs.statSync(rootOlean).mtimeMs).toBe(before);

    // and the sealed store is exactly as it was before either build
    expect(snapshotTree(warm)).toEqual(storeBefore);
  });

  it("carries the full multi-line lake transcript into the compile violation", async () => {
    const root = makeHostSubmission("lax-3", {
      "concepts/Lax3.lean": "import Lax3.Broken\n",
      "concepts/Lax3/Broken.lean": `/-!
---
title: Broken
type: theorem
---
does not compile
-/

namespace Lax3.Broken

def x : Nat := "not a Nat"

end Lax3.Broken
`,
    });
    const report = await buildOnHost(root, { id: "lax-3" });
    expect(report.ok).toBe(false);
    const compile = report.violations.find((v) => v.phase === "compile-concepts");
    expect(compile).toBeDefined();
    expect(compile!.message).toContain("`lake build` failed in concepts/");
    expect(compile!.message).toContain("\n");
    expect(compile!.message).toContain("error");
    expect(compile!.message).toContain("Broken.lean");
  });

  it("builds end to end through the lax CLI subprocess", async () => {
    const clientHome = linkSharedDirs(tmpDir("lax-cli-home-"));
    const database = path.join(clientHome, "lax-database");
    fs.mkdirSync(database, { recursive: true });
    fs.writeFileSync(path.join(database, "README.md"), "fake database\n");
    gitInitCommit(database);
    const root = makeHostSubmission("lax-4");
    gitInitCommit(root);
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const result = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
        path.join(repoRoot, "src", "cli", "main.ts"),
        "build",
        root,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, LAX_HOME: clientHome },
        timeout: 590_000,
      },
    );
    expect(result.stderr).not.toContain("lax build:");
    expect(result.stdout).toContain("lax build: OK");
    expect(result.status).toBe(0);
    const output = JSON.parse(fs.readFileSync(path.join(root, "build-output.json"), "utf8")) as {
      id: string;
      localValidation: { archiveSha: string };
    };
    expect(output.id).toBe("lax-4");
    expect(output.localValidation.archiveSha).toBe(git(database, "rev-parse", "HEAD"));
  });
});
