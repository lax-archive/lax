// The trusted Certify phase (axiomfree-plan.md, "Certify" 2–3, hardened
// 2026-10-04 after spike/axiomfree/codex-review-stages1-3-20261003.md
// finding 1 and again after spike/axiomfree/fable-review-intents-20261004.md
// finding 1.1): five runs in the existing docker runner under the existing
// env allowlist and limits, a build and an export per side, then the judge —
// preceded by the judge self-test (certify/self-test.ts): before anything of
// the record is built, the same container shapes build, export and judge
// three one-line modules lax owns and probe the judge's confinement, and the
// host digests the judge's binaries, held to the same digests after the
// judge has run. A wrong answer there is an infrastructure failure, never a
// finding against the author.
//
//   A1 mounts the warm store, the record's own concept capture and the
//      concept closure's materialised captures read-only, and the Challenge
//      half of the generated project (read-only except its `.lake`); runs
//      `lake build Challenge`. This is where concept-package code runs —
//      every module initializer of the closure — with a writable `.lake` and
//      nothing else writable. Nothing of any proof package is mounted.
//   A2 a fresh container over A1's build tree mounted **read-only**, the
//      concept lib dirs, the warm store, the toolchain and the inspector,
//      and `/out` as its only writable mount; runs the toolchain's own
//      `leanexport` to `challenge.export`, then the inspector over the built
//      Challenge (`loadExts := false`, like every inspection) for the
//      telescope check (certify/challenge-check.ts). No candidate code runs
//      here and no process of A1 is alive here, so the export and the report
//      are the tools' bytes — "a verifier-owned file no candidate phase can
//      write to", in Palomar's words.
//   B1 mounts what A1 had plus the proof capture and the whole project and
//      runs `lake build Solution`: the only container that executes the
//      proof package's code.
//   B2 exports the Solution over B1's read-only build tree, as A2 does.
//   C  the judge: a fresh container with the bundle's five files read-only,
//      both exports read-only, the toolchain, the tools, and a read-only
//      `git` shim — no capture, no warm store, no `/deps`, nothing writable
//      but `/out` — running `lake comparator --challenge-from-export …
//      --solution-from-export … --inadvisably-no-sandbox [--paranoid]`. With
//      both exports supplied the comparator builds nothing and resolves
//      nothing (Lake/CLI/Check.lean runComparator); it parses the two
//      exports, compares the theorems, and runs the kernels over the
//      Solution export.
//
// The container is the sandbox: no run holds a token. Nothing a build writes
// reaches its export step except the build tree, read-only; nothing B1 or B2
// writes reaches C — C mounts neither `.lake` nor `/out` of any earlier run,
// and the file C reads from B2's `/out` is bind-mounted alone, so a `which`
// planted beside it is invisible. C's PATH has no writable entry at all —
// the shim mount, the toolchain, and the image's own directories are all
// read-only, and `/out` is not on it — which is what makes `which
// leanchecker` resolve to the toolchain's. (`/tmp` is a tmpfs mounted
// `rw,nosuid,nodev` by container.ts; whether docker adds `noexec` to an
// explicit `--tmpfs` option string is a TODO.md item, and nothing here
// relies on it.)

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RUNTIME_PATHS, type ValidationLimits } from "../config.js";
import type { CertificateOutput, FindingIntent, ResolvedDependency } from "../contracts.js";
import { containerBoundaryFailure, infrastructureFailure, type PipelineFailure } from "../failures.js";
import { seedOverrides } from "../host/warmstore.js";
import type { ContainerMount, ValidationRunner } from "../sandbox/container.js";
import { parseInspectorReport } from "../phases/inspect-runner.js";
import { sealBundle } from "./bundle.js";
import { checkChallengeReport } from "./challenge-check.js";
import { LeanNameError } from "./lean-name.js";
import {
  CERTIFY_PATHS,
  CHALLENGE_MODULE,
  SOLUTION_MODULE,
  challengeProjectFiles,
  dependencyLibDir,
  dependencyMounts,
  dependencyPackageDir,
  kernelsOf,
  planCertificate,
  projectLibDir,
  solutionProjectFiles,
  stageOwnPackage,
  warmLibDirs,
  writeJudgeProject,
  writeRunProject,
  type CertifyPlan,
  type CertifyRecord,
  type StagedOwnPackage,
} from "./project.js";
import { runJudgeSelfTest, toolDigests, verifyToolDigests } from "./self-test.js";
import { interpretComparatorRun } from "./verdict.js";

export type CertifyResult =
  | { kind: "nothing" }
  | { kind: "certified"; certificate: CertificateOutput; bundlePath: string }
  | { kind: "violation"; rule: string; message: string; intent: FindingIntent };

export interface CertifyPhaseInput {
  record: CertifyRecord;
  jobDir: string;
  captureRoot: string;
  dependencyRoot: string;
  /** The host path of the warm store the runner mounts (for the overrides). */
  warmWs: string;
  /** The host path of the toolchain the runner mounts: the judge's binaries
   * are digested there before the first container and after the judge. */
  toolchainDir: string;
  runner: ValidationRunner;
  limits: ValidationLimits;
  phase: <T>(name: string, operation: () => Promise<T> | T) => Promise<T>;
}

/** The mounts of one staged own package at its in-container place. */
function ownMounts(kind: "concepts" | "proofs", staged: StagedOwnPackage): ContainerMount[] {
  const base = `${CERTIFY_PATHS.own}/${kind}`;
  return [
    { source: staged.packageDir, target: `${base}/package` },
    { source: staged.libDir, target: `${base}/lib` },
    ...(staged.irDir === undefined ? [] : [{ source: staged.irDir, target: `${base}/ir` }]),
  ];
}

/** The lib-dir-only mounts of a staged own package, for an export step:
 * `leanexport` and the inspector read oleans off LEAN_PATH and nothing else. */
function ownLibMount(kind: "concepts" | "proofs", staged: StagedOwnPackage): ContainerMount[] {
  return [{ source: staged.libDir, target: `${CERTIFY_PATHS.own}/${kind}/lib` }];
}

/** The lib-dir-only mounts of a closure, for an export step. */
function dependencyLibMounts(dependencyRoot: string, closure: readonly ResolvedDependency[]): ContainerMount[] {
  return closure.map((dependency) => ({
    source: path.join(dependencyRoot, dependency.submissionId, dependency.kind, "lib"),
    target: dependencyLibDir(dependency),
  }));
}

/**
 * Write a run project under `root` and return the mounts of its two steps:
 * the build (the project read-only, its `.lake` writable, the plan read-only
 * — no `/out`) and the export (the project and the *same* `.lake` read-only,
 * `/out` the only writable mount). The plan of each step is written where
 * that step mounts it.
 */
function prepareRun(
  root: string,
  input: CertifyPhaseInput,
  files: ReturnType<typeof challengeProjectFiles>,
  deps: Array<{ name: string; dir: string }>,
  module: string,
): { buildMounts: ContainerMount[]; exportMounts: ContainerMount[]; outDir: string; planDir: string } {
  const projectDir = path.join(root, "project");
  const buildDir = path.join(root, "build");
  const outDir = path.join(root, "out");
  const planDir = path.join(root, "plan");
  writeRunProject(projectDir, path.join(buildDir, ".lake"), files, { warm: input.record.warmPackages, deps });
  // the overrides go into the writable `.lake` lake sees, rebased to the
  // in-container warm mount (phases/provision.ts does the same for a build)
  seedOverrides(input.warmWs, buildDir, RUNTIME_PATHS.warmWorkspace);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(planDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(planDir, "plan.json"),
    `${JSON.stringify({ tool: "build", project: CERTIFY_PATHS.project, module })}\n`,
    { mode: 0o600 },
  );
  return {
    outDir,
    planDir,
    buildMounts: [
      { source: projectDir, target: CERTIFY_PATHS.project },
      { source: path.join(buildDir, ".lake"), target: `${CERTIFY_PATHS.project}/.lake`, writable: true },
      { source: planDir, target: CERTIFY_PATHS.plan },
    ],
    exportMounts: [
      { source: projectDir, target: CERTIFY_PATHS.project },
      { source: path.join(buildDir, ".lake"), target: `${CERTIFY_PATHS.project}/.lake` },
      { source: outDir, target: CERTIFY_PATHS.out, writable: true },
    ],
  };
}

function sha256File(filename: string): string {
  const hash = createHash("sha256");
  const handle = fs.openSync(filename, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest("hex");
}

/** A container that did not run to completion is the archive's problem;
 * a tool that ran and refused is the phase's to read. */
function boundary(result: { code: number; output: string; timedOut: boolean }, what: string): PipelineFailure | undefined {
  // 3 is run-certify.mjs's "the tool was terminated by a signal": a crash
  // or a kill inside the container, never the author's (fable review 1.5)
  if (result.code === 3) return infrastructureFailure(`${what} was terminated by a signal:\n${result.output.trim()}`);
  return containerBoundaryFailure(result, `${what} exceeded its time limit`, `${what} exceeded its memory limit`);
}

/** The export a container wrote, held to being a plain non-empty file —
 * never a symlink the build left pointing elsewhere — and digested. */
function exportedFile(filename: string, what: string): { exportPath: string; sha256: string } {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filename);
  } catch {
    throw infrastructureFailure(`the ${what} export was not produced`);
  }
  if (!stat.isFile()) throw infrastructureFailure(`the ${what} export is not a regular file`);
  if (stat.size === 0) throw infrastructureFailure(`the ${what} export is empty`);
  return { exportPath: filename, sha256: sha256File(filename) };
}

/** The inspector's report over the built Challenge, as container A left it
 * in `/out`: a plain bounded file, parsed as every spec-2 report is
 * (phases/inspect-runner.ts). Missing or unreadable is the archive's
 * problem, never a verdict on the record. */
export function readChallengeReport(filename: string, maxBytes: number): ReturnType<typeof parseInspectorReport> {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filename);
  } catch {
    throw infrastructureFailure("the Challenge inspection report was not produced");
  }
  if (!stat.isFile() || stat.size > maxBytes) throw infrastructureFailure("the Challenge inspection report is missing or oversized");
  try {
    return parseInspectorReport(JSON.parse(fs.readFileSync(filename, "utf8")) as unknown, 2);
  } catch (error) {
    throw infrastructureFailure(`could not read the Challenge inspection report: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A generated name the escaper cannot write is the record's problem to
 * read, on the `certify` phase, before anything runs — a `translation`
 * refusal: the generator could not state the edge. */
export function nameViolation(error: unknown): CertifyResult | undefined {
  if (!(error instanceof LeanNameError)) return undefined;
  return {
    kind: "violation",
    intent: "translation",
    rule: "name",
    message:
      `${error.message}; the certificate names every statement and proof as a Lean identifier, and this ` +
      "component cannot be written as one — rename the declaration",
  };
}

export async function certifyInContainer(input: CertifyPhaseInput): Promise<CertifyResult> {
  let plan: CertifyPlan | undefined;
  try {
    plan = planCertificate(input.record);
  } catch (error) {
    const violation = nameViolation(error);
    if (violation !== undefined) return violation;
    throw error;
  }
  if (plan === undefined) return { kind: "nothing" };
  if (plan.kind !== "publishable") throw new Error("the trusted Certify phase was handed a local plan");
  const root = path.join(input.jobDir, "certify");
  const gitSources = requireSources(plan, input.record);
  const leanThreads = { LEAN_NUM_THREADS: String(input.limits.leanThreads) };

  // ── S: the judge self-test and the tool digests, before any record code ─
  const tools = toolDigests(input.toolchainDir);
  const selfTest = await input.phase("certify self-test", () =>
    runJudgeSelfTest({ certifyRoot: root, environment: input.record.environment, runner: input.runner, limits: input.limits }));

  // ── A1/A2: the Challenge, over the concept packages alone ──────────────
  const challenge = await input.phase("certify challenge", async () => {
    const concepts = stageOwnPackage(input.captureRoot, "concepts", path.join(root, "own"), (tree) =>
      `${CERTIFY_PATHS.own}/concepts/${tree}`);
    const run = prepareRun(
      path.join(root, "challenge"),
      input,
      challengeProjectFiles(plan, input.record, gitSources),
      [
        { name: input.record.ownConcepts, dir: `${CERTIFY_PATHS.own}/concepts/package` },
        ...plan.challengeClosure.map((dependency) => ({ name: dependency.packageName, dir: dependencyPackageDir(dependency) })),
      ],
      CHALLENGE_MODULE,
    );
    // A1: the build, with the concept packages' code running
    const built = await input.runner.run({
      label: "certify-challenge-build",
      args: ["node", "/opt/lax/bin/run-certify.mjs", `${CERTIFY_PATHS.plan}/plan.json`],
      mounts: [...run.buildMounts, ...ownMounts("concepts", concepts), ...dependencyMounts(input.dependencyRoot, plan.challengeClosure)],
      env: leanThreads,
      timeoutMs: input.limits.checkTimeoutMs,
      maxOutputBytes: input.limits.maxOutputBytes,
    });
    if (built.code !== 0) {
      const failure = boundary(built, "building the certificate Challenge");
      if (failure !== undefined) throw failure;
      // 2 is run-certify.mjs's "could not start": a malformed plan or a
      // tool that failed to spawn — the archive's, never the author's
      if (built.code === 2) throw infrastructureFailure(`the certificate build tool did not start for the Challenge:\n${built.output.trim()}`);
      // The Challenge names only statements and no proof code is present
      // in A1, so a build failure here is never the proof's. It is either
      // lax's — the translation disagreeing with Lean about what the
      // telescopes say — or the concept package's own: a concept
      // initializer that aborts during `lake build Challenge`, a concept
      // module that does not import cleanly. The second is decision 8's
      // trusted-author assumption (axiomfree-plan.md): the archive does not
      // defend against a concept package the record itself depends on, so
      // the finding stays `translation` and the wording asks for a report
      // only when the concept packages build on their own (verification
      // review 2026-10-04).
      return {
        kind: "violation" as const,
        intent: "translation" as const,
        rule: "challenge-build",
        message:
          "the generated Challenge did not build over the concept packages — the statements lax named from the " +
          "proofs' telescopes do not elaborate the way Lean reads them; if every concept package the record " +
          "requires builds cleanly with `lax build`, lax's generator and classifier disagree with Lean: report it as " +
          "a lax bug, quoting this message. The transcript:\n" +
          built.output.trim(),
      };
    }
    // A2: the export and the inspection, over the build tree read-only
    const leanPath = [
      projectLibDir(CERTIFY_PATHS.project),
      `${CERTIFY_PATHS.own}/concepts/lib`,
      ...plan.challengeClosure.map(dependencyLibDir),
      ...warmLibDirs(input.record.warmPackages, RUNTIME_PATHS.warmWorkspace),
    ];
    fs.writeFileSync(
      path.join(run.outDir, "plan.json"),
      `${JSON.stringify({
        tool: "export",
        project: CERTIFY_PATHS.project,
        module: CHALLENGE_MODULE,
        targets: plan.exportTargets,
        // composed, never `lake env`: the project's build tree, the concept
        // captures, the warm store (sandbox/tools/run-check.mjs's shape)
        leanPath,
        output: `${CERTIFY_PATHS.out}/challenge.export`,
        // then the inspector over the built Challenge, for the telescope
        // check below (certify/challenge-check.ts)
        inspect: { report: `${CERTIFY_PATHS.out}/challenge-report.json` },
      })}\n`,
      { mode: 0o600 },
    );
    const exported = await input.runner.run({
      label: "certify-challenge-export",
      args: ["node", "/opt/lax/bin/run-certify.mjs", `${CERTIFY_PATHS.out}/plan.json`],
      mounts: [...run.exportMounts, ...ownLibMount("concepts", concepts), ...dependencyLibMounts(input.dependencyRoot, plan.challengeClosure)],
      env: leanThreads,
      timeoutMs: input.limits.checkTimeoutMs,
      maxOutputBytes: input.limits.maxOutputBytes,
    });
    if (exported.code !== 0) {
      const failure = boundary(exported, "exporting the certificate Challenge");
      if (failure !== undefined) throw failure;
      // the module built; an exporter or inspector that refuses it is the
      // archive's tooling, never the author's
      throw infrastructureFailure(`exporting the certificate Challenge failed (exit ${exported.code}):\n${exported.output.trim()}`);
    }
    const file = exportedFile(path.join(run.outDir, "challenge.export"), "Challenge");
    // The Challenge held to the telescope: what each certificate theorem
    // elaborated to, read by the inspector in A2, against the record's edge.
    const mismatch = checkChallengeReport(
      readChallengeReport(path.join(run.outDir, "challenge-report.json"), input.limits.inspectorReportBytes),
      input.record.proofs,
    );
    if (mismatch !== undefined) return mismatch;
    return { kind: "exported" as const, ...file };
  });
  if (challenge.kind === "violation") return challenge;

  // ── B1/B2: the Solution, built over the proof package and exported ─────
  const solution = await input.phase("certify solution", async () => {
    const concepts = stageOwnPackage(input.captureRoot, "concepts", path.join(root, "own-solution"), (tree) =>
      `${CERTIFY_PATHS.own}/concepts/${tree}`);
    const proofs = stageOwnPackage(input.captureRoot, "proofs", path.join(root, "own-solution"), (tree) =>
      `${CERTIFY_PATHS.own}/proofs/${tree}`);
    const run = prepareRun(
      path.join(root, "solution"),
      input,
      solutionProjectFiles(plan, input.record, gitSources),
      [
        { name: input.record.ownConcepts, dir: `${CERTIFY_PATHS.own}/concepts/package` },
        { name: input.record.ownProofs, dir: `${CERTIFY_PATHS.own}/proofs/package` },
        ...plan.solutionClosure.map((dependency) => ({ name: dependency.packageName, dir: dependencyPackageDir(dependency) })),
      ],
      SOLUTION_MODULE,
    );
    // B1: the build — the one container that executes the proof package's code
    const built = await input.runner.run({
      label: "certify-solution-build",
      args: ["node", "/opt/lax/bin/run-certify.mjs", `${CERTIFY_PATHS.plan}/plan.json`],
      mounts: [
        ...run.buildMounts,
        ...ownMounts("concepts", concepts),
        ...ownMounts("proofs", proofs),
        ...dependencyMounts(input.dependencyRoot, plan.solutionClosure),
      ],
      env: leanThreads,
      timeoutMs: input.limits.checkTimeoutMs,
      maxOutputBytes: input.limits.maxOutputBytes,
    });
    if (built.code !== 0) {
      const failure = boundary(built, "building the certificate Solution");
      if (failure !== undefined) throw failure;
      if (built.code === 2) throw infrastructureFailure(`the certificate build tool did not start for the Solution:\n${built.output.trim()}`);
      // the Solution applies the proof: a build failure is the judge's
      // question answered one step early
      return {
        kind: "violation" as const,
        intent: "judge" as const,
        rule: "solution-build",
        message:
          "the generated Solution did not elaborate — the certificate lax wrote from the proofs' telescopes does " +
          "not apply the proofs the way Lean reads them; if your proof package builds cleanly with `lax build`, " +
          "report it as a lax bug, quoting this message. The transcript:\n" +
          built.output.trim(),
      };
    }
    // B2: the export, over the build tree read-only
    fs.writeFileSync(
      path.join(run.outDir, "plan.json"),
      `${JSON.stringify({
        tool: "export",
        project: CERTIFY_PATHS.project,
        module: SOLUTION_MODULE,
        targets: plan.exportTargets,
        leanPath: [
          projectLibDir(CERTIFY_PATHS.project),
          `${CERTIFY_PATHS.own}/concepts/lib`,
          `${CERTIFY_PATHS.own}/proofs/lib`,
          ...plan.solutionClosure.map(dependencyLibDir),
          ...warmLibDirs(input.record.warmPackages, RUNTIME_PATHS.warmWorkspace),
        ],
        output: `${CERTIFY_PATHS.out}/solution.export`,
      })}\n`,
      { mode: 0o600 },
    );
    const exported = await input.runner.run({
      label: "certify-solution-export",
      args: ["node", "/opt/lax/bin/run-certify.mjs", `${CERTIFY_PATHS.out}/plan.json`],
      mounts: [
        ...run.exportMounts,
        ...ownLibMount("concepts", concepts),
        ...ownLibMount("proofs", proofs),
        ...dependencyLibMounts(input.dependencyRoot, plan.solutionClosure),
      ],
      env: leanThreads,
      timeoutMs: input.limits.checkTimeoutMs,
      maxOutputBytes: input.limits.maxOutputBytes,
    });
    if (exported.code !== 0) {
      const failure = boundary(exported, "exporting the certificate Solution");
      if (failure !== undefined) throw failure;
      throw infrastructureFailure(`exporting the certificate Solution failed (exit ${exported.code}):\n${exported.output.trim()}`);
    }
    return { kind: "exported" as const, ...exportedFile(path.join(run.outDir, "solution.export"), "Solution") };
  });
  if (solution.kind === "violation") return solution;

  // ── C: the judge, over the two frozen exports ──────────────────────────
  const verdict = await input.phase("certify judge", async () => {
    const judge = writeJudgeProject(path.join(root, "judge"), plan.bundle);
    const outDir = path.join(root, "judge", "out");
    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(outDir, "plan.json"),
      `${JSON.stringify({
        tool: "comparator",
        project: CERTIFY_PATHS.project,
        config: "comparator.json",
        challengeExport: CERTIFY_PATHS.challengeExport,
        solutionExport: CERTIFY_PATHS.solutionExport,
        shims: CERTIFY_PATHS.shims,
        paranoid: input.limits.certificationKernels === "paranoid",
      })}\n`,
      { mode: 0o600 },
    );
    const result = await input.runner.run({
      label: "certify-judge",
      runtime: "judge",
      args: ["node", "/opt/lax/bin/run-certify.mjs", `${CERTIFY_PATHS.out}/plan.json`],
      mounts: [
        { source: judge.projectDir, target: CERTIFY_PATHS.project },
        { source: judge.shimsDir, target: CERTIFY_PATHS.shims },
        // read-only, each file alone: the judge sees the bytes, not the
        // directories the builds wrote them into
        { source: challenge.exportPath, target: CERTIFY_PATHS.challengeExport },
        { source: solution.exportPath, target: CERTIFY_PATHS.solutionExport },
        { source: outDir, target: CERTIFY_PATHS.out, writable: true },
      ],
      env: leanThreads,
      timeoutMs: input.limits.checkTimeoutMs,
      maxOutputBytes: input.limits.maxOutputBytes,
    });
    const failure = boundary(result, "judging the certificate");
    if (failure !== undefined) throw failure;
    return interpretComparatorRun(result);
  });
  if (verdict.kind === "failure") throw verdict.failure;
  if (verdict.kind === "violation") return verdict;
  // the binaries that judged are the binaries that were digested
  verifyToolDigests(input.toolchainDir, tools);

  const sealed = sealBundle(plan.bundle);
  const bundlePath = path.join(root, "certificate.tar");
  fs.writeFileSync(bundlePath, sealed.tar, { mode: 0o600 });
  return {
    kind: "certified",
    bundlePath,
    certificate: {
      judge: { toolchain: input.record.environment.leanToolchain, comparatorExitCode: 0, selfTest, tools },
      kernels: kernelsOf(input.limits.certificationKernels, input.record.environment),
      bundle: { formatVersion: 1, digest: sealed.digest },
      challengeExportSha256: challenge.sha256,
      solutionExportSha256: solution.sha256,
      challenge: plan.bundle["Challenge.lean"],
    },
  };
}

/** The container runs keep the bundle's git requires in their lakefiles —
 * the manifest's path entries are what redirect them, exactly as a
 * submission's own build is provisioned (phases/provision.ts). */
function requireSources(plan: CertifyPlan, record: CertifyRecord): (name: string) => { git: string; rev: string; subDir: string } {
  return (name) => {
    const source = plan.gitSources.get(name);
    if (source === undefined) throw new Error(`the certificate bundle requires no package ${name} (record ${record.ownConcepts})`);
    return source;
  };
}
