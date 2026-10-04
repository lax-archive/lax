// The judge self-test (TODO.md "Judge self-test before any candidate code
// runs", from Palomar's policy): before the trusted Certify phase builds
// anything of the record, it proves the runner and the judge on one-line
// Lean modules lax owns, through the very containers, mounts and limits the
// record will go through next —
//
//   S1 `lake build LaxSelfTest`: three core-only modules, built in the judge
//      runtime (toolchain and tools alone, no warm store) with a writable
//      `.lake` and nothing else writable, like A1;
//   S2 one export step over S1's build tree read-only, like A2, writing the
//      Challenge, Solution and Mismatch exports with the comparator's own
//      target list;
//   S3 the judge over (Challenge, Solution): must accept;
//   S4 the judge over (Challenge, Mismatch): the comparison must reject
//      (`Challenge and solution theorem statement do not match`);
//   S5 the judge over (Challenge, Forged) — the Solution export with the
//      theorem's proof term replaced by its own statement, an edit the host
//      makes on the export's NDJSON (lean4export 3.1.0, pinned by the
//      toolchain): Lean's kernel must refuse it;
//   S6 a probe in the judge runtime: a canary the host wrote under the job
//      directory and under its own `/tmp` is invisible, `/proc/net/dev` lists
//      no interface but `lo`, `which leanchecker` on the judge's PATH resolves
//      to the toolchain's binary, and neither the project nor the toolchain
//      directory is writable.
//
// Any wrong answer is an infrastructure failure naming the probe, never a
// finding against the author: a runner where the judge, a kernel or the
// confinement does not work fails closed before candidate code runs. Nothing
// is cached across submissions — the point is to prove the runner each time.
// Beside the probes, the host digests the judge's binaries as installed
// (JUDGE_TOOLS) before S1 and holds them to the same digests after the real
// judge has run; the record carries them beside the toolchain name.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { RUNTIME_PATHS, type ValidationLimits } from "../config.js";
import {
  JUDGE_TOOLS,
  SELF_TEST_PROBES,
  type JudgeSelfTest,
  type JudgeTool,
  type SelfTestProbe,
} from "../contracts.js";
import type { ArchiveEnvironment } from "../environments.js";
import { containerBoundaryFailure, infrastructureFailure } from "../failures.js";
import { leanFacts } from "../lean-facts.js";
import { manifestText } from "../host/warmstore.js";
import type { ContainerMount, ValidationRunner } from "../sandbox/container.js";
import { comparatorConfigFor } from "./generate.js";
import { CERTIFY_PATHS, GIT_SHIM, projectLibDir } from "./project.js";
import { interpretComparatorRun } from "./verdict.js";

export const SELF_TEST_PACKAGE = "LaxSelfTest";
export const SELF_TEST_THEOREM = "Cert.selfTest";
export const SELF_TEST_MODULES = { challenge: "SelfChallenge", solution: "SelfSolution", mismatch: "SelfMismatch" } as const;

/** The self-test project: a core-only package with three one-line modules
 * and the manifest the sandboxed build expects. Nothing of any record. */
export function selfTestProjectFiles(): Record<string, string> {
  return {
    "lakefile.toml":
      `name = "${SELF_TEST_PACKAGE}"\ndefaultTargets = ["${SELF_TEST_PACKAGE}"]\n\n[[lean_lib]]\nname = "${SELF_TEST_PACKAGE}"\n` +
      `roots = ["${SELF_TEST_MODULES.challenge}", "${SELF_TEST_MODULES.solution}", "${SELF_TEST_MODULES.mismatch}"]\n`,
    "lake-manifest.json": manifestText([], []),
    [`${SELF_TEST_MODULES.challenge}.lean`]: `theorem ${SELF_TEST_THEOREM} : True := sorry\n`,
    [`${SELF_TEST_MODULES.solution}.lean`]: `theorem ${SELF_TEST_THEOREM} : True := True.intro\n`,
    [`${SELF_TEST_MODULES.mismatch}.lean`]: `theorem ${SELF_TEST_THEOREM} : 1 = 1 := rfl\n`,
  };
}

/** `comparator.json` for the self-test's judge runs: the one theorem, the
 * self-test's module names in place of `Challenge`/`Solution`. */
export function selfTestComparatorConfig(): string {
  return comparatorConfigFor([SELF_TEST_THEOREM])
    .replace(`"challenge_module": "Challenge"`, `"challenge_module": "${SELF_TEST_MODULES.challenge}"`)
    .replace(`"solution_module": "Solution"`, `"solution_module": "${SELF_TEST_MODULES.solution}"`);
}

/** The exporter's target list, composed as `planCertificate` composes the
 * record's: the Quot four, the theorem, the background axioms, the
 * primitives — every one of them in Lean core, which is what makes a
 * core-only module exportable the comparator's way. */
export function selfTestExportTargets(environment: ArchiveEnvironment): string[] {
  const facts = leanFacts(environment);
  return [
    ...facts.comparatorExportTargets.slice(0, 4),
    SELF_TEST_THEOREM,
    ...facts.backgroundAxioms,
    ...facts.comparatorExportTargets.slice(4),
  ];
}

/**
 * The matching Solution export with the theorem's proof term replaced by its
 * own statement: `Cert.selfTest : True := True`, which no kernel accepts
 * (`True : Prop` is not a proof of `True`). The export is lean4export's
 * NDJSON — name records `{"in":i,"str":{"pre":p,"str":s}}` and one
 * `{"thm":{"name":i,"type":t,"value":v,…}}` per theorem, indices into the
 * hash-consed tables — and the edit is `value := type` on the theorem's
 * record. A format the edit cannot read is an infrastructure failure: the
 * self-test must then be taught the toolchain's export before it certifies
 * anything.
 */
export function forgeKernelRejection(exportText: string, theorem: string): string {
  const names = new Map<number, string>();
  const lines = exportText.split("\n");
  let forged = 0;
  const out = lines.map((line) => {
    if (line === "") return line;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      throw infrastructureFailure("judge self-test: the Solution export is not NDJSON; the forged-export probe cannot be prepared");
    }
    if (typeof record !== "object" || record === null) return line;
    const object = record as Record<string, unknown>;
    if (typeof object.in === "number" && typeof object.str === "object" && object.str !== null) {
      const str = object.str as { pre?: unknown; str?: unknown };
      if (typeof str.pre === "number" && typeof str.str === "string") {
        const prefix = names.get(str.pre);
        names.set(object.in, prefix === undefined || prefix === "" ? str.str : `${prefix}.${str.str}`);
      }
      return line;
    }
    if (typeof object.thm === "object" && object.thm !== null) {
      const thm = object.thm as { name?: unknown; type?: unknown; value?: unknown };
      if (typeof thm.name === "number" && names.get(thm.name) === theorem && typeof thm.type === "number") {
        forged += 1;
        return JSON.stringify({ ...object, thm: { ...thm, value: thm.type } });
      }
    }
    return line;
  });
  if (forged !== 1) {
    throw infrastructureFailure(
      `judge self-test: the Solution export carries ${forged} theorem record(s) named ${theorem}, not one; ` +
        "the forged-export probe cannot be prepared for this toolchain's export format",
    );
  }
  return out.join("\n");
}

/** The sha256 of each judge binary as installed under `toolchainDir`; a
 * missing or irregular file is the archive's problem. */
export function toolDigests(toolchainDir: string): Record<JudgeTool, string> {
  const digests = {} as Record<JudgeTool, string>;
  for (const tool of JUDGE_TOOLS) {
    const filename = path.join(toolchainDir, "bin", tool);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filename);
    } catch {
      throw infrastructureFailure(`judge tool ${tool} is not installed at ${filename}`);
    }
    if (!stat.isFile()) throw infrastructureFailure(`judge tool ${filename} is not a regular file`);
    digests[tool] = sha256File(filename);
  }
  return digests;
}

/** The binaries after the judge ran, held to the digests taken before. */
export function verifyToolDigests(toolchainDir: string, before: Readonly<Record<JudgeTool, string>>): void {
  const after = toolDigests(toolchainDir);
  for (const tool of JUDGE_TOOLS) {
    if (after[tool] !== before[tool]) {
      throw infrastructureFailure(`judge tool ${tool} changed while the certificate was being judged (${before[tool]} → ${after[tool]})`);
    }
  }
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

export interface SelfTestInput {
  /** `<jobDir>/certify`: the self-test lives beside the record's runs. */
  certifyRoot: string;
  environment: ArchiveEnvironment;
  runner: ValidationRunner;
  limits: ValidationLimits;
}

/** What the probe tool (sandbox/tools/run-certify.mjs, `tool: "probe"`)
 * writes to `/out/probes.json`. */
export interface ProbeReport {
  canaryInvisible: boolean;
  networkAbsent: boolean;
  leancheckerResolves: string | null;
  projectReadOnly: boolean;
  toolchainReadOnly: boolean;
}

function fail(probe: SelfTestProbe, detail: string): never {
  throw infrastructureFailure(`judge self-test probe ${probe} failed: ${detail}`);
}

function boundary(result: { code: number; output: string; timedOut: boolean }, what: string): void {
  if (result.code === 3) throw infrastructureFailure(`judge self-test: ${what} was terminated by a signal:\n${result.output.trim()}`);
  const failure = containerBoundaryFailure(result, `judge self-test: ${what} exceeded its time limit`, `judge self-test: ${what} exceeded its memory limit`);
  if (failure !== undefined) throw failure;
}

function readExport(filename: string, what: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filename);
  } catch {
    throw infrastructureFailure(`judge self-test: the ${what} export was not produced`);
  }
  if (!stat.isFile() || stat.size === 0) throw infrastructureFailure(`judge self-test: the ${what} export is not a non-empty regular file`);
  return fs.readFileSync(filename, "utf8");
}

/** Run the self-test; returns the record's `selfTest` block or throws an
 * infrastructure failure naming the probe that gave the wrong answer. */
export async function runJudgeSelfTest(input: SelfTestInput): Promise<JudgeSelfTest> {
  const root = path.join(input.certifyRoot, "self-test");
  const projectDir = path.join(root, "project");
  const lakeDir = path.join(root, "build", ".lake");
  const outDir = path.join(root, "out");
  const planDir = path.join(root, "plan");
  for (const dir of [projectDir, lakeDir, outDir, planDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries(selfTestProjectFiles())) fs.writeFileSync(path.join(projectDir, name), content, { mode: 0o644 });
  fs.mkdirSync(path.join(projectDir, ".lake"), { recursive: true, mode: 0o700 });
  const leanThreads = { LEAN_NUM_THREADS: String(input.limits.leanThreads) };
  const run = (label: string, planPath: string, mounts: ContainerMount[]) =>
    input.runner.run({
      label,
      runtime: "judge",
      args: ["node", "/opt/lax/bin/run-certify.mjs", planPath],
      mounts,
      env: leanThreads,
      timeoutMs: input.limits.checkTimeoutMs,
      maxOutputBytes: input.limits.maxOutputBytes,
    });

  // S1: the build, like A1 — the project read-only, `.lake` writable, the plan read-only, no `/out`
  fs.writeFileSync(
    path.join(planDir, "plan.json"),
    `${JSON.stringify({ tool: "build", project: CERTIFY_PATHS.project, module: SELF_TEST_PACKAGE })}\n`,
    { mode: 0o600 },
  );
  const built = await run("certify-self-test-build", `${CERTIFY_PATHS.plan}/plan.json`, [
    { source: projectDir, target: CERTIFY_PATHS.project },
    { source: lakeDir, target: `${CERTIFY_PATHS.project}/.lake`, writable: true },
    { source: planDir, target: CERTIFY_PATHS.plan },
  ]);
  if (built.code !== 0) {
    boundary(built, "building the self-test modules");
    throw infrastructureFailure(`judge self-test: the three core-only modules did not build (exit ${built.code}):\n${built.output.trim()}`);
  }

  // S2: the three exports over the build tree read-only, like A2
  const exports = {
    challenge: `${CERTIFY_PATHS.out}/challenge.export`,
    solution: `${CERTIFY_PATHS.out}/solution.export`,
    mismatch: `${CERTIFY_PATHS.out}/mismatch.export`,
  };
  fs.writeFileSync(
    path.join(outDir, "plan.json"),
    `${JSON.stringify({
      tool: "export",
      project: CERTIFY_PATHS.project,
      targets: selfTestExportTargets(input.environment),
      leanPath: [projectLibDir(CERTIFY_PATHS.project)],
      exports: [
        { module: SELF_TEST_MODULES.challenge, output: exports.challenge },
        { module: SELF_TEST_MODULES.solution, output: exports.solution },
        { module: SELF_TEST_MODULES.mismatch, output: exports.mismatch },
      ],
    })}\n`,
    { mode: 0o600 },
  );
  const exported = await run("certify-self-test-export", `${CERTIFY_PATHS.out}/plan.json`, [
    { source: projectDir, target: CERTIFY_PATHS.project },
    { source: lakeDir, target: `${CERTIFY_PATHS.project}/.lake` },
    { source: outDir, target: CERTIFY_PATHS.out, writable: true },
  ]);
  if (exported.code !== 0) {
    boundary(exported, "exporting the self-test modules");
    throw infrastructureFailure(`judge self-test: the exports were not produced (exit ${exported.code}):\n${exported.output.trim()}`);
  }
  const challengeExport = path.join(outDir, "challenge.export");
  const solutionExport = path.join(outDir, "solution.export");
  const mismatchExport = path.join(outDir, "mismatch.export");
  readExport(challengeExport, "Challenge");
  readExport(mismatchExport, "Mismatch");
  const forgedExport = path.join(outDir, "forged.export");
  fs.writeFileSync(forgedExport, forgeKernelRejection(readExport(solutionExport, "Solution"), SELF_TEST_THEOREM), { mode: 0o600 });

  // S3–S5: the judge, like C — the project and shim read-only, each export a single read-only file
  const judgeDir = path.join(root, "judge");
  const judgeProject = path.join(judgeDir, "project");
  const shimsDir = path.join(judgeDir, "shims");
  fs.mkdirSync(judgeProject, { recursive: true, mode: 0o755 });
  fs.mkdirSync(shimsDir, { recursive: true, mode: 0o755 });
  const files = selfTestProjectFiles();
  for (const name of ["lakefile.toml", "lake-manifest.json", `${SELF_TEST_MODULES.challenge}.lean`, `${SELF_TEST_MODULES.solution}.lean`]) {
    fs.writeFileSync(path.join(judgeProject, name), files[name]!, { mode: 0o444 });
  }
  fs.writeFileSync(path.join(judgeProject, "comparator.json"), selfTestComparatorConfig(), { mode: 0o444 });
  fs.writeFileSync(path.join(shimsDir, "git"), GIT_SHIM, { mode: 0o555 });
  const judge = async (probe: SelfTestProbe, solution: string, expectation: string) => {
    const judgeOut = path.join(judgeDir, `out-${probe}`);
    fs.mkdirSync(judgeOut, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(judgeOut, "plan.json"),
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
    const result = await run(`certify-self-test-judge-${probe}`, `${CERTIFY_PATHS.out}/plan.json`, [
      { source: judgeProject, target: CERTIFY_PATHS.project },
      { source: shimsDir, target: CERTIFY_PATHS.shims },
      { source: challengeExport, target: CERTIFY_PATHS.challengeExport },
      { source: solution, target: CERTIFY_PATHS.solutionExport },
      { source: judgeOut, target: CERTIFY_PATHS.out, writable: true },
    ]);
    boundary(result, `judging the self-test (${probe})`);
    const verdict = interpretComparatorRun(result);
    const summary = verdict.kind === "failure" ? `failure: ${verdict.failure.message}` : verdict.kind === "violation" ? `${verdict.kind} ${verdict.rule}` : verdict.kind;
    if (summary !== expectation) fail(probe, `expected ${expectation}, the judge answered ${summary}:\n${result.output.trim()}`);
  };
  await judge("comparator-accepts", solutionExport, "certified");
  await judge("comparator-rejects-mismatch", mismatchExport, "violation statement-mismatch");
  await judge("kernel-rejects-forged", forgedExport, "violation kernel-rejected");

  // S6: the confinement, from inside the judge runtime
  const canaryJob = path.join(root, `canary-${randomUUID()}`);
  const canaryTmp = path.join(os.tmpdir(), `lax-canary-${randomUUID()}`);
  fs.writeFileSync(canaryJob, "canary\n", { mode: 0o600 });
  fs.writeFileSync(canaryTmp, "canary\n", { mode: 0o600 });
  const probeOut = path.join(root, "probe");
  fs.mkdirSync(probeOut, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(
      path.join(probeOut, "plan.json"),
      `${JSON.stringify({
        tool: "probe",
        project: CERTIFY_PATHS.project,
        shims: CERTIFY_PATHS.shims,
        absent: [canaryJob, canaryTmp],
        leanchecker: `${RUNTIME_PATHS.toolchain}/bin/leanchecker`,
        report: `${CERTIFY_PATHS.out}/probes.json`,
      })}\n`,
      { mode: 0o600 },
    );
    const probed = await run("certify-self-test-probe", `${CERTIFY_PATHS.out}/plan.json`, [
      { source: judgeProject, target: CERTIFY_PATHS.project },
      { source: shimsDir, target: CERTIFY_PATHS.shims },
      { source: probeOut, target: CERTIFY_PATHS.out, writable: true },
    ]);
    if (probed.code !== 0) {
      boundary(probed, "probing the judge's confinement");
      throw infrastructureFailure(`judge self-test: the confinement probe did not run (exit ${probed.code}):\n${probed.output.trim()}`);
    }
    let report: ProbeReport;
    try {
      report = JSON.parse(fs.readFileSync(path.join(probeOut, "probes.json"), "utf8")) as ProbeReport;
    } catch (error) {
      throw infrastructureFailure(`judge self-test: the confinement probe left no readable report: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (report.canaryInvisible !== true) fail("canary-invisible", "a file the host wrote outside the mounts is visible inside the judge");
    if (report.networkAbsent !== true) fail("network-absent", "the judge has a network interface beyond lo");
    const expectedLeanchecker = `${RUNTIME_PATHS.toolchain}/bin/leanchecker`;
    if (report.leancheckerResolves !== expectedLeanchecker) {
      fail("leanchecker-resolves", `\`which leanchecker\` resolves to ${report.leancheckerResolves ?? "nothing"}, not ${expectedLeanchecker}`);
    }
    if (report.projectReadOnly !== true) fail("project-read-only", "the judge's project directory is writable");
    if (report.toolchainReadOnly !== true) fail("toolchain-read-only", "the toolchain directory is writable");
  } finally {
    fs.rmSync(canaryJob, { force: true });
    fs.rmSync(canaryTmp, { force: true });
  }
  return { passed: true, probes: [...SELF_TEST_PROBES] };
}
