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
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { CAPTURES_REPOSITORY } from "../../src/shared/constants.js";
import { readBundle } from "../../src/submission-validation/certify/bundle.js";
import {
  challengeProjectFiles,
  planCertificate,
  projectLibDir,
  solutionProjectFiles,
  stageOwnPackage,
  warmLibDirs,
  writeRunProject,
  type CertifyRecord,
} from "../../src/submission-validation/certify/project.js";
import { interpretComparatorRun } from "../../src/submission-validation/certify/verdict.js";
import type { HostValidationReport } from "../../src/submission-validation/host/pipeline.js";
import {
  environment as environmentById,
  epoch,
  librariesOf,
} from "../../src/submission-validation/environments.js";
import { lakeBinary, lakePathEnv, toolchainBinDir, toolchainDir } from "../../src/submission-validation/host/leanenv.js";
import { run } from "../../src/submission-validation/host/proc.js";
import { readWarmManifestPackages, seedOverrides, warmDir, warmReady } from "../../src/submission-validation/host/warmstore.js";
import { recordedBuildOutput } from "../../src/submission-validation/recorded-shape.js";
import { startFakeGhcr } from "../fake-ghcr.js";
import { sharedWarmBase } from "../paths.js";
import { archiveWith, publishLocalCapture } from "../support/captures.js";
import { spec2TestEnvironment, withTestEnvironments, withTestEnvironmentsAsync } from "../support/environments.js";
import { buildOnHost, freshLaxHome, makeHostSubmission, messages, rules, tmpDir } from "../support/host.js";

/** The registered source of lax-38 in the chain test; nothing at this URL
 * exists, a git rewrite points lake at the checkout (cross-submission.test.ts). */
const UPSTREAM_REPOSITORY = "https://github.com/lax-e2e/spec2-upstream";

/** The lax-38 build the later tests reuse: its root, its job directory
 * (the certify project and bundle stay there), and its report. */
let lax38: { root: string; jobDir: string; report: HostValidationReport } | undefined;

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
      // generator and the same two commands as the archive's containers.
      const certificate = out.certificate!;
      expect(certificate).toMatchObject({
        judge: { toolchain: SPEC2.leanToolchain, comparatorExitCode: 0 },
        kernels: ["lean"],
        bundle: { formatVersion: 1, digest: expect.stringMatching(/^[0-9a-f]{64}$/u) },
        challengeExportSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      });
      expect(certificate.challenge).toBe(
        fs.readFileSync(path.join(jobDir, "certify", "project", "Challenge.lean"), "utf8"),
      );
      expect(certificate.challenge).toContain("import Lax38\n");
      expect(certificate.challenge).toContain("theorem Cert.Lax38Proofs.hasSucc : _root_.Lax38.Order.HasSucc := sorry");
      expect(certificate.challenge).toContain("theorem Cert.Lax38Proofs.refl_of_hasSucc.{u}\n    (h₁ : _root_.Lax38.Order.HasSucc)\n    : _root_.Lax38.Order.Refl.{u} := sorry");
      expect(certificate.challenge).not.toContain("Lax38Proofs.hasSucc h");
      console.log(`[certify timing] lax-38 whole build incl. certification: ${Math.round(performance.now() - started)} ms`);
      // the bundle sealed what ran, and the export's digest is the file's
      const tar = fs.readFileSync(path.join(jobDir, "certify", "certificate.tar"));
      expect(createHash("sha256").update(tar).digest("hex")).toBe(certificate.bundle.digest);
      const members = readBundle(tar);
      expect([...members.keys()]).toEqual(["Challenge.lean", "Solution.lean", "comparator.json", "lake-manifest.json", "lakefile.toml"]);
      expect(members.get("lakefile.toml")).toContain('path = "packages/Lax38Proofs"');
      expect(createHash("sha256").update(fs.readFileSync(path.join(jobDir, "certify", "challenge.export"))).digest("hex"))
        .toBe(certificate.challengeExportSha256);
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
      // in the capture inventory's own order (seal.ts walks a directory before its sibling files)
      const referenceMembers = [...readBundle(referencesTar).keys()];
      expect(referenceMembers).toEqual(["./concepts/lib/Lax38/Order.ilean", "./concepts/lib/Lax38.ilean", "./concepts/package/Lax38/Order.lean", "./concepts/package/Lax38.lean"]);
      expect(readBundle(referencesTar).get("./concepts/package/Lax38/Order.lean")).toBe(out.concepts[0]!.sourceText);
      expect(out.inputs.manifest.specVersion).toBe("2");
      expect(out.concepts).toHaveLength(1);
      expect(out.concepts[0]!.mathlibImports).toEqual([]);
      expect(out.concepts[0]!.statements).toEqual([
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
            hypotheses: [{ statement: "Lax38.Order.HasSucc", levels: [], binder: "default" }],
            conclusion: { statement: "Lax38.Order.Refl", levels: ["u"] },
          },
          conclusion: "Lax38.Order.Refl",
          assumptions: ["Lax38.Order.HasSucc"],
          description: "conditional, universe-polymorphic",
          sections: [{ title: "Strategy", markdown: "Ignore the hypothesis." }],
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
  // warm-store overrides, and the in-container tool
  // (sandbox/tools/run-certify.mjs) driven twice with host paths in place of
  // the mount points — `lake build Challenge` plus `leanexport` over a
  // composed LEAN_PATH, then `lake comparator --challenge-from-export`.
  it("rehearses the two-container layout over the staged captures with the real tool script", async () => {
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
      const planA = path.join(challengeDir, "plan.json");
      fs.writeFileSync(planA, JSON.stringify({
        tool: "challenge",
        project: challengeProject,
        module: "Challenge",
        targets: plan.exportTargets,
        leanPath: [projectLibDir(challengeProject), concepts.libDir, ...warmLibDirs(warmPackages, warm)],
        output: exportPath,
        toolchainBin,
        home: path.join(root, "home"),
      }));
      const built = await runTool(planA, "A (build + export)");
      expect(built.output, built.output).not.toContain("error:");
      expect(built.code).toBe(0);
      expect(fs.statSync(exportPath).size).toBeGreaterThan(1000);
      expect(fs.readFileSync(exportPath, "utf8").startsWith('{"meta"')).toBe(true);
      // the export (lean4export 3.1.0 NDJSON, names hash-consed per
      // component) carries the certificate theorems as `thm` records
      const exported = fs.readFileSync(exportPath, "utf8");
      expect(exported).toContain('"str":"Cert"');
      expect(exported).toContain('"str":"hasSucc"');
      expect(exported).toContain('"str":"refl_of_hasSucc"');
      expect(exported).toMatch(/"thm":/u);

      // B
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
      fs.chmodSync(exportPath, 0o444);
      const planB = path.join(solutionDir, "plan.json");
      fs.writeFileSync(planB, JSON.stringify({
        tool: "comparator",
        project: solutionProject,
        config: "comparator.json",
        challengeExport: exportPath,
        paranoid: false,
        toolchainBin,
        home: path.join(root, "home"),
      }));
      const judged = await runTool(planB, "B (comparator)");
      expect(judged.output, judged.output).toContain("Your solution is okay!");
      expect(interpretComparatorRun(judged)).toEqual({ kind: "certified" });
      // the lakefile B ran kept the bundle's git requires; the manifest's
      // path entries did the redirecting, as a submission build's do
      expect(fs.readFileSync(path.join(solutionProject, "lakefile.toml"), "utf8")).toContain(`git = "${lax38!.report.request.source.repository}"`);
      // the capture root was never written to
      expect(fs.existsSync(path.join(captureRoot, "concepts", "package", ".lake"))).toBe(false);
      // and the paranoid set runs through the same tool when asked
      fs.writeFileSync(planB, JSON.stringify({ ...JSON.parse(fs.readFileSync(planB, "utf8")), paranoid: true }));
      const paranoid = await runTool(planB, "B (comparator --paranoid)");
      expect(paranoid.output, paranoid.output).toContain("Your solution is okay!");
      expect(paranoid.output).toContain("lean4lean kernel accepts the solution");
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
      } finally {
        delete process.env.LAX_CAPTURE_REGISTRY_URL;
        for (const key of rewrites) delete process.env[key];
        if (rewrites.length > 0) process.env.GIT_CONFIG_COUNT = String(Number(process.env.GIT_CONFIG_COUNT) - 1);
        if (process.env.GIT_CONFIG_COUNT === "0") delete process.env.GIT_CONFIG_COUNT;
        await ghcr.close();
      }
    });
  }, 600_000);

  it("fails in Inspect on a private proof-shaped theorem and a concrete universe level", async () => {
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

end Lax39Proofs
`,
        },
        undefined,
        { environment },
      );
      const report = await buildOnHost(root, { id: "lax-39" });
      expect(report.ok).toBe(false);
      expect(rules(report)).toEqual(new Set(["proof"]));
      expect(report.violations.every((violation) => violation.phase === "inspect")).toBe(true);
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
