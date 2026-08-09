// Full-pipeline tests that run the real host `lake` as a subprocess against
// the fake mathlib (see test/fake-mathlib.ts). These are the executable proof
// that local `lax build` works end to end: in place, incrementally, with the
// same shared Static/Resolution/Inspect judging the trusted workflow runs.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { formatProfile, Profiler } from "../../src/shared/profile.js";
import { packageNameForSubmission } from "../../src/submission-validation/contracts.js";
import { warmDir } from "../../src/submission-validation/host/warmstore.js";
import { sharedWarmBase } from "../paths.js";
import {
  buildOnHost,
  freshLaxHome,
  git,
  gitInitCommit,
  linkSharedDirs,
  makeHostSubmission,
  messages,
  rules,
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

  it("never flags Lean-realized helpers for imported defs as namespace violations", async () => {
    // Lean lazily realizes matcher/equation helpers into the *using* module's
    // olean under the imported definition's namespace
    // (`<fn>.match_1.splitter`, `<fn>.match_1.congr_eq_<n>`, `<fn>.eq_def`,
    // …). The namespace rule must never see them — spec.md: realized lemmas
    // for imported constants are internal details and drop out before the
    // test. Each theorem below forces one realization trigger against a def
    // imported from outside the proof package, so a toolchain pin bump that
    // changes Lean's classification of these helpers fails here, not in an
    // author's field report.
    const root = makeHostSubmission("lax-25", {
      "concepts/Lax25.lean": "import Lax25.Defs\n",
      "concepts/Lax25/Defs.lean": `/-!
---
title: Definitions
type: definition
---
Pattern-matching and recursive definitions for downstream realization.
-/

namespace Lax25.Defs

/-- picks the value or zero -/
def pick : Option Nat → Nat
  | some x => x
  | none => 0

/-- a tiny recursive function -/
def grow : Nat → Nat
  | 0 => 1
  | n + 1 => grow n + 2

end Lax25.Defs
`,
      "proofs/Lax25Proofs.lean": "import Lax25Proofs.Basic\n",
      "proofs/Lax25Proofs/Basic.lean": `import Lax25.Defs

namespace Lax25Proofs

-- split: realizes \`Lax25.Defs.pick.match_1.splitter\`
theorem pick_pos (o : Option Nat) : Lax25.Defs.pick o + 1 > 0 := by
  unfold Lax25.Defs.pick
  split <;> omega

-- split on a core def: realizes \`Option.getD.match_1.splitter\`
theorem getD_pos (o : Option Nat) (d : Nat) : o.getD d + 1 > 0 := by
  unfold Option.getD
  split <;> omega

-- fun_induction: realizes \`grow.induct\` and \`grow.match_1.congr_eq_<n>\`
theorem grow_ge (n : Nat) : Lax25.Defs.grow n ≥ 1 := by
  fun_induction Lax25.Defs.grow n <;> omega

-- rw [eq_def]: realizes the eq-like family for \`grow\`
theorem grow_zero : Lax25.Defs.grow 0 = 1 := by
  rw [Lax25.Defs.grow.eq_def]

-- simp [defn]: realizes the equation lemmas for \`grow\`
theorem grow_succ (n : Nat) : Lax25.Defs.grow (n + 1) = Lax25.Defs.grow n + 2 := by
  simp [Lax25.Defs.grow]

end Lax25Proofs
`,
    });
    const report = await buildOnHost(root, { id: "lax-25" });
    expect(report.violations.filter((violation) => violation.rule === "namespace")).toEqual([]);
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
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
    // a private TMPDIR proves the build's temporary workspace is removed
    // even though parts of it (the sealed capture files) are read-only
    const tmp = tmpDir("lax-cli-tmp-");
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
        env: { ...process.env, LAX_HOME: clientHome, TMPDIR: tmp, NO_COLOR: "1" },
        timeout: 590_000,
      },
    );
    // The report is the six rows and the verdict; nothing goes to stderr on a
    // build that worked, and `build-output.json` never reaches the screen.
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Building lax-4");
    expect(result.stdout).toContain("✓ Checked the layout");
    expect(result.stdout).toContain("✓ Compiled concepts");
    expect(result.stdout).toContain("✓ Compiled proofs");
    expect(result.stdout).toContain("✓ Inspected the statements");
    expect(result.stdout).toMatch(/Built lax-4 in \d/u);
    expect(result.stdout).not.toContain("build-output.json");
    expect(result.status).toBe(0);
    // no lax-build-* workspace lingers in the temp dir (the EACCES littering
    // bug: cleanup must restore write bits before removal)
    expect(fs.readdirSync(tmp).filter((name) => name.startsWith("lax-build-"))).toEqual([]);
    const output = JSON.parse(fs.readFileSync(path.join(root, "build-output.json"), "utf8")) as {
      id: string;
      localValidation: { archiveSha: string };
    };
    expect(output.id).toBe("lax-4");
    expect(output.localValidation.archiveSha).toBe(git(database, "rev-parse", "HEAD"));
  });
});

describe("scoped builds", () => {
  /** A submission whose concept package is sound and whose proof package
   * claims a conclusion that is not a statement. */
  function splitSubmission(id: string): string {
    const concepts = packageNameForSubmission(id);
    const proofs = `${concepts}Proofs`;
    return makeHostSubmission(id, {
      [`concepts/${concepts}.lean`]: `import ${concepts}.Zero\n`,
      [`concepts/${concepts}/Zero.lean`]: `/-!
---
title: Zero
type: theorem
---
The trivial claim.
-/

namespace ${concepts}.Zero

/-- zero equals zero -/
axiom zeroEq : 0 = 0

end ${concepts}.Zero
`,
      [`proofs/${proofs}.lean`]: `import ${proofs}.Basic\n`,
      [`proofs/${proofs}/Basic.lean`]: `import ${concepts}.Zero

namespace ${proofs}

/--
---
conclusion: ${concepts}.Zero.nope
---
no such statement
-/
theorem zero_eq : 0 = 0 := rfl

end ${proofs}
`,
    });
  }

  it("--only concepts skips the proof package and emits no build output", async () => {
    const root = splitSubmission("lax-20");
    const report = await buildOnHost(root, { id: "lax-20", scope: "concepts" });
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    // a scoped run never derives publishable artifacts
    expect(report.buildOutput).toBeUndefined();
    expect(report.capture).toBeUndefined();
    // the proof package was never provisioned or compiled
    expect(fs.existsSync(path.join(root, "proofs", "lake-manifest.json"))).toBe(false);
    expect(fs.existsSync(path.join(root, "proofs", ".lake", "build"))).toBe(false);

    // the same submission fails as a whole (reusing the concept build)
    expect(rules(await buildOnHost(root, { id: "lax-20" }))).toContain("proof");
  });

  it("--only proofs judges proofs against its own concept package", async () => {
    const root = splitSubmission("lax-21");
    const profiler = new Profiler();
    const report = await buildOnHost(root, { id: "lax-21", scope: "proofs", profiler });
    expect(messages(report)).toContain("conclusion Lax21.Zero.nope does not resolve");
    expect(report.buildOutput).toBeUndefined();
    // the concept package carries the statements, so it is still built.
    // Replay is opt-in in every local scope.
    const phases = profiler.snapshot().children.map((span) => span.name);
    expect(phases).toContain("compile concepts");
    expect(phases).toContain("compile proofs");
    expect(phases).not.toContain("replay concepts");
    expect(phases).not.toContain("replay proofs");
  });

  it("profiles the phases it ran", async () => {
    const root = makeHostSubmission("lax-22");
    const profiler = new Profiler();
    const report = await buildOnHost(root, { id: "lax-22", scope: "concepts", replay: true, profiler });
    expect(report.violations).toEqual([]);
    const total = profiler.snapshot();
    const text = formatProfile(total);
    for (const phase of [
      "static validation",
      "provision concepts",
      "compile concepts",
      "replay concepts",
      "inspect concepts",
    ])
      expect(text, text).toContain(phase);
    expect(text).not.toContain("compile proofs");
    // every span is a child of the total, so the shares are bounded by it
    const compile = total.children.find((span) => span.name === "compile concepts")!;
    expect(compile.ms).toBeGreaterThan(0);
    expect(compile.ms).toBeLessThanOrEqual(total.ms);
  });

  it("--only proofs --replay still materializes the concept artifacts Inspect needs", async () => {
    // A malformed concept root that forgets to import its module: the module
    // has no artifact after Compile, and the concepts replay — which would
    // normally materialize it — is out of scope. Inspect must still get the
    // artifact and report the clean root-module violation, not an inspector
    // import failure.
    const root = makeHostSubmission("lax-24", {
      "concepts/Lax24.lean": "\n",
      "concepts/Lax24/Zero.lean": `/-!
---
title: Zero
type: theorem
---
The trivial claim.
-/

namespace Lax24.Zero

/-- zero equals zero -/
axiom zeroEq : 0 = 0

end Lax24.Zero
`,
    });
    const report = await buildOnHost(root, { id: "lax-24", scope: "proofs", replay: true });
    expect(messages(report)).toContain("Lax24 must import exactly its package modules");
    expect(rules(report)).toContain("root-module");
  });
});

describe("provisioning for a plain `lake build`", () => {
  it("leaves the scaffold so raw lake resolves and clones nothing", async () => {
    // The overrides design's user-visible promise: after one `lax build` the
    // author's own editor/`lake build` works with no lax in the loop. Raw
    // lake, no lax: the seeded manifest plus the overrides file mean no
    // resolution, no post_update hook, no network — and no `.lake/packages`
    // tree ever appears in the submission.
    const root = makeHostSubmission("lax-77");
    const report = await buildOnHost(root, { id: "lax-77" });
    expect(report.violations).toEqual([]);

    for (const kind of ["concepts", "proofs"] as const) {
      const packageDir = path.join(root, kind);
      expect(fs.existsSync(path.join(packageDir, "lake-manifest.json"))).toBe(true);
      expect(fs.existsSync(path.join(packageDir, ".lake", "package-overrides.json"))).toBe(true);
      const result = spawnSync("lake", ["build"], {
        cwd: packageDir,
        encoding: "utf8",
        timeout: 120_000,
      });
      const output = `${result.stdout}${result.stderr}`;
      expect(result.status, output).toBe(0);
      expect(output).not.toMatch(/clon|updating|download/iu);
      expect(fs.existsSync(path.join(packageDir, ".lake", "packages"))).toBe(false);
    }
  });
});
