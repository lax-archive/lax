// The trusted Certify phase (axiomfree-plan.md, "Certify" 2–3; the draft
// spec's "Two containers"): two runs in the existing docker runner under the
// existing env allowlist and limits.
//
//   A  mounts the warm store, the record's own concept capture and the
//      materialised dependency captures read-only, and the Challenge half of
//      the generated project (read-only except its `.lake`); builds
//      `Challenge` and exports it with the toolchain's `leanexport` to
//      `challenge.export`. Nothing of the proof package is mounted.
//   B  mounts the same plus the proof capture and the whole project, with
//      `challenge.export` read-only, and runs `lake comparator
//      --challenge-from-export … --inadvisably-no-sandbox`, with `--paranoid`
//      when the environment's kernel setting says so.
//
// The container is the sandbox: B holds no token, and nothing B writes is
// read by anything but the verdict parser (certify/verdict.ts). A, which
// never sees the proof package, is what produced the export B judges — the
// Solution build cannot touch the Challenge export or the toolchain.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RUNTIME_PATHS, type ValidationLimits } from "../config.js";
import type { CertificateOutput } from "../contracts.js";
import { containerBoundaryFailure, infrastructureFailure, type PipelineFailure } from "../failures.js";
import { seedOverrides } from "../host/warmstore.js";
import type { ContainerMount, ValidationRunner } from "../sandbox/container.js";
import { sealBundle } from "./bundle.js";
import {
  CERTIFY_PATHS,
  CHALLENGE_MODULE,
  challengeProjectFiles,
  kernelsOf,
  planCertificate,
  projectLibDir,
  solutionProjectFiles,
  stageOwnPackage,
  warmLibDirs,
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
      ...(fs.existsSync(input.dependencyRoot) ? [{ source: input.dependencyRoot, target: CERTIFY_PATHS.deps }] : []),
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

export async function certifyInContainer(input: CertifyPhaseInput): Promise<CertifyResult> {
  const plan = planCertificate(input.record);
  if (plan === undefined) return { kind: "nothing" };
  const root = path.join(input.jobDir, "certify");
  const gitSources = requireSources(plan, input.record);

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
        ...plan.challengeClosure.map((dependency) => ({
          name: dependency.packageName,
          dir: `${CERTIFY_PATHS.deps}/${dependency.submissionId}/${dependency.kind}/package`,
        })),
      ],
    );
    const exportPath = path.join(run.outDir, "challenge.export");
    fs.writeFileSync(
      path.join(run.outDir, "plan.json"),
      `${JSON.stringify({
        tool: "challenge",
        project: CERTIFY_PATHS.project,
        module: CHALLENGE_MODULE,
        targets: plan.exportTargets,
        // composed, never `lake env`: the project's build tree, the concept
        // captures, the warm store (sandbox/tools/run-check.mjs's shape)
        leanPath: [
          projectLibDir(CERTIFY_PATHS.project),
          `${CERTIFY_PATHS.own}/concepts/lib`,
          ...plan.challengeClosure.map((dependency) => `${CERTIFY_PATHS.deps}/${dependency.submissionId}/${dependency.kind}/lib`),
          ...warmLibDirs(input.record.warmPackages, RUNTIME_PATHS.warmWorkspace),
        ],
        output: `${CERTIFY_PATHS.out}/challenge.export`,
      })}\n`,
      { mode: 0o600 },
    );
    const result = await input.runner.run({
      label: "certify-challenge",
      args: ["node", "/opt/lax/bin/run-certify.mjs", `${CERTIFY_PATHS.out}/plan.json`],
      mounts: [...run.mounts, ...ownMounts("concepts", concepts)],
      env: { LEAN_NUM_THREADS: String(input.limits.leanThreads) },
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
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(exportPath);
    } catch {
      throw infrastructureFailure("the Challenge export was not produced");
    }
    if (!stat.isFile() || stat.size === 0) throw infrastructureFailure("the Challenge export is empty");
    return { kind: "exported" as const, exportPath, sha256: sha256File(exportPath) };
  });
  if (challenge.kind === "violation") return challenge;

  // ── B: the Solution, judged against the export ─────────────────────────
  const verdict = await input.phase("certify solution", async () => {
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
        ...plan.solutionClosure.map((dependency) => ({
          name: dependency.packageName,
          dir: `${CERTIFY_PATHS.deps}/${dependency.submissionId}/${dependency.kind}/package`,
        })),
      ],
    );
    fs.writeFileSync(
      path.join(run.outDir, "plan.json"),
      `${JSON.stringify({
        tool: "comparator",
        project: CERTIFY_PATHS.project,
        config: "comparator.json",
        challengeExport: CERTIFY_PATHS.challengeExport,
        paranoid: input.limits.certificationKernels === "paranoid",
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
        // read-only: the Solution build cannot touch what it is judged against
        { source: challenge.exportPath, target: CERTIFY_PATHS.challengeExport },
      ],
      env: { LEAN_NUM_THREADS: String(input.limits.leanThreads) },
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
