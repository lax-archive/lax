// The trusted Certify phase (axiomfree-plan.md, "Certify" 2–3, hardened
// 2026-10-04 after spike/axiomfree/codex-review-stages1-3-20261003.md
// finding 1): three runs in the existing docker runner under the existing
// env allowlist and limits.
//
//   A  mounts the warm store, the record's own concept capture and the
//      concept closure's materialised captures read-only, and the Challenge
//      half of the generated project (read-only except its `.lake`); builds
//      `Challenge` and exports it with the toolchain's `leanexport` to
//      `challenge.export`. Nothing of any proof package is mounted.
//   B  mounts the same plus the proof capture and the whole project, builds
//      `Solution` and exports it the same way to `solution.export`. B is the
//      only container that executes the proof package's code (its
//      initializers run during the build), and it is torn down before C.
//   C  the judge: a fresh container with the bundle's five files read-only,
//      both exports read-only, the toolchain, the tools, and a read-only
//      `git` shim — no capture, no warm store, no `/deps`, nothing writable
//      but `/out` and the noexec `/tmp` — running `lake comparator
//      --challenge-from-export … --solution-from-export …
//      --inadvisably-no-sandbox [--paranoid]`. With both exports supplied the
//      comparator builds nothing and resolves nothing (Lake/CLI/Check.lean
//      runComparator); it parses the two exports, compares the theorems, and
//      runs the kernels over the Solution export.
//
// The container is the sandbox: no run holds a token, and nothing B writes
// reaches C — B's writable mounts are its own `.lake` and `/out`, C mounts
// neither, and the file C reads from B's `/out` is bind-mounted alone, so a
// `which` planted beside it is invisible. C's PATH has no writable entry at
// all, which is what makes `which leanchecker` resolve to the toolchain's.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RUNTIME_PATHS, type ValidationLimits } from "../config.js";
import type { CertificateOutput } from "../contracts.js";
import { containerBoundaryFailure, infrastructureFailure, type PipelineFailure } from "../failures.js";
import { seedOverrides } from "../host/warmstore.js";
import type { ContainerMount, ValidationRunner } from "../sandbox/container.js";
import { sealBundle } from "./bundle.js";
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
import { interpretComparatorRun } from "./verdict.js";

export type CertifyResult =
  | { kind: "nothing" }
  | { kind: "certified"; certificate: CertificateOutput; bundlePath: string }
  | { kind: "violation"; rule: string; message: string };

export interface CertifyPhaseInput {
  record: CertifyRecord;
  jobDir: string;
  captureRoot: string;
  dependencyRoot: string;
  /** The host path of the warm store the runner mounts (for the overrides). */
  warmWs: string;
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

/** Write a run project under `root` and return its mounts and host paths. */
function prepareRun(
  root: string,
  input: CertifyPhaseInput,
  files: ReturnType<typeof challengeProjectFiles>,
  deps: Array<{ name: string; dir: string }>,
): { mounts: ContainerMount[]; outDir: string } {
  const projectDir = path.join(root, "project");
  const buildDir = path.join(root, "build");
  const outDir = path.join(root, "out");
  writeRunProject(projectDir, path.join(buildDir, ".lake"), files, { warm: input.record.warmPackages, deps });
  // the overrides go into the writable `.lake` lake sees, rebased to the
  // in-container warm mount (phases/provision.ts does the same for a build)
  seedOverrides(input.warmWs, buildDir, RUNTIME_PATHS.warmWorkspace);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  return {
    outDir,
    mounts: [
      { source: projectDir, target: CERTIFY_PATHS.project },
      { source: path.join(buildDir, ".lake"), target: `${CERTIFY_PATHS.project}/.lake`, writable: true },
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

/** A generated name the escaper cannot write is the record's problem to
 * read, on the `certify` phase, before anything runs. */
export function nameViolation(error: unknown): CertifyResult | undefined {
  if (!(error instanceof LeanNameError)) return undefined;
  return {
    kind: "violation",
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

  // ── A: the Challenge, over the concept packages alone ──────────────────
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
    );
    fs.writeFileSync(
      path.join(run.outDir, "plan.json"),
      `${JSON.stringify({
        tool: "export",
        project: CERTIFY_PATHS.project,
        module: CHALLENGE_MODULE,
        targets: plan.exportTargets,
        // composed, never `lake env`: the project's build tree, the concept
        // captures, the warm store (sandbox/tools/run-check.mjs's shape)
        leanPath: [
          projectLibDir(CERTIFY_PATHS.project),
          `${CERTIFY_PATHS.own}/concepts/lib`,
          ...plan.challengeClosure.map(dependencyLibDir),
          ...warmLibDirs(input.record.warmPackages, RUNTIME_PATHS.warmWorkspace),
        ],
        output: `${CERTIFY_PATHS.out}/challenge.export`,
      })}\n`,
      { mode: 0o600 },
    );
    const result = await input.runner.run({
      label: "certify-challenge",
      args: ["node", "/opt/lax/bin/run-certify.mjs", `${CERTIFY_PATHS.out}/plan.json`],
      mounts: [...run.mounts, ...ownMounts("concepts", concepts), ...dependencyMounts(input.dependencyRoot, plan.challengeClosure)],
      env: leanThreads,
      timeoutMs: input.limits.checkTimeoutMs,
      maxOutputBytes: input.limits.maxOutputBytes,
    });
    if (result.code !== 0) {
      const failure = boundary(result, "building the certificate Challenge");
      if (failure !== undefined) throw failure;
      return {
        kind: "violation" as const,
        rule: "challenge-build",
        message:
          "the generated Challenge did not build over the concept packages — the statements lax named from the " +
          "proofs' telescopes do not elaborate the way Lean reads them, so lax's generator and classifier disagree " +
          "with Lean; please report it as a lax bug, quoting this message. The transcript:\n" +
          result.output.trim(),
      };
    }
    return { kind: "exported" as const, ...exportedFile(path.join(run.outDir, "challenge.export"), "Challenge") };
  });
  if (challenge.kind === "violation") return challenge;

  // ── B: the Solution, built over the proof package and exported ─────────
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
    );
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
    const result = await input.runner.run({
      label: "certify-solution",
      args: ["node", "/opt/lax/bin/run-certify.mjs", `${CERTIFY_PATHS.out}/plan.json`],
      mounts: [
        ...run.mounts,
        ...ownMounts("concepts", concepts),
        ...ownMounts("proofs", proofs),
        ...dependencyMounts(input.dependencyRoot, plan.solutionClosure),
      ],
      env: leanThreads,
      timeoutMs: input.limits.checkTimeoutMs,
      maxOutputBytes: input.limits.maxOutputBytes,
    });
    if (result.code !== 0) {
      const failure = boundary(result, "building the certificate Solution");
      if (failure !== undefined) throw failure;
      return {
        kind: "violation" as const,
        rule: "solution-build",
        message:
          "the generated Solution did not elaborate — the certificate lax wrote from the proofs' telescopes does " +
          "not apply the proofs the way Lean reads them, so lax's generator and classifier disagree with Lean; " +
          "please report it as a lax bug, quoting this message. The transcript:\n" +
          result.output.trim(),
      };
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

  const sealed = sealBundle(plan.bundle);
  const bundlePath = path.join(root, "certificate.tar");
  fs.writeFileSync(bundlePath, sealed.tar, { mode: 0o600 });
  return {
    kind: "certified",
    bundlePath,
    certificate: {
      judge: { toolchain: input.record.environment.leanToolchain, comparatorExitCode: 0 },
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
