// The spec-2 fake environment end to end on the host (axiomfree-plan.md,
// stage 1): a row under the rehearsal toolchain whose set is the fake
// mathlib plus the fixture LaxCore (test/fake-laxcore.ts). The warm store
// has to provision the whole set, a scaffolded package requiring both has to
// build — and import LaxCore, and tag a definition — and a package that
// forgets LaxCore has to fail the libraries rule before anything is built.
//
// Skips itself where the rehearsal toolchain is not installed; ci.yml installs
// it (test/paths.ts SPEC2_TOOLCHAIN). Stage 2 added the content rules: the
// inspector reads the tag from the real oleans, the validator classifies
// statements and proofs, and `build-output.json` records telescopes — the
// second block below proves that whole path through the host pipeline.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { certify } from "../../src/cli/certify.js";
import { scaffoldSubmission } from "../../src/cli/scaffold.js";
import * as ui from "../../src/cli/ui.js";
import { CAPTURES_REPOSITORY } from "../../src/shared/constants.js";
import { readBundle, sealBundle } from "../../src/submission-validation/certify/bundle.js";
import { checkChallengeReport } from "../../src/submission-validation/certify/challenge-check.js";
import { BUNDLE_FILES, type BundleFile } from "../../src/submission-validation/certify/generate.js";
import {
  GIT_SHIM,
  challengeProjectFiles,
  planCertificate,
  projectLibDir,
  solutionProjectFiles,
  stageOwnPackage,
  warmLibDirs,
  writeJudgeProject,
  writeRunProject,
  type CertifyRecord,
} from "../../src/submission-validation/certify/project.js";
import {
  SELF_TEST_MODULES,
  SELF_TEST_PACKAGE,
  SELF_TEST_THEOREM,
  forgeKernelRejection,
  selfTestComparatorConfig,
  selfTestExportTargets,
  selfTestProjectFiles,
  toolDigests,
} from "../../src/submission-validation/certify/self-test.js";
import { interpretComparatorRun } from "../../src/submission-validation/certify/verdict.js";
import type { HostValidationReport } from "../../src/submission-validation/host/pipeline.js";
import {
  environment as environmentById,
  epoch,
  librariesOf,
} from "../../src/submission-validation/environments.js";
import { inspectorBinary } from "../../src/submission-validation/host/inspector.js";
import { lakeBinary, lakePathEnv, toolchainBinDir, toolchainDir } from "../../src/submission-validation/host/leanenv.js";
import { run } from "../../src/submission-validation/host/proc.js";
import { parseInspectorReport } from "../../src/submission-validation/phases/inspect-runner.js";
import { readWarmManifestPackages, seedOverrides, warmDir, warmReady } from "../../src/submission-validation/host/warmstore.js";
import { recordedBuildOutput } from "../../src/submission-validation/recorded-shape.js";
import { startFakeGhcr } from "../fake-ghcr.js";
import { SHARED_TOOLS, sharedWarmBase } from "../paths.js";
import { archiveWith, publishLocalCapture } from "../support/captures.js";
import { spec2TestEnvironment, withTestEnvironments, withTestEnvironmentsAsync } from "../support/environments.js";
import { buildOnHost, freshLaxHome, makeHostSubmission, messages, rules, tmpDir } from "../support/host.js";

/** The registered source of lax-38 in the chain test; nothing at this URL
 * exists, a git rewrite points lake at the checkout (cross-submission.test.ts). */
const UPSTREAM_REPOSITORY = "https://github.com/lax-e2e/spec2-upstream";

/** The lax-38 build the later tests reuse: its root, its job directory
 * (the certify project and bundle stay there), and its report. */
let lax38: { root: string; jobDir: string; report: HostValidationReport } | undefined;

/** The registered source of lax-41, the chain test's dependent, once the
 * `lax certify` test has published it beside lax-38. */
const DOWNSTREAM_REPOSITORY = "https://github.com/lax-e2e/spec2-downstream";
let lax41: { root: string } | undefined;

/** Point git at a local checkout for a registered record's URL, for the
 * length of the process: how lake fetches a bundle's git requires here. */
function rewriteUrl(repository: string, checkout: string): void {
  const index = Number(process.env.GIT_CONFIG_COUNT ?? "0");
  process.env[`GIT_CONFIG_KEY_${index}`] = `url.file://${checkout}.insteadOf`;
  process.env[`GIT_CONFIG_VALUE_${index}`] = repository;
  process.env.GIT_CONFIG_COUNT = String(index + 1);
}

// the fixture LaxCore seam is set by test/setup-env.ts for fast runs only;
// a LAX_E2E run keeps the real pins and has no spec-2 row to rehearse
const SPEC2 = process.env.LAX_E2E === "1" ? undefined : spec2TestEnvironment();
const installed =
  SPEC2 !== undefined &&
  withTestEnvironments([SPEC2], () =>
    fs.existsSync(path.join(toolchainDir(environmentById(SPEC2.id)!), "bin", "lean")),
  );

beforeAll(() => {
  freshLaxHome();
});

describe.skipIf(!installed)("a spec-2 archive environment (real lake, fake mathlib, fixture LaxCore)", () => {
  const SPEC2 = spec2TestEnvironment();
  it("provisions the library set and builds a package requiring and importing LaxCore", async () => {
    await withTestEnvironmentsAsync([SPEC2], async () => {
      const environment = environmentById(SPEC2.id)!;
      expect(environment.specVersion).toBe(2);
      expect(environment.leanToolchain).not.toBe(epoch().leanToolchain);
      expect(librariesOf(environment).map((library) => library.name)).toEqual(["mathlib", "LaxCore"]);

      const root = makeHostSubmission(
        "lax-35",
        {
          "concepts/Lax35.lean": "import Lax35.Zero\n",
          "concepts/Lax35/Zero.lean": `import LaxCore

/-!
---
title: Zero equals zero
type: theorem
---
A statement in the spec-2 shape: a tagged \`def\` of type \`Prop\`.
-/

namespace Lax35.Zero

/-- zero equals zero -/
@[lax_statement] def ZeroEq : Prop := 0 = 0

end Lax35.Zero
`,
          "proofs/Lax35Proofs.lean": "import Lax35Proofs.Basic\n",
          "proofs/Lax35Proofs/Basic.lean": `import Lax35.Zero

namespace Lax35Proofs

theorem zero_eq : Lax35.Zero.ZeroEq := rfl

end Lax35Proofs
`,
        },
        undefined,
        { environment },
      );
      // the scaffold wrote the row's content spec and both libraries
      expect(fs.readFileSync(path.join(root, "manifest.yaml"), "utf8")).toContain('specVersion: "2"');
      const conceptLakefile = fs.readFileSync(path.join(root, "concepts", "lakefile.toml"), "utf8");
      expect(conceptLakefile).toContain('name = "LaxCore"');
      expect(conceptLakefile).toContain(`rev = "${process.env.LAX_LAXCORE_REV}"`);

      const report = await buildOnHost(root, { id: "lax-35" });
      expect(messages(report)).toBe("");
      expect(report.ok).toBe(true);
      expect(report.runtime.environment).toBe(SPEC2.id);
      expect(report.runtime.leanToolchain).toBe(SPEC2.leanToolchain);
      // the tagged def is a statement and the theorem over it is the edge {} → ZeroEq
      expect(report.buildOutput!.concepts[0]!.statements.map((statement) => statement.id)).toEqual(["Lax35.Zero.ZeroEq"]);
      expect(report.buildOutput!.proofs.map((proof) => [proof.conclusion, proof.assumptions])).toEqual([["Lax35.Zero.ZeroEq", []]]);

      // the warm store of the row holds the whole set, built, and sealed
      const warm = fs.realpathSync(warmDir(environment, sharedWarmBase()));
      expect(warmReady(warm)).toBe(true);
      expect(path.basename(warm)).toBe(`${SPEC2.id}-${environment.mathlibCommit.slice(0, 12)}-${process.env.LAX_LAXCORE_REV!.slice(0, 12)}`);
      expect(fs.readFileSync(path.join(warm, "LaxWarm.lean"), "utf8")).toBe("import Mathlib\nimport LaxCore\n");
      const warmManifest = JSON.parse(fs.readFileSync(path.join(warm, "lake-manifest.json"), "utf8")) as {
        packages: { name: string; type: string; rev?: string }[];
      };
      expect(warmManifest.packages.map((pkg) => [pkg.name, pkg.type, pkg.rev]).sort()).toEqual([
        ["LaxCore", "git", process.env.LAX_LAXCORE_REV],
        ["mathlib", "git", process.env.LAX_MATHLIB_REV],
      ]);
      const laxCoreOlean = path.join(warm, ".lake", "packages", "LaxCore", ".lake", "build", "lib", "lean", "LaxCore.olean");
      expect(fs.existsSync(laxCoreOlean)).toBe(true);
      expect(fs.statSync(laxCoreOlean).mode & 0o222).toBe(0);

      // and both packages were redirected at it through the overrides, with
      // the git-type entries kept verbatim in their seeded manifests
      for (const kind of ["concepts", "proofs"]) {
        const overrides = JSON.parse(
          fs.readFileSync(path.join(root, kind, ".lake", "package-overrides.json"), "utf8"),
        ) as { packages: { type: string; name: string; dir: string }[] };
        const laxCore = overrides.packages.find((pkg) => pkg.name === "LaxCore")!;
        expect(laxCore.type).toBe("path");
        expect(laxCore.dir).toBe(path.join(warm, ".lake", "packages", "LaxCore"));
        const manifest = JSON.parse(
          fs.readFileSync(path.join(root, kind, "lake-manifest.json"), "utf8"),
        ) as { packages: { type: string; name: string; rev?: string }[] };
        expect(manifest.packages.find((pkg) => pkg.name === "LaxCore")).toMatchObject({
          type: "git",
          rev: process.env.LAX_LAXCORE_REV,
        });
        expect(fs.existsSync(path.join(root, kind, ".lake", "packages"))).toBe(false);
      }
    });
  }, 600_000);

  // Decision 10: the namespace rule is the composition rule, and the
  // inspector's exemption of compiler-realized reserved names is that rule
  // applied — Lean persists them under the *rewritten* function's namespace
  // (here the concept package's), regenerates them identically in every
  // package that needs them, and `finalizeImport` tolerates the duplicates.
  // This fixture triggers every shape `userLevelName?` exempts so a new
  // toolchain's new shape is found at admission, never by an author
  // (history/environments-plan.md, admission checklist).
  it("admits the reserved names a proof package realizes under a concept's namespace, and the proofs Lean abstracts", async () => {
    await withTestEnvironmentsAsync([SPEC2], async () => {
      const environment = environmentById(SPEC2.id)!;
      const root = makeHostSubmission(
        "lax-39",
        {
          "concepts/Lax39.lean": "import Lax39.Shapes\n",
          "concepts/Lax39/Shapes.lean": `import LaxCore

/-!
---
title: Shapes
type: theorem
---
Definitions whose use in a dependent package realizes reserved names.
-/

namespace Lax39.Shapes

/-- an instance argument: simp through it realizes \`Bounded.congr_simp\` -/
def Bounded {α : Type} [LT α] (bound x : α) : Prop := x < bound

/-- a definition to unfold: \`IsSmall.eq_def\`, \`IsSmall.eq_1\` -/
def IsSmall (n : Nat) : Prop := n < 10

/-- a definition by match: \`pick.match_1.splitter\` and its equations -/
def pick (n : Nat) : Nat :=
  match n with
  | 0 => 1
  | k + 1 => k

/-- a dependent argument: simp through it realizes \`guarded.congr_simp\` -/
def guarded (n : Nat) (_h : n < 10) : Nat := n

/-- a recursive definition: \`unfold\` realizes \`sumTo.eq_def\` -/
def sumTo : Nat → Nat
  | 0 => 0
  | n + 1 => (n + 1) + sumTo n

@[lax_statement] def Facts : Prop :=
  Bounded (10 : Nat) (2 + 1) ∧ IsSmall 3 ∧ IsSmall (1 + 2) ∧ pick 0 = 1 ∧ (∀ n, pick (n + 1) = n)
    ∧ (∀ n, pick n = 1 ∨ pick n = n - 1) ∧ (∀ (f g : Nat → Nat) x y (h : f x = g y), pick (f x) = pick (g y))
    ∧ guarded (1 + 2) (by decide) = 3 ∧ sumTo 0 = 0 ∧ (∀ n, pick n ≤ n + 1)

end Lax39.Shapes
`,
          "proofs/Lax39Proofs.lean": "import Lax39Proofs.Basic\n",
          "proofs/Lax39Proofs/Basic.lean": `import Lax39.Shapes

namespace Lax39Proofs

open Lax39.Shapes

theorem bounded_sum : Bounded (10 : Nat) (2 + 1) := by simp only [Nat.reduceAdd]; simp [Bounded]
theorem small_unfold : IsSmall 3 := by unfold IsSmall; decide
theorem small_simp : IsSmall (1 + 2) := by simp only [Nat.reduceAdd]; simp [IsSmall]
theorem pick_zero : pick 0 = 1 := by simp [pick]
theorem pick_succ (n : Nat) : pick (n + 1) = n := by simp [pick]
theorem pick_cases (n : Nat) : pick n = 1 ∨ pick n = n - 1 := by
  unfold pick
  split <;> simp
/-- a congruence step through \`pick\`: neither \`congr\` nor \`grind\` realizes
\`pick.hcongr_<n>\` for a first-order function under v4.35.0-rc3 (both reach for
\`congrArg\`), so that shape stays uncovered here — see the assertion list -/
theorem pick_congr (f g : Nat → Nat) (x y : Nat) (h : f x = g y) : pick (f x) = pick (g y) := by grind
theorem guarded_sum : guarded (1 + 2) (by decide) = 3 := by simp only [Nat.reduceAdd]; rfl
theorem sumTo_zero : sumTo 0 = 0 := by unfold sumTo; rfl
/-- a \`match\` in the goal: \`grind\` realizes \`pick.match_1.congr_eq_<n>\` -/
theorem pick_le (n : Nat) : pick n ≤ n + 1 := by unfold pick; grind

theorem facts : Lax39.Shapes.Facts :=
  ⟨bounded_sum, small_unfold, small_simp, pick_zero, pick_succ, pick_cases, pick_congr, guarded_sum, sumTo_zero, pick_le⟩

/-- a definition carrying a non-trivial nested proof: Lean abstracts it into
\`withFacts._proof_1 : Facts → Facts\`, a theorem of proof shape it generated,
which is a helper -/
def withFacts (h : Lax39.Shapes.Facts) : {_n : Nat // Lax39.Shapes.Facts} :=
  ⟨0, (⟨h, h⟩ : Lax39.Shapes.Facts ∧ Lax39.Shapes.Facts).left⟩

/-- the same under a \`private def\`: the abstraction is
\`_private.Lax39Proofs.Basic.0.Lax39Proofs.hiddenWithFacts._proof_1\`, private
by its mangling but generated by Lean — a helper, not a private proof (two
hypotheses: Lean reuses an abstracted proof of the same type, so the same
body would yield \`withFacts._proof_1\` again) -/
private def hiddenWithFacts (h h' : Lax39.Shapes.Facts) : {_n : Nat // Lax39.Shapes.Facts} :=
  ⟨0, (⟨h, h'⟩ : Lax39.Shapes.Facts ∧ Lax39.Shapes.Facts).left⟩

end Lax39Proofs
`,
        },
        undefined,
        { environment },
      );
      const jobDir = path.join(tmpDir("lax-39-job-"), "work");
      const report = await buildOnHost(root, { id: "lax-39", jobDir });
      expect(messages(report)).toBe("");
      expect(report.ok).toBe(true);
      expect(report.buildOutput!.proofs.map((proof) => proof.id)).toEqual(["Lax39Proofs.facts"]);
      // what the proof package's oleans actually carry: the realized names
      // under Lax39.Shapes, reported without a userName, and the rule silent
      const inspected = JSON.parse(fs.readFileSync(path.join(jobDir, "checks", "inspect-proofs", "report.json"), "utf8")) as {
        declarations: Array<{ name: string; kind: string; userName?: string; origin?: { kind: string; parent?: string; module?: string }; telescope?: unknown }>;
      };
      // the abstracted nested proof: a theorem of proof shape over two
      // statements, generated by Lean, a helper — the build above passed
      // and recorded no edge for it (ultracode review 2026-10-04, I1)
      const abstracted = inspected.declarations.find((declaration) => declaration.name === "Lax39Proofs.withFacts._proof_1");
      expect(abstracted).toMatchObject({
        kind: "theorem",
        origin: { kind: "auxiliary", parent: "Lax39Proofs.withFacts" },
        telescope: { hypotheses: [{ const: "Lax39.Shapes.Facts", levels: [] }], conclusion: { const: "Lax39.Shapes.Facts", levels: [] } },
      });
      expect(abstracted).not.toHaveProperty("userName");
      // and under a private parent: private by its mangling, with the parent
      // that says Lean generated it; the private def itself is authored and
      // reports no parent (ultracode review 2026-10-04, I1 follow-up)
      const hidden = "_private.Lax39Proofs.Basic.0.Lax39Proofs.hiddenWithFacts";
      expect(inspected.declarations.find((declaration) => declaration.name === `${hidden}._proof_1`)).toMatchObject({
        kind: "theorem",
        origin: { kind: "private", module: "Lax39Proofs.Basic", parent: "Lax39Proofs.hiddenWithFacts" },
        telescope: {
          hypotheses: [
            { const: "Lax39.Shapes.Facts", levels: [] },
            { const: "Lax39.Shapes.Facts", levels: [] },
          ],
          conclusion: { const: "Lax39.Shapes.Facts", levels: [] },
        },
      });
      expect(inspected.declarations.find((declaration) => declaration.name === hidden)?.origin).toEqual({ kind: "private", module: "Lax39Proofs.Basic" });
      const realized = inspected.declarations.filter(
        (declaration) => !declaration.name.startsWith("Lax39Proofs") && !declaration.name.startsWith(hidden),
      );
      expect(realized.length).toBeGreaterThan(0);
      for (const declaration of realized) {
        expect(declaration, declaration.name).not.toHaveProperty("userName");
        // and the one provenance fact the rules consult says why: realized
        // under the concept's constant, or — a matcher's `eq_<n>` and
        // `splitter`, private per module by design — private, mangled with
        // this package's own module, which settles ownership before anything
        // Lean realized inside it, and realized under the concept's matcher
        if (declaration.name.startsWith("_private.")) {
          expect(declaration.origin?.kind, declaration.name).toBe("private");
          expect(declaration.origin?.module, declaration.name).toBe("Lax39Proofs.Basic");
          expect(declaration.origin?.parent, declaration.name).toMatch(/^Lax39\.Shapes\./u);
        } else {
          expect(declaration.origin?.kind, declaration.name).toBe("realized");
          expect(declaration.origin?.parent, declaration.name).toMatch(/^Lax39\.Shapes\./u);
        }
      }
      const names = realized.map((declaration) => declaration.name);
      console.log(`[realized names] ${names.join(" ")}`);
      // every shape `userLevelName?` exempts that this toolchain realizes for
      // a dependent package: `congr_simp` (simp through a dependent binder),
      // `eq_def` (unfold of a recursive definition), `eq_<n>` (simp with a
      // definition), the match `splitter` and its `eq_<n>` (split), and the
      // match `congr_eq_<n>` (grind over a match). `hcongr_<n>` is exempted
      // too but no first-order fixture realizes it on v4.35.0-rc3: `congr`
      // and `grind` both prove a one-argument congruence with `congrArg`.
      for (const shape of [
        /\.congr_simp$/u,
        /\.eq_def$/u,
        /\.eq_1$/u,
        /\.match_1\.splitter$/u,
        /\.match_1\.eq_1$/u,
        /\.match_1\.congr_eq_1$/u,
      ]) {
        expect(names.some((name) => shape.test(name)), `${shape} among ${names.join(" ")}`).toBe(true);
      }
    });
  });

  it("refuses a package that omits LaxCore before building anything", async () => {
    await withTestEnvironmentsAsync([SPEC2], async () => {
      const environment = environmentById(SPEC2.id)!;
      const root = makeHostSubmission("lax-36", {}, undefined, { environment, omitLibraries: ["LaxCore"] });
      const report = await buildOnHost(root, { id: "lax-36" });
      expect(report.ok).toBe(false);
      expect(rules(report)).toEqual(new Set(["lakefile"]));
      expect(messages(report)).toContain("concepts/lakefile.toml: the package must require pinned LaxCore directly");
      expect(messages(report)).toContain("proofs/lakefile.toml: the package must require pinned LaxCore directly");
      expect(fs.existsSync(path.join(root, "concepts", "lake-manifest.json"))).toBe(false);
    });
  });

  it("classifies a two-package spec-2 submission and records telescopes in build-output.json", async () => {
    await withTestEnvironmentsAsync([SPEC2], async () => {
      const environment = environmentById(SPEC2.id)!;
      const root = makeHostSubmission(
        "lax-38",
        {
          "concepts/Lax38.lean": "import Lax38.Order\n",
          "concepts/Lax38/Order.lean": `import LaxCore

/-!
---
title: Order facts
type: theorem
---
Two statements and an auxiliary.
-/

namespace Lax38.Order

/-- every natural has a strict successor -/
@[lax_statement] def HasSucc : Prop := ∀ n : Nat, ∃ m, n < m

/-- reflexivity, universe-polymorphic -/
@[lax_statement] def Refl.{u} : Prop := ∀ (α : Sort u) (a : α), a = a

/-- an auxiliary: a Prop-valued definition without the marker -/
def IsSmall (n : Nat) : Prop := n < 10

/-- a keyword name, over a keyword universe: Lean prints both bare -/
@[lax_statement] def «at».{«fun»} : Prop := ∀ (α : Sort «fun») (a : α), a = a

end Lax38.Order
`,
          "proofs/Lax38Proofs.lean": "import Lax38Proofs.Basic\n",
          "proofs/Lax38Proofs/Basic.lean": `import Lax38.Order

namespace Lax38Proofs

/-- a helper -/
theorem lt_succ (n : Nat) : n < n + 1 := Nat.lt_succ_self n

/-- unconditional -/
theorem hasSucc : Lax38.Order.HasSucc := fun n => ⟨n + 1, lt_succ n⟩

/--
conditional, universe-polymorphic

# Strategy

Ignore the hypothesis.
-/
theorem refl_of_hasSucc.{u} (_h : Lax38.Order.HasSucc) : Lax38.Order.Refl.{u} := fun _ _ => rfl

/-- keywords and a \`?\`: the proof, its universe, the statement -/
theorem reflexive?.{«fun»} (_h : Lax38.Order.HasSucc) : Lax38.Order.«at».{«fun»} := fun _ _ => rfl

/-- an implicit hypothesis: the certificate still states it explicitly -/
theorem refl_of_implicit.{u} {_h : Lax38.Order.HasSucc} : Lax38.Order.Refl.{u} := fun _ _ => rfl

end Lax38Proofs
`,
        },
        undefined,
        { environment },
      );
      const jobDir = path.join(tmpDir("lax-38-job-"), "work");
      const started = performance.now();
      const report = await buildOnHost(root, { id: "lax-38", jobDir });
      lax38 = { root, jobDir, report };
      expect(messages(report)).toBe("");
      expect(report.ok).toBe(true);
      expect(report.warnings).toEqual([]);
      const out = report.buildOutput!;
      // Stage 3: the record is certified end to end on the host — the same
      // generator and the same three steps as the archive's containers.
      const certificate = out.certificate!;
      expect(certificate).toMatchObject({
        // a local run proves no runner: no self-test; the digests are the
        // host toolchain's own
        judge: { toolchain: SPEC2.leanToolchain, comparatorExitCode: 0, selfTest: { passed: false, probes: [] }, tools: toolDigests(toolchainDir(environment)) },
        kernels: ["lean"],
        bundle: { formatVersion: 1, digest: expect.stringMatching(/^[0-9a-f]{64}$/u) },
        challengeExportSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        solutionExportSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
      expect(Object.keys(certificate)).toEqual(["judge", "kernels", "bundle", "challengeExportSha256", "solutionExportSha256", "challenge"]);
      expect(certificate.challenge).toBe(
        fs.readFileSync(path.join(jobDir, "certify", "project", "Challenge.lean"), "utf8"),
      );
      expect(certificate.challenge).toContain("import Lax38\n");
      expect(certificate.challenge).toContain("theorem Cert.Lax38Proofs.hasSucc : _root_.Lax38.Order.HasSucc := sorry");
      expect(certificate.challenge).toContain("theorem Cert.Lax38Proofs.refl_of_hasSucc.{«u»}\n    (h₁ : _root_.Lax38.Order.HasSucc)\n    : _root_.Lax38.Order.Refl.{«u»} := sorry");
      // the keyword names, as Lean's escaped printer reported them bare and
      // the generator quoted them — and Lean elaborated and the comparator
      // accepted them, since the whole build passed
      expect(certificate.challenge).toContain("theorem Cert.Lax38Proofs.reflexive?.{«fun»}\n    (h₁ : _root_.Lax38.Order.HasSucc)\n    : _root_.Lax38.Order.«at».{«fun»} := sorry");
      // a binder kind is not part of the edge: the implicit hypothesis is an
      // explicit one in the Challenge, and the Solution applies the proof with `@`
      expect(certificate.challenge).toContain("theorem Cert.Lax38Proofs.refl_of_implicit.{«u»}\n    (h₁ : _root_.Lax38.Order.HasSucc)\n    : _root_.Lax38.Order.Refl.{«u»} := sorry");
      expect(certificate.challenge).not.toContain("Lax38Proofs.hasSucc h");
      console.log(`[certify timing] lax-38 whole build incl. certification: ${Math.round(performance.now() - started)} ms`);
      // the bundle sealed what ran, and the exports' digests are the files'
      const tar = fs.readFileSync(path.join(jobDir, "certify", "certificate.tar"));
      expect(createHash("sha256").update(tar).digest("hex")).toBe(certificate.bundle.digest);
      const members = readBundle(tar);
      expect([...members.keys()]).toEqual(["Challenge.lean", "Solution.lean", "comparator.json", "lake-manifest.json", "lakefile.toml"]);
      expect(members.get("lakefile.toml")).toContain('path = "packages/Lax38Proofs"');
      expect(members.get("Solution.lean")).toContain("@_root_.Lax38Proofs.reflexive?.{«fun»} h₁");
      expect(members.get("Solution.lean")).toContain("@_root_.Lax38Proofs.refl_of_implicit.{«u»} h₁");
      expect(createHash("sha256").update(fs.readFileSync(path.join(jobDir, "certify", "challenge.export"))).digest("hex"))
        .toBe(certificate.challengeExportSha256);
      expect(createHash("sha256").update(fs.readFileSync(path.join(jobDir, "certify", "solution.export"))).digest("hex"))
        .toBe(certificate.solutionExportSha256);
      expect(certificate.solutionExportSha256).not.toBe(certificate.challengeExportSha256);
      // what the local build-output.json would store: the record's shape
      const stored = recordedBuildOutput(out) as Record<string, any>;
      expect(stored.proofs[0]).not.toHaveProperty("conclusion");
      expect(stored.capture).not.toHaveProperty("leanToolchain");
      expect(stored.capture).not.toHaveProperty("files");
      expect(stored.certificate.challenge).toBe(certificate.challenge);
      // the capture summary and the `references` layer, written beside the capture root
      expect(stored.capture.fileCount).toBe(out.capture.files!.length);
      const referencesTar = fs.readFileSync(path.join(jobDir, "references.tar"));
      expect(createHash("sha256").update(referencesTar).digest("hex")).toBe(stored.capture.references.digest);
      expect(referencesTar.length).toBe(stored.capture.references.bytes);
      // in byte order of the member names (seal.ts), never the walk's locale order
      const referenceMembers = [...readBundle(referencesTar).keys()];
      expect(referenceMembers).toEqual(["./concepts/lib/Lax38.ilean", "./concepts/lib/Lax38/Order.ilean", "./concepts/package/Lax38.lean", "./concepts/package/Lax38/Order.lean"]);
      expect(readBundle(referencesTar).get("./concepts/package/Lax38/Order.lean")).toBe(out.concepts[0]!.sourceText);
      expect(out.inputs.manifest.specVersion).toBe("2");
      expect(out.concepts).toHaveLength(1);
      expect(out.concepts[0]!.mathlibImports).toEqual([]);
      expect(out.concepts[0]!.statements).toEqual([
        // in id order, the locale's (emit.ts sorts)
        {
          id: "Lax38.Order.at",
          levelParams: ["fun"],
          signature: "«at».{«fun»} : Prop",
          body: "∀ (α : Sort «fun») (a : α), Eq a a",
          doc: "a keyword name, over a keyword universe: Lean prints both bare",
          startLine: 22,
          endLine: 23,
        },
        {
          id: "Lax38.Order.HasSucc",
          levelParams: [],
          signature: "HasSucc : Prop",
          body: "∀ (n : Nat), Exists fun m => instLTNat.lt n m",
          doc: "every natural has a strict successor",
          startLine: 13,
          endLine: 14,
        },
        {
          id: "Lax38.Order.Refl",
          levelParams: ["u"],
          signature: "Refl.{u} : Prop",
          body: "∀ (α : Sort u) (a : α), Eq a a",
          doc: "reflexivity, universe-polymorphic",
          startLine: 16,
          endLine: 17,
        },
      ]);
      expect(out.proofs).toEqual([
        {
          id: "Lax38Proofs.hasSucc",
          path: "proofs/Lax38Proofs/Basic.lean",
          levelParams: [],
          telescope: { hypotheses: [], conclusion: { statement: "Lax38.Order.HasSucc", levels: [] } },
          conclusion: "Lax38.Order.HasSucc",
          assumptions: [],
          description: "unconditional",
        },
        {
          id: "Lax38Proofs.refl_of_hasSucc",
          path: "proofs/Lax38Proofs/Basic.lean",
          levelParams: ["u"],
          telescope: {
            hypotheses: [{ statement: "Lax38.Order.HasSucc", levels: [] }],
            conclusion: { statement: "Lax38.Order.Refl", levels: ["u"] },
          },
          conclusion: "Lax38.Order.Refl",
          assumptions: ["Lax38.Order.HasSucc"],
          description: "conditional, universe-polymorphic",
          sections: [{ title: "Strategy", markdown: "Ignore the hypothesis." }],
        },
        {
          id: "Lax38Proofs.refl_of_implicit",
          path: "proofs/Lax38Proofs/Basic.lean",
          levelParams: ["u"],
          telescope: {
            hypotheses: [{ statement: "Lax38.Order.HasSucc", levels: [] }],
            conclusion: { statement: "Lax38.Order.Refl", levels: ["u"] },
          },
          conclusion: "Lax38.Order.Refl",
          assumptions: ["Lax38.Order.HasSucc"],
          description: "an implicit hypothesis: the certificate still states it explicitly",
        },
        {
          id: "Lax38Proofs.reflexive?",
          path: "proofs/Lax38Proofs/Basic.lean",
          levelParams: ["fun"],
          telescope: {
            hypotheses: [{ statement: "Lax38.Order.HasSucc", levels: [] }],
            conclusion: { statement: "Lax38.Order.at", levels: ["fun"] },
          },
          conclusion: "Lax38.Order.at",
          assumptions: ["Lax38.Order.HasSucc"],
          description: "keywords and a `?`: the proof, its universe, the statement",
        },
      ]);
      // and the entries carry their keys in the documented order; the CLI
      // serialises the record's shape, which drops the two derived keys
      expect(Object.keys(out.proofs[1]!)).toEqual(["id", "path", "levelParams", "telescope", "conclusion", "assumptions", "description", "sections"]);
      expect(Object.keys(stored.proofs[1])).toEqual(["id", "path", "levelParams", "telescope", "description", "sections"]);
      expect(Object.keys(out.concepts[0]!.statements[1]!)).toEqual(["id", "levelParams", "signature", "body", "doc", "startLine", "endLine"]);
    });
  }, 600_000);

  // The negatives that must fail *in the comparator*: the real
  // `lake comparator` over the project the lax-38 run left behind, each
  // Solution hand-edited one way, each verdict read by the one parser the
  // phase uses. A sorry smuggled through a helper never gets this far — the
  // inspector's axiom walk (phases/inspect-spec2.ts) refuses it in Inspect,
  // which the last case shows — so the comparator's own refusals are driven
  // directly, exactly as the plan asks: "each asserting the phase so a
  // fixture that dies in elaboration is noticed".
  it("refuses, in the comparator, a sorry, a weakened conclusion, an extra hypothesis, a definition as target, and a Solution that does not elaborate", async () => {
    await withTestEnvironmentsAsync([SPEC2], async () => {
      const environment = environmentById(SPEC2.id)!;
      expect(lax38, "the lax-38 build above must have run").toBeDefined();
      const project = path.join(lax38!.jobDir, "certify", "project");
      const exportPath = path.join(lax38!.jobDir, "certify", "challenge.export");
      const solution = fs.readFileSync(path.join(project, "Solution.lean"), "utf8");
      const judge = async (edited: string, label: string) => {
        fs.writeFileSync(path.join(project, "Solution.lean"), edited);
        const started = performance.now();
        const result = await run(
          lakeBinary(environment),
          ["comparator", "--config", "comparator.json", "--challenge-from-export", exportPath, "--inadvisably-no-sandbox"],
          project,
          { env: { LAKE_ARTIFACT_CACHE: "false", LEAN_NUM_THREADS: "2", PATH: lakePathEnv(environment) } },
        );
        console.log(`[certify timing] comparator (${label}): ${Math.round(performance.now() - started)} ms, exit ${result.code}`);
        return interpretComparatorRun(result);
      };
      try {
        expect(await judge(solution, "unchanged")).toEqual({ kind: "certified" });
        const hasSucc = "theorem Cert.Lax38Proofs.hasSucc : _root_.Lax38.Order.HasSucc := @_root_.Lax38Proofs.hasSucc";
        expect(solution).toContain(hasSucc);
        expect(await judge(solution.replace(hasSucc, "theorem Cert.Lax38Proofs.hasSucc : _root_.Lax38.Order.HasSucc := sorry"), "sorry"))
          .toMatchObject({ kind: "violation", rule: "illegal-axiom", message: expect.stringContaining("sorryAx") });
        expect(await judge(solution.replace(hasSucc, "theorem Cert.Lax38Proofs.hasSucc : True := trivial"), "weakened conclusion"))
          .toMatchObject({ kind: "violation", rule: "statement-mismatch", message: expect.stringContaining("Cert.Lax38Proofs.hasSucc") });
        expect(await judge(solution.replace(hasSucc, "theorem Cert.Lax38Proofs.hasSucc (h : _root_.Lax38.Order.HasSucc) : _root_.Lax38.Order.HasSucc := h"), "extra hypothesis"))
          .toMatchObject({ kind: "violation", rule: "statement-mismatch" });
        expect(await judge(solution.replace(hasSucc, "def Cert.Lax38Proofs.hasSucc : _root_.Lax38.Order.HasSucc := @_root_.Lax38Proofs.hasSucc"), "definition as target"))
          .toMatchObject({ kind: "violation", rule: "not-a-theorem" });
        const broken = await judge(solution.replace("@_root_.Lax38Proofs.hasSucc", "@_root_.Lax38Proofs.noSuchProof"), "does not elaborate");
        expect(broken).toMatchObject({ kind: "violation", rule: "solution-build" });
        expect((broken as { message: string }).message).toContain("did not elaborate");
        expect((broken as { message: string }).message).toContain("noSuchProof");
      } finally {
        fs.writeFileSync(path.join(project, "Solution.lean"), solution);
      }

      // and the one the walk catches first: a proof whose body rests on a
      // helper's sorry fails in Inspect, before any certificate exists
      const root = makeHostSubmission(
        "lax-43",
        {
          "concepts/Lax43.lean": "import Lax43.Claim\n",
          "concepts/Lax43/Claim.lean": `import LaxCore

/-!
---
title: A claim
type: theorem
---
One statement.
-/

namespace Lax43.Claim

@[lax_statement] def Holds : Prop := 0 = 0

end Lax43.Claim
`,
          "proofs/Lax43Proofs.lean": "import Lax43Proofs.Basic\n",
          "proofs/Lax43Proofs/Basic.lean": `import Lax43.Claim

namespace Lax43Proofs

theorem helper : 0 = 0 := sorry

theorem holds : Lax43.Claim.Holds := helper

end Lax43Proofs
`,
        },
        undefined,
        { environment },
      );
      const report = await buildOnHost(root, { id: "lax-43" });
      expect(report.ok).toBe(false);
      expect([...new Set(report.violations.map((violation) => violation.phase))]).toEqual(["inspect"]);
      expect(messages(report)).toContain("depends on axiom sorryAx");
      expect(report.buildOutput).toBeUndefined();
    });
  }, 600_000);

  // The archive's own layout, rehearsed without docker: the submission's
  // captures staged as Lake path dependencies (certify/project.ts
  // stageOwnPackage), the two run projects with path-entry manifests and
  // warm-store overrides, the judge's project (the bundle verbatim) with its
  // read-only shim, and the in-container tool (sandbox/tools/run-certify.mjs)
  // driven three times with host paths in place of the mount points —
  // `lake build Challenge` plus `leanexport` over a composed LEAN_PATH, the
  // same for `Solution`, then `lake comparator` over both exports with the
  // project and the shim directory made read-only for the run.
  it("rehearses the three-container layout over the staged captures with the real tool script", async () => {
    await withTestEnvironmentsAsync([SPEC2], async () => {
      const environment = environmentById(SPEC2.id)!;
      expect(lax38).toBeDefined();
      const warm = fs.realpathSync(warmDir(environment, sharedWarmBase()));
      const warmPackages = readWarmManifestPackages(warm);
      const captureRoot = path.join(lax38!.jobDir, "capture");
      const record: CertifyRecord = {
        proofs: lax38!.report.buildOutput!.proofs,
        ownConcepts: "Lax38",
        ownProofs: "Lax38Proofs",
        source: lax38!.report.request.source,
        environment,
        resolution: { concepts: [], proofs: [], all: [] },
        warmPackages,
      };
      const plan = planCertificate(record)!;
      const root = tmpDir("lax-layout-");
      const tool = path.resolve("src/submission-validation/sandbox/tools/run-certify.mjs");
      const toolchainBin = toolchainBinDir(environment);
      const own = path.join(root, "own");
      const concepts = stageOwnPackage(captureRoot, "concepts", own, (tree) => path.join(captureRoot, "concepts", tree));
      const proofs = stageOwnPackage(captureRoot, "proofs", own, (tree) => path.join(captureRoot, "proofs", tree));
      expect(fs.readlinkSync(path.join(concepts.packageDir, ".lake", "build", "lib", "lean"))).toBe(path.join(captureRoot, "concepts", "lib"));
      const gitSources = (name: string) => plan.gitSources.get(name)!;
      const runTool = async (planFile: string, label: string) => {
        const started = performance.now();
        const result = await run(process.execPath, [tool, planFile], root, {
          env: { LEAN_NUM_THREADS: "2", PATH: lakePathEnv(environment) },
          maxOutputBytes: 1024 * 1024,
        });
        console.log(`[certify timing] layout rehearsal ${label}: ${Math.round(performance.now() - started)} ms, exit ${result.code}`);
        return result;
      };

      // A
      const challengeDir = path.join(root, "challenge");
      const challengeProject = path.join(challengeDir, "project");
      writeRunProject(challengeProject, path.join(challengeDir, "build", ".lake"), challengeProjectFiles(plan, record, gitSources), {
        warm: warmPackages,
        deps: [{ name: "Lax38", dir: concepts.packageDir }],
      });
      seedOverrides(warm, path.join(challengeDir, "build"));
      // the project's `.lake` is a separate directory the container mounts
      // over the empty one; on the host, link it into place
      fs.rmdirSync(path.join(challengeProject, ".lake"));
      fs.symlinkSync(path.join(challengeDir, "build", ".lake"), path.join(challengeProject, ".lake"));
      const exportPath = path.join(challengeDir, "challenge.export");
      // A1: the build, as the first container runs it
      const planA1 = path.join(challengeDir, "build-plan.json");
      fs.writeFileSync(planA1, JSON.stringify({ tool: "build", project: challengeProject, module: "Challenge", toolchainBin, home: path.join(root, "home") }));
      const builtA = await runTool(planA1, "A1 (build)");
      expect(builtA.output, builtA.output).not.toContain("error:");
      expect(builtA.code).toBe(0);
      expect(fs.existsSync(path.join(challengeDir, "build", ".lake", "build", "lib", "lean", "Challenge.olean"))).toBe(true);
      // A2: the export and the inspection over the build tree, as the
      // second container runs them — read-only there; here the build dir
      // is simply not written to again
      const planA = path.join(challengeDir, "plan.json");
      fs.writeFileSync(planA, JSON.stringify({
        tool: "export",
        project: challengeProject,
        module: "Challenge",
        targets: plan.exportTargets,
        leanPath: [projectLibDir(challengeProject), concepts.libDir, ...warmLibDirs(warmPackages, warm)],
        output: exportPath,
        toolchainBin,
        home: path.join(root, "home"),
        inspect: { report: path.join(challengeDir, "challenge-report.json") },
        inspector: await inspectorBinary(environment, {}, SHARED_TOOLS),
      }));
      const built = await runTool(planA, "A2 (export + inspect)");
      expect(built.output, built.output).not.toContain("error:");
      expect(built.code).toBe(0);
      expect(built.output).not.toContain("Building");
      expect(fs.statSync(exportPath).size).toBeGreaterThan(1000);
      // the Challenge held to the telescope: the real inspector's reading of
      // the real build states exactly the record's edges
      const challengeReport = parseInspectorReport(JSON.parse(fs.readFileSync(path.join(challengeDir, "challenge-report.json"), "utf8")) as unknown, 2);
      expect(challengeReport.declarations.filter((declaration) => declaration.name.startsWith("Cert.")).map((declaration) => declaration.name).sort())
        .toEqual(record.proofs.map((proof) => `Cert.${proof.id}`).sort());
      expect(checkChallengeReport(challengeReport, record.proofs)).toBeUndefined();
      expect(fs.readFileSync(exportPath, "utf8").startsWith('{"meta"')).toBe(true);
      // the export (lean4export 3.1.0 NDJSON, names hash-consed per
      // component) carries the certificate theorems as `thm` records
      const exported = fs.readFileSync(exportPath, "utf8");
      expect(exported).toContain('"str":"Cert"');
      expect(exported).toContain('"str":"hasSucc"');
      expect(exported).toContain('"str":"refl_of_hasSucc"');
      expect(exported).toContain('"str":"reflexive?"');
      expect(exported).toMatch(/"thm":/u);

      // B: the Solution, built and exported by the same rule
      const solutionDir = path.join(root, "solution");
      const solutionProject = path.join(solutionDir, "project");
      writeRunProject(solutionProject, path.join(solutionDir, "build", ".lake"), solutionProjectFiles(plan, record, gitSources), {
        warm: warmPackages,
        deps: [
          { name: "Lax38", dir: concepts.packageDir },
          { name: "Lax38Proofs", dir: proofs.packageDir },
        ],
      });
      seedOverrides(warm, path.join(solutionDir, "build"));
      fs.rmdirSync(path.join(solutionProject, ".lake"));
      fs.symlinkSync(path.join(solutionDir, "build", ".lake"), path.join(solutionProject, ".lake"));
      const solutionExport = path.join(solutionDir, "solution.export");
      const planB1 = path.join(solutionDir, "build-plan.json");
      fs.writeFileSync(planB1, JSON.stringify({ tool: "build", project: solutionProject, module: "Solution", toolchainBin, home: path.join(root, "home") }));
      const builtB1 = await runTool(planB1, "B1 (build)");
      expect(builtB1.output, builtB1.output).not.toContain("error:");
      expect(builtB1.code).toBe(0);
      const planB = path.join(solutionDir, "plan.json");
      fs.writeFileSync(planB, JSON.stringify({
        tool: "export",
        project: solutionProject,
        module: "Solution",
        targets: plan.exportTargets,
        leanPath: [projectLibDir(solutionProject), concepts.libDir, proofs.libDir, ...warmLibDirs(warmPackages, warm)],
        output: solutionExport,
        toolchainBin,
        home: path.join(root, "home"),
      }));
      const builtB = await runTool(planB, "B2 (export)");
      expect(builtB.output, builtB.output).not.toContain("error:");
      expect(builtB.code).toBe(0);
      expect(fs.readFileSync(solutionExport, "utf8")).toContain('"str":"Cert"');
      // the lakefile B ran kept the bundle's git requires; the manifest's
      // path entries did the redirecting, as a submission build's do
      expect(fs.readFileSync(path.join(solutionProject, "lakefile.toml"), "utf8")).toContain(`git = "${lax38!.report.request.source.repository}"`);
      // the capture root was never written to
      expect(fs.existsSync(path.join(captureRoot, "concepts", "package", ".lake"))).toBe(false);

      // C: the judge over the two exports, in the bundle's own project —
      // the project, the shim directory and both exports read-only for the
      // run, so a comparator that wrote anywhere but its temp dir would fail
      const judgeDir = path.join(root, "judge");
      const judge = writeJudgeProject(judgeDir, plan.bundle);
      expect(fs.readdirSync(judge.projectDir).sort()).toEqual(["Challenge.lean", "Solution.lean", "comparator.json", "lake-manifest.json", "lakefile.toml"]);
      expect(fs.readFileSync(path.join(judge.shimsDir, "git"), "utf8")).toBe(GIT_SHIM);
      fs.chmodSync(exportPath, 0o444);
      fs.chmodSync(solutionExport, 0o444);
      fs.chmodSync(judge.projectDir, 0o555);
      fs.chmodSync(judge.shimsDir, 0o555);
      const planC = path.join(judgeDir, "plan.json");
      const judgePlan = {
        tool: "comparator",
        project: judge.projectDir,
        config: "comparator.json",
        challengeExport: exportPath,
        solutionExport,
        shims: judge.shimsDir,
        paranoid: false,
        toolchainBin,
        home: path.join(root, "home"),
      };
      try {
        fs.writeFileSync(planC, JSON.stringify(judgePlan));
        const judged = await runTool(planC, "C (comparator over both exports)");
        expect(judged.output, judged.output).toContain("Your solution is okay!");
        // nothing was built or resolved: the comparator went straight to the comparison
        expect(judged.output).not.toContain("Building");
        expect(judged.output).not.toContain("Resolving");
        expect(interpretComparatorRun(judged)).toEqual({ kind: "certified" });
        expect(fs.readdirSync(judge.projectDir).sort()).toEqual(["Challenge.lean", "Solution.lean", "comparator.json", "lake-manifest.json", "lakefile.toml"]);
        // and the paranoid set runs through the same tool when asked
        fs.writeFileSync(planC, JSON.stringify({ ...judgePlan, paranoid: true }));
        const paranoid = await runTool(planC, "C (comparator --paranoid)");
        expect(paranoid.output, paranoid.output).toContain("Your solution is okay!");
        expect(paranoid.output).toContain("lean4lean kernel accepts the solution");
        // the git shim is what `which git` finds, and it refuses to run
        const probe = await run(path.join(judge.shimsDir, "git"), ["status"], root, {});
        expect(probe.code).toBe(1);
        expect(probe.output).toContain("git is not available inside the validation sandbox");
      } finally {
        fs.chmodSync(judge.projectDir, 0o755);
        fs.chmodSync(judge.shimsDir, 0o755);
      }
    });
  }, 600_000);

  // The judge self-test (certify/self-test.ts), rehearsed on the host with
  // the real tool script: the three core-only modules built and exported in
  // one export step, the Solution export forged by the host, and the real
  // comparator asked three times — accept, reject the mismatch, and let
  // Lean's kernel refuse the forgery. The confinement probe is the
  // container's and is not rehearsed here.
  it("rehearses the judge self-test with the real tool script: accept, mismatch, forged", async () => {
    await withTestEnvironmentsAsync([SPEC2], async () => {
      const environment = environmentById(SPEC2.id)!;
      const root = tmpDir("lax-self-test-");
      const tool = path.resolve("src/submission-validation/sandbox/tools/run-certify.mjs");
      const toolchainBin = toolchainBinDir(environment);
      const runTool = async (planFile: string, label: string) => {
        const started = performance.now();
        const result = await run(process.execPath, [tool, planFile], root, {
          env: { LEAN_NUM_THREADS: "2", PATH: lakePathEnv(environment) },
          maxOutputBytes: 1024 * 1024,
        });
        console.log(`[certify timing] self-test rehearsal ${label}: ${Math.round(performance.now() - started)} ms, exit ${result.code}`);
        return result;
      };
      const projectDir = path.join(root, "project");
      fs.mkdirSync(projectDir, { recursive: true });
      for (const [name, content] of Object.entries(selfTestProjectFiles())) fs.writeFileSync(path.join(projectDir, name), content);
      const started = performance.now();
      const built = await runTool(
        (() => { const f = path.join(root, "build-plan.json"); fs.writeFileSync(f, JSON.stringify({ tool: "build", project: projectDir, module: SELF_TEST_PACKAGE, toolchainBin, home: path.join(root, "home") })); return f; })(),
        "S1 (build)",
      );
      expect(built.output, built.output).not.toContain("error:");
      expect(built.code).toBe(0);
      const outDir = path.join(root, "out");
      fs.mkdirSync(outDir);
      const exports = Object.fromEntries((["challenge", "solution", "mismatch"] as const).map((side) => [side, path.join(outDir, `${side}.export`)])) as Record<"challenge" | "solution" | "mismatch", string>;
      const exportPlan = path.join(root, "export-plan.json");
      fs.writeFileSync(exportPlan, JSON.stringify({
        tool: "export",
        project: projectDir,
        targets: selfTestExportTargets(environment),
        leanPath: [projectLibDir(projectDir)],
        exports: [
          { module: SELF_TEST_MODULES.challenge, output: exports.challenge },
          { module: SELF_TEST_MODULES.solution, output: exports.solution },
          { module: SELF_TEST_MODULES.mismatch, output: exports.mismatch },
        ],
        toolchainBin,
        home: path.join(root, "home"),
      }));
      const exported = await runTool(exportPlan, "S2 (three exports)");
      expect(exported.output, exported.output).not.toContain("error:");
      expect(exported.code).toBe(0);
      for (const file of Object.values(exports)) expect(fs.statSync(file).size).toBeGreaterThan(1000);
      const forged = path.join(outDir, "forged.export");
      fs.writeFileSync(forged, forgeKernelRejection(fs.readFileSync(exports.solution, "utf8"), SELF_TEST_THEOREM));
      // the judge's project: the self-test's files and its comparator config
      const judgeProject = path.join(root, "judge", "project");
      const shims = path.join(root, "judge", "shims");
      fs.mkdirSync(judgeProject, { recursive: true });
      fs.mkdirSync(shims, { recursive: true });
      const files = selfTestProjectFiles();
      for (const name of ["lakefile.toml", "lake-manifest.json", `${SELF_TEST_MODULES.challenge}.lean`, `${SELF_TEST_MODULES.solution}.lean`]) fs.writeFileSync(path.join(judgeProject, name), files[name]!);
      fs.writeFileSync(path.join(judgeProject, "comparator.json"), selfTestComparatorConfig());
      fs.writeFileSync(path.join(shims, "git"), GIT_SHIM, { mode: 0o555 });
      const judge = async (label: string, solutionExport: string) => {
        const planFile = path.join(root, `judge-${label}.json`);
        fs.writeFileSync(planFile, JSON.stringify({
          tool: "comparator",
          project: judgeProject,
          config: "comparator.json",
          challengeExport: exports.challenge,
          solutionExport,
          shims,
          paranoid: false,
          toolchainBin,
          home: path.join(root, "home"),
        }));
        return interpretComparatorRun(await runTool(planFile, `S3-5 (${label})`));
      };
      expect(await judge("accept", exports.solution)).toEqual({ kind: "certified" });
      expect(await judge("mismatch", exports.mismatch)).toMatchObject({ kind: "violation", rule: "statement-mismatch" });
      expect(await judge("forged", forged)).toMatchObject({ kind: "violation", rule: "kernel-rejected" });
      console.log(`[certify timing] self-test rehearsal total: ${Math.round(performance.now() - started)} ms`);
    });
  }, 600_000);

  // Finding 6 of the stage-3 review: a nonstrict build's sibling concept
  // package is a local package source the certificate plan must accept — a
  // path require inside the generated project — so a proof that assumes a
  // sibling's statement reaches certification on the host.
  it("certifies, under --nonstrict, a proof over a sibling checkout's statement with a local plan", async () => {
    await withTestEnvironmentsAsync([SPEC2], async () => {
      const environment = environmentById(SPEC2.id)!;
      const base = tmpDir("lax-spec2-siblings-");
      const sibling = makeHostSubmission(
        "lax-44",
        {
          "concepts/Lax44.lean": "import Lax44.Claim\n",
          "concepts/Lax44/Claim.lean": `import LaxCore

/-!
---
title: A sibling's claim
type: theorem
---
One statement, in a draft beside the dependent.
-/

namespace Lax44.Claim

@[lax_statement] def Holds : Prop := ∀ n : Nat, n = n

end Lax44.Claim
`,
        },
        base,
        { environment },
      );
      const dependent = makeHostSubmission(
        "lax-45",
        {
          "concepts/Lax45.lean": "import Lax45.Chain\n",
          "concepts/Lax45/Chain.lean": `import LaxCore

/-!
---
title: Chain over a sibling
type: theorem
---
A statement proven from the sibling's.
-/

namespace Lax45.Chain

@[lax_statement] def Downstream : Prop := ∀ n : Nat, n = n

end Lax45.Chain
`,
          "proofs/Lax45Proofs.lean": "import Lax45Proofs.Basic\n",
          "proofs/Lax45Proofs/Basic.lean": `import Lax45.Chain
import Lax44.Claim

namespace Lax45Proofs

/-- the downstream statement, from the sibling's -/
theorem downstream (h : Lax44.Claim.Holds) : Lax45.Chain.Downstream := h

end Lax45Proofs
`,
        },
        base,
        { environment },
      );
      fs.appendFileSync(
        path.join(dependent, "proofs", "lakefile.toml"),
        '\n[[require]]\nname = "Lax44"\npath = "../../lax-44/concepts"\n',
      );
      const strict = await buildOnHost(dependent, { id: "lax-45" });
      expect(strict.ok).toBe(false);
      expect(strict.buildOutput).toBeUndefined();

      const jobDir = path.join(tmpDir("lax-45-job-"), "work");
      const report = await buildOnHost(dependent, { id: "lax-45", nonstrict: true, jobDir });
      expect(messages(report)).toBe("");
      expect(report.ok).toBe(true);
      expect(report.siblings).toEqual(["Lax44"]);
      const certificate = report.buildOutput!.certificate!;
      expect(certificate.challenge).toContain("import Lax44\nimport Lax45\n");
      expect(certificate.challenge).toContain(
        "theorem Cert.Lax45Proofs.downstream\n    (h₁ : _root_.Lax44.Claim.Holds)\n    : _root_.Lax45.Chain.Downstream := sorry",
      );
      // the local plan: the sibling is a path require of the generated
      // project, reached through a link at the sibling's own checkout
      const members = readBundle(fs.readFileSync(path.join(jobDir, "certify", "certificate.tar")));
      expect(members.get("lakefile.toml")).toContain('name = "Lax44"\npath = "packages/Lax44"');
      expect(members.get("lakefile.toml")).not.toContain("lax-44/concepts");
      expect(fs.readlinkSync(path.join(jobDir, "certify", "project", "packages", "Lax44")))
        .toBe(fs.realpathSync(path.join(sibling, "concepts")));
      // and the plan itself says it is local
      const plan = planCertificate({
        proofs: report.buildOutput!.proofs,
        ownConcepts: "Lax45",
        ownProofs: "Lax45Proofs",
        source: report.request.source,
        environment,
        resolution: { concepts: [], proofs: [], all: [] },
        warmPackages: [],
        local: { directConcepts: ["Lax44"], packages: [{ name: "Lax44", kind: "concepts", dir: path.join(sibling, "concepts") }] },
      })!;
      expect(plan.kind).toBe("local");
      expect(plan.referencedLocal).toEqual(["Lax44"]);
      expect(plan.gitSources.has("Lax44")).toBe(false);
      expect(() => planCertificate({
        proofs: report.buildOutput!.proofs,
        ownConcepts: "Lax45",
        ownProofs: "Lax45Proofs",
        source: report.request.source,
        environment,
        resolution: { concepts: [], proofs: [], all: [] },
        warmPackages: [],
      })).toThrow("does not require directly");
    });
  }, 600_000);

  it("certifies a cross-submission chain: a conditional proof over a registered dependency's statement", async () => {
    await withTestEnvironmentsAsync([SPEC2], async () => {
      const environment = environmentById(SPEC2.id)!;
      expect(lax38).toBeDefined();
      const ghcr = await startFakeGhcr();
      process.env.LAX_CAPTURE_REGISTRY_URL = ghcr.url;
      const rewrites: string[] = [];
      try {
        // lax-38 becomes a registered record whose repository the git
        // rewrite points at its checkout (cross-submission.test.ts)
        const index = Number(process.env.GIT_CONFIG_COUNT ?? "0");
        process.env[`GIT_CONFIG_KEY_${index}`] = `url.file://${lax38!.root}.insteadOf`;
        process.env[`GIT_CONFIG_VALUE_${index}`] = UPSTREAM_REPOSITORY;
        process.env.GIT_CONFIG_COUNT = String(index + 1);
        rewrites.push(`GIT_CONFIG_KEY_${index}`, `GIT_CONFIG_VALUE_${index}`);
        const upstream = await publishLocalCapture("lax-38", lax38!.root, UPSTREAM_REPOSITORY);
        // its record stores the spec-2 shape, certificate included
        const archive = archiveWith(upstream);
        const storedUpstream = JSON.parse(fs.readFileSync(path.join(archive.root, "lax-38", "build-output.json"), "utf8")) as Record<string, any>;
        expect(storedUpstream.capture).not.toHaveProperty("leanToolchain");
        expect(storedUpstream.capture).not.toHaveProperty("files");
        expect(storedUpstream.capture.references.registryBlob).toBe(`ghcr.io/${CAPTURES_REPOSITORY}@sha256:${storedUpstream.capture.references.digest}`);
        expect(ghcr.state.blobs.has(`sha256:${storedUpstream.capture.references.digest}`)).toBe(true);
        expect(storedUpstream.certificate.challenge).toBe(lax38!.report.buildOutput!.certificate!.challenge);

        const root = makeHostSubmission(
          "lax-41",
          {
            "concepts/Lax41.lean": "import Lax41.Chain\n",
            "concepts/Lax41/Chain.lean": `import LaxCore

/-!
---
title: Chain
type: theorem
---
A statement proven from lax-38's.
-/

namespace Lax41.Chain

@[lax_statement] def Downstream : Prop := ∀ n : Nat, ∃ m, n < m

end Lax41.Chain
`,
            "proofs/Lax41Proofs.lean": "import Lax41Proofs.Basic\n",
            "proofs/Lax41Proofs/Basic.lean": `import Lax41.Chain
import Lax38.Order

namespace Lax41Proofs

/-- the downstream statement, from the upstream one -/
theorem downstream (h : Lax38.Order.HasSucc) : Lax41.Chain.Downstream := h

end Lax41Proofs
`,
          },
          undefined,
          { environment },
        );
        fs.appendFileSync(
          path.join(root, "proofs", "lakefile.toml"),
          `\n[[require]]\nname = "Lax38"\ngit = "${UPSTREAM_REPOSITORY}"\nrev = "${upstream.source.commit}"\nsubDir = "concepts"\n`,
        );
        const jobDir = path.join(tmpDir("lax-41-job-"), "work");
        const started = performance.now();
        const report = await buildOnHost(root, { id: "lax-41", archive, jobDir });
        console.log(`[certify timing] lax-41 chain build incl. certification: ${Math.round(performance.now() - started)} ms`);
        expect(messages(report)).toBe("");
        expect(report.ok).toBe(true);
        const certificate = report.buildOutput!.certificate!;
        expect(certificate.challenge).toContain("import Lax38\nimport Lax41\n");
        expect(certificate.challenge).toContain(
          "theorem Cert.Lax41Proofs.downstream\n    (h₁ : _root_.Lax38.Order.HasSucc)\n    : _root_.Lax41.Chain.Downstream := sorry",
        );
        const members = readBundle(fs.readFileSync(path.join(jobDir, "certify", "certificate.tar")));
        expect(members.get("Solution.lean")).toContain("@_root_.Lax41Proofs.downstream h₁");
        expect(members.get("lakefile.toml")).toContain('path = "packages/Lax38"');
        // the dependency was reached where the proofs build cloned it
        expect(fs.readlinkSync(path.join(jobDir, "certify", "project", "packages", "Lax38")))
          .toBe(fs.realpathSync(path.join(root, "proofs", ".lake", "packages", "Lax38", "concepts")));
        lax41 = { root };
      } finally {
        delete process.env.LAX_CAPTURE_REGISTRY_URL;
        for (const key of rewrites) delete process.env[key];
        if (rewrites.length > 0) process.env.GIT_CONFIG_COUNT = String(Number(process.env.GIT_CONFIG_COUNT) - 1);
        if (process.env.GIT_CONFIG_COUNT === "0") delete process.env.GIT_CONFIG_COUNT;
        await ghcr.close();
      }
    });
  }, 600_000);

  // Stage 4: `lax certify` over the two records as a reader holds them —
  // lax-38 and lax-41 published to the fake registry and written into a
  // local archive copy — then the bundles judged by the real comparator.
  it("lax certify regenerates, fetches, and composes bundles the real comparator accepts", async () => {
    await withTestEnvironmentsAsync([SPEC2], async () => {
      const environment = environmentById(SPEC2.id)!;
      expect(lax38).toBeDefined();
      expect(lax41, "the chain test above must have run").toBeDefined();
      const ghcr = await startFakeGhcr();
      process.env.LAX_CAPTURE_REGISTRY_URL = ghcr.url;
      const home = process.env.LAX_HOME!;
      const database = path.join(home, "lax-database");
      const logged: string[] = [];
      const spies = [
        vi.spyOn(console, "log").mockImplementation((line: unknown) => { logged.push(String(line)); }),
        vi.spyOn(process.stderr, "write").mockImplementation((line: unknown) => { logged.push(String(line)); return true; }),
      ];
      ui.configure({ color: false });
      const configCount = process.env.GIT_CONFIG_COUNT;
      const configKeys = Object.keys(process.env).filter((key) => /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(key));
      try {
        rewriteUrl(UPSTREAM_REPOSITORY, lax38!.root);
        rewriteUrl(DOWNSTREAM_REPOSITORY, lax41!.root);
        // both records in the local copy, in the shape the publisher writes,
        // the certificate layer pushed and bound into each record
        const upstream = await publishLocalCapture("lax-38", lax38!.root, UPSTREAM_REPOSITORY);
        const downstream = await publishLocalCapture("lax-41", lax41!.root, DOWNSTREAM_REPOSITORY, archiveWith(upstream));
        expect(upstream.certificateBlob).toBeDefined();
        const archive = archiveWith(upstream, downstream);
        fs.mkdirSync(path.join(database, ".git"), { recursive: true });
        for (const id of ["lax-38", "lax-41"]) fs.cpSync(path.join(archive.root, id), path.join(database, id), { recursive: true });
        const bundleIn = (directory: string): Record<BundleFile, string> =>
          Object.fromEntries(BUNDLE_FILES.map((name) => [name, fs.readFileSync(path.join(directory, name), "utf8")])) as Record<BundleFile, string>;
        const out = tmpDir("lax-certify-");

        // the record's bundle, regenerated: the same bytes the local build
        // sealed, except that the lakefile and manifest now carry the
        // records' git sources in place of this machine's paths
        const regenerated = path.join(out, "lax-41");
        expect(await certify("lax-41", { out: regenerated })).toBe(0);
        const files = bundleIn(regenerated);
        expect(files["Challenge.lean"]).toBe(downstream.report.buildOutput!.certificate!.challenge);
        expect(files["lakefile.toml"]).toContain(`name = "Lax38"\ngit = "${UPSTREAM_REPOSITORY}"\nrev = "${upstream.source.commit}"\nsubDir = "concepts"`);
        expect(files["lakefile.toml"]).toContain(`name = "Lax41Proofs"\ngit = "${DOWNSTREAM_REPOSITORY}"`);
        expect(fs.readFileSync(path.join(regenerated, "lean-toolchain"), "utf8")).toBe(`${SPEC2.leanToolchain}\n`);
        expect(logged.join("\n")).toContain("Regenerated the bundle");
        expect(logged.join("\n")).toContain("lake comparator --config comparator.json");

        // the stored bundle, fetched by digest from the registry
        const fetched = path.join(out, "lax-38-fetched");
        expect(await certify("lax-38", { out: fetched, fetch: true })).toBe(0);
        const storedTar = fs.readFileSync(path.join(lax38!.jobDir, "certify", "certificate.tar"));
        expect(readBundle(storedTar).get("Challenge.lean")).toBe(fs.readFileSync(path.join(fetched, "Challenge.lean"), "utf8"));
        expect(sealBundle(bundleIn(fetched)).digest).toBe(upstream.report.buildOutput!.certificate!.bundle.digest);

        // the relative certificate: Downstream outright, through lax-38's proof
        const composed = path.join(out, "downstream");
        expect(await certify("Lax41.Chain.Downstream", { out: composed })).toBe(0);
        const relative = bundleIn(composed);
        expect(relative["Challenge.lean"]).toContain("import Lax41\n\ntheorem Cert.Lax41.Chain.Downstream : _root_.Lax41.Chain.Downstream := sorry\n");
        expect(relative["Solution.lean"]).toContain(
          "import Lax38Proofs\nimport Lax41Proofs\n\n" +
            "theorem Cert.Lax41.Chain.Downstream : _root_.Lax41.Chain.Downstream := " +
            "@_root_.Lax41Proofs.downstream (@_root_.Lax38Proofs.hasSucc)\n",
        );
        // and relative to lax-38's statement: the per-submit edge under the statement's name
        const hypothetical = path.join(out, "downstream-relative");
        expect(await certify("Lax41.Chain.Downstream", { out: hypothetical, relativeTo: ["Lax38.Order.HasSucc"] })).toBe(0);
        expect(bundleIn(hypothetical)["Solution.lean"]).toContain(
          "theorem Cert.Lax41.Chain.Downstream\n    (h₁ : _root_.Lax38.Order.HasSucc)\n    : _root_.Lax41.Chain.Downstream := @_root_.Lax41Proofs.downstream h₁\n",
        );

        // ── the real comparator over the written bundles ──────────────
        // Each folder is the five files a reader has: lake resolves the git
        // requires (the fixture repositories, through the url rewrites),
        // builds mathlib, LaxCore and the packages from source, and judges.
        // First without the sandbox — the fixture repositories are local
        // paths bubblewrap may not see — labelled as such; then the CLI's
        // own `--run`, sandboxed, over the materialised folder.
        const lake = lakeBinary(environment);
        const judgeUnsandboxed = async (directory: string, label: string) => {
          const started = performance.now();
          const result = await run(lake, ["comparator", "--config", "comparator.json", "--inadvisably-no-sandbox"], directory, {
            env: { LAKE_ARTIFACT_CACHE: "false", LEAN_NUM_THREADS: "2", PATH: lakePathEnv(environment) },
          });
          console.info(`[certify timing] lax certify bundle ${label}, comparator WITHOUT sandbox (fixture repositories are local paths): ${Math.round(performance.now() - started)} ms, exit ${result.code}`);
          expect(result.output, result.output).toContain("Your solution is okay!");
          expect(interpretComparatorRun(result)).toEqual({ kind: "certified" });
        };
        await judgeUnsandboxed(regenerated, "lax-41 (regenerated)");
        await judgeUnsandboxed(composed, "Lax41.Chain.Downstream (composed)");
        await judgeUnsandboxed(hypothetical, "Lax41.Chain.Downstream relative to HasSucc");

        // the sandboxed rerun through the CLI, where bubblewrap can create
        // a user namespace (the spike's host sandbox); elsewhere it is
        // reported and skipped, never faked
        let sandbox = false;
        try {
          execFileSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-user", "--die-with-parent", "--", "/bin/true"], { stdio: "ignore" });
          sandbox = true;
        } catch {
          console.info("[certify] bubblewrap cannot create a user namespace here; the sandboxed `lax certify --run` is not exercised");
        }
        if (sandbox) {
          const started = performance.now();
          logged.length = 0;
          const code = await certify("Lax41.Chain.Downstream", { out: composed, run: true });
          console.info(`[certify timing] lax certify --run (sandboxed, folder materialised): ${Math.round(performance.now() - started)} ms, exit ${code}\n${logged.join("\n")}`);
          expect(code).toBe(0);
          expect(logged.join("\n")).toContain("Lax41.Chain.Downstream is certified: lake comparator --config comparator.json accepted the Solution.");
        }
      } finally {
        for (const spy of spies) spy.mockRestore();
        delete process.env.LAX_CAPTURE_REGISTRY_URL;
        for (const key of Object.keys(process.env).filter((candidate) => /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(candidate) && !configKeys.includes(candidate))) delete process.env[key];
        if (configCount === undefined) delete process.env.GIT_CONFIG_COUNT;
        else process.env.GIT_CONFIG_COUNT = configCount;
        await ghcr.close();
      }
    });
  }, 900_000);

  it("builds the spec-2 scaffold `lax init --env` writes, with its edge", async () => {
    await withTestEnvironmentsAsync([SPEC2], async () => {
      const environment = environmentById(SPEC2.id)!;
      const root = tmpDir("lax-scaffold-");
      scaffoldSubmission(root, "lax-123457", "Scaffold", environment);
      const report = await buildOnHost(root, { id: "lax-123457" });
      expect(messages(report)).toBe("");
      expect(report.ok).toBe(true);
      const out = report.buildOutput!;
      expect(out.concepts[0]!.statements.map((statement) => statement.id)).toEqual(["Lax123457.Basic.AddZero", "Lax123457.Basic.ZeroAddZero"]);
      expect(out.proofs.map((proof) => [proof.id, proof.assumptions, proof.conclusion])).toEqual([
        ["Lax123457Proofs.addZero", [], "Lax123457.Basic.AddZero"],
        ["Lax123457Proofs.zeroAddZero", ["Lax123457.Basic.AddZero"], "Lax123457.Basic.ZeroAddZero"],
      ]);
      expect(out.certificate!.challenge).toContain("theorem Cert.Lax123457Proofs.zeroAddZero\n    (h₁ : _root_.Lax123457.Basic.AddZero)\n    : _root_.Lax123457.Basic.ZeroAddZero := sorry");
      // the recipe in the comment is live Lean: uncommented, it is one more edge
      const proofs = path.join(root, "proofs", "Lax123457Proofs", "Basic.lean");
      const source = fs.readFileSync(proofs, "utf8");
      const recipe = /\/-\nSeveral proofs sharing hypotheses[\s\S]*?\n\n([\s\S]*?)\n-\/\n/u.exec(source);
      expect(recipe).not.toBeNull();
      fs.writeFileSync(proofs, source.replace(recipe![0], recipe![1]!.split("\n").map((line) => line.replace(/^ {2}/u, "")).join("\n") + "\n\n"));
      const again = await buildOnHost(root, { id: "lax-123457" });
      expect(messages(again)).toBe("");
      expect(again.buildOutput!.proofs.map((proof) => [proof.id, proof.assumptions])).toContainEqual(["Lax123457Proofs.zeroAddZero'", ["Lax123457.Basic.AddZero"]]);
    });
  }, 600_000);

  it("fails in Inspect on a private proof-shaped theorem, a concrete universe level, an initializer, and global syntax", async () => {
    await withTestEnvironmentsAsync([SPEC2], async () => {
      const environment = environmentById(SPEC2.id)!;
      const root = makeHostSubmission(
        "lax-39",
        {
          "concepts/Lax39.lean": "import Lax39.Order\n",
          "concepts/Lax39/Order.lean": `import LaxCore

/-!
---
title: Order facts
type: theorem
---
One polymorphic statement.
-/

namespace Lax39.Order

@[lax_statement] def Refl.{u} : Prop := ∀ (α : Sort u) (a : α), a = a

end Lax39.Order
`,
          "proofs/Lax39Proofs.lean": "import Lax39Proofs.Basic\n",
          "proofs/Lax39Proofs/Basic.lean": `import Lax39.Order

namespace Lax39Proofs

private theorem hidden.{u} : Lax39.Order.Refl.{u} := fun _ _ => rfl

theorem special : Lax39.Order.Refl.{0} := fun _ _ => rfl

-- global syntax rewrites every importer (namespace review, E1); an
-- initializer registers a name-keyed global registry (F1)
syntax "lax_rfl" : tactic
macro_rules | \`(tactic| lax_rfl) => \`(tactic| rfl)
initialize do pure ()

-- scoped syntax leaves no global entry
scoped notation "⊗⊗" => Nat.mul

end Lax39Proofs
`,
        },
        undefined,
        { environment },
      );
      const report = await buildOnHost(root, { id: "lax-39" });
      expect(report.ok).toBe(false);
      expect(rules(report), messages(report)).toEqual(new Set(["proof", "initialize", "global-syntax"]));
      expect(report.violations.every((violation) => violation.phase === "inspect")).toBe(true);
      expect(messages(report)).toContain(
        "proof module Lax39Proofs.Basic registers global syntax (a parser or token, a macro); a record declares every `syntax`, `notation`, `macro`, `macro_rules`, and `elab` as `scoped` or `local`",
      );
      expect(messages(report)).toContain("proof module Lax39Proofs.Basic declares an initializer (");
      for (const violation of report.violations)
        expect(violation.intent).toBe(violation.rule === "proof" ? "translation" : "standards");
      expect(messages(report)).toContain(
        "private theorem Lax39Proofs.hidden has the shape of a proof ({} → Lax39.Order.Refl); the archive's certificate must name it from another module — drop `private`",
      );
      expect(messages(report)).toContain(
        "theorem Lax39Proofs.special instantiates Lax39.Order.Refl at universe level `0`; every level argument of a statement in a proof's type must be a universe parameter of the proof",
      );
      expect(report.buildOutput).toBeUndefined();
    });
  }, 600_000);

  it("a tagged private def never reaches Inspect: LaxCore's hook refuses it at compile time", async () => {
    await withTestEnvironmentsAsync([SPEC2], async () => {
      const environment = environmentById(SPEC2.id)!;
      const root = makeHostSubmission(
        "lax-40",
        {
          "concepts/Lax40.lean": "import Lax40.Hidden\n",
          "concepts/Lax40/Hidden.lean": `import LaxCore

/-!
---
title: A hidden statement
type: theorem
---
The hook's private rule.
-/

namespace Lax40.Hidden

@[lax_statement] private def Secret : Prop := True

end Lax40.Hidden
`,
        },
        undefined,
        { environment },
      );
      const report = await buildOnHost(root, { id: "lax-40" });
      expect(report.ok).toBe(false);
      expect(report.violations.map((violation) => violation.phase)).toEqual(["compile-concepts"]);
      expect(messages(report)).toContain(
        "invalid `@[lax_statement]` on `Lax40.Hidden.Secret`: a statement cannot be `private`",
      );
    });
  }, 600_000);

  it("refuses a spec-1 manifest in the spec-2 row", async () => {
    await withTestEnvironmentsAsync([SPEC2], async () => {
      const environment = environmentById(SPEC2.id)!;
      const root = makeHostSubmission("lax-37", {}, undefined, { environment });
      const manifestPath = path.join(root, "manifest.yaml");
      fs.writeFileSync(manifestPath, fs.readFileSync(manifestPath, "utf8").replace('specVersion: "2"', 'specVersion: "1"'));
      const report = await buildOnHost(root, { id: "lax-37" });
      expect(report.ok).toBe(false);
      expect(messages(report)).toContain('specVersion must be "2" in environment v4.35.0');
    });
  });
});
