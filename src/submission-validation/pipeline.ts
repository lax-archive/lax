import fs from "node:fs";
import path from "node:path";
import { ArchiveSnapshot, fetchArchiveSnapshot } from "./archive/snapshot.js";
import { materializeDependencyCaptures } from "./captures/materialize.js";
import { capturePackage, describeLocalCapture, sealCapture } from "./captures/seal.js";
import { configuredRuntime, DEFAULT_LIMITS, type ValidationLimits } from "./config.js";
import type {
  PaperOutput,
  ResolvedDependency,
  ResolutionResult,
  StaticPaper,
  StaticResult,
  ValidationFinding,
  ValidationReport,
  ValidationRequest,
  ValidationRuntimeIdentity,
  ValidationScope,
} from "./contracts.js";
import { commitTimestamp, laxmarkDirectory } from "./host/paper.js";
import { warmDir } from "./host/warmstore.js";
import { FindingCollector } from "./findings.js";
import type { ValidationOutcome } from "./outputs.js";
import { containerPaperCompiler } from "./paper/container.js";
import { joinPaperMarks } from "./paper/join.js";
import { capturePaperSources, runPaperPhase, type PaperPhaseResult } from "./paper/phase.js";
import { compileConcepts, compileProofs } from "./phases/compile.js";
import { emitBuildOutput } from "./phases/emit.js";
import { judgeInspection } from "./phases/inspect.js";
import { runInspector } from "./phases/inspect-runner.js";
import {
  installOwnConceptCapture,
  provisionWorkspace,
  type ProvisionedWorkspace,
} from "./phases/provision.js";
import { replayPackage } from "./phases/replay.js";
import { runResolution } from "./phases/resolution.js";
import { runStaticValidation } from "./phases/static.js";
import { safeTranscript } from "../shared/comment-format.js";
import { Profiler } from "../shared/profile.js";
import { ContainerRunner, type ValidationRunner } from "./sandbox/container.js";
import { assertWorkspaceWithinLimit } from "./sandbox/workspace-limit.js";
import { fetchSource, type FetchedSource } from "./source/fetch.js";

export interface ValidationOptions {
  /** A local build supplies already-available source and Archive data. */
  local?: { fetched: FetchedSource; archive: ArchiveSnapshot };
  /** The trusted workflow always replays; local authoring keeps it opt-in. */
  replay?: boolean;
  /** Local authoring does not need the publishable artifact tar. */
  sealCapture?: boolean;
  /** Fast local iteration may stop after one package; workflows always use both. */
  scope?: ValidationScope;
  /** Local --build-from-source supplies the exact image it just built. */
  runtime?: ValidationRuntimeIdentity;
  /**
   * Stop after dependency resolution: the trusted workflow's static gate,
   * which runs the cheap host-side phases before the job pays for the cache
   * restore, the host provisioning, and the image pull. The gate threads no
   * state to the full run — that run re-executes fetch, static validation,
   * and resolution from scratch (the fetch is by pinned commit, the phases
   * are milliseconds).
   */
  stopAfter?: "resolution";
  /**
   * How phase commands execute. Defaults to the hardened ContainerRunner over
   * the configured runtime image — the trusted workflow never sets this.
   * Tests inject in-process fakes here.
   */
  runner?: ValidationRunner;
  /** Local presentation hook. Trusted workflow output remains unchanged. */
  onPhase?: (event: { name: string; state: "start" | "complete"; durationMs?: number }) => void;
  /**
   * Collects the span tree. The caller owns it so the timings survive the
   * early returns that report a failed validation.
   */
  profiler?: Profiler;
}

interface ReportState {
  request: ValidationRequest;
  runtime: ValidationRuntimeIdentity;
  dependencies: ResolvedDependency[];
  warnings: ValidationFinding[];
  violations: ValidationFinding[];
  /**
   * The paper's independent piece, running beside the Lean chain from right
   * after resolution (paper-plan.md, "Pipeline placement"). Never rejects.
   * Joined exactly once — by joinPaper — whatever the Lean side does, so
   * both findings reach the author and the job directory outlives latexmk.
   */
  paperRun?: Promise<PaperPhaseResult>;
  paperJoined?: PaperPhaseResult;
}

interface PreparedValidation extends ReportState {
  jobDir: string;
  options: ValidationOptions;
  limits: ValidationLimits;
  runner: ValidationRunner;
  scope: ValidationScope;
  fetched: FetchedSource;
  archive: ArchiveSnapshot;
  staticResult: StaticResult;
  resolution: ResolutionResult;
  dependencyRoot: string;
  /** host path of the warm workspace the sandbox mounts read-only */
  warmWs: string;
  captureRoot: string;
  phase<T>(name: string, operation: () => Promise<T> | T): Promise<T>;
}

type CompiledValidation = PreparedValidation;

type Preparation = { state: PreparedValidation } | { report: ValidationReport };

/**
 * Run every phase — Compile, Replay, Inspect — sequentially in one process.
 * The trusted workflow's single validation job and local builds share this
 * entry point; there is no staged resume any more.
 */
export async function validateSubmission(
  request: ValidationRequest,
  jobDir: string,
  options: ValidationOptions = {},
): Promise<ValidationOutcome> {
  const prepared = await prepareValidation(request, jobDir, options);
  if ("report" in prepared) return prepared.report;
  const state = prepared.state;
  // The gate stops here: nothing has compiled, so a passing report carries
  // only what fetch, static validation, and resolution collected.
  if (options.stopAfter === "resolution") return report(state, true);
  const outcome = await leanStages(state);
  // A Lean failure still waits for the paper: its findings belong in the
  // same report, and its container must be gone before the job directory is.
  await joinPaper(state);
  return outcome.ok ? outcome : report(state, false);
}

async function leanStages(state: PreparedValidation): Promise<ValidationOutcome> {
  const compileFailure = await compileStage(state);
  if (compileFailure !== undefined) return compileFailure;
  if (state.options.replay !== false) {
    const replayFailure = await replayStage(state);
    if (replayFailure !== undefined) return replayFailure;
  }
  return inspectStage(state);
}

/** Undefined once every package of the scope is compiled and captured. */
async function compileStage(state: PreparedValidation): Promise<ValidationReport | undefined> {
  const request = state.request;

  try {
    await state.phase("dependency provisioning", () =>
      materializeDependencyCaptures(
        state.dependencies,
        state.jobDir,
        state.runner,
        state.limits,
      ));
  } catch (error) {
    return fail(state, "provision", "dependency-capture", error);
  }

  fs.mkdirSync(state.captureRoot, { recursive: true, mode: 0o700 });
  let conceptWorkspace: ProvisionedWorkspace;
  try {
    conceptWorkspace = await state.phase("provision concepts", () =>
      provisionWorkspace(
        "concepts",
        state.fetched,
        request.source.folder,
        state.staticResult,
        state.resolution,
        state.jobDir,
        state.warmWs,
      ));
    await state.phase("compile concepts", () =>
      compileConcepts(conceptWorkspace, state.dependencyRoot, state.runner, state.limits));
    await state.phase("capture concepts", () => capturePackage(
      "concepts",
      state.fetched.submissionRoot,
      conceptWorkspace.libraries.concepts,
      conceptWorkspace.manifests.concepts,
      state.staticResult.concepts!.inventory,
      state.captureRoot,
    ));
  } catch (error) {
    return fail(state, "compile-concepts", "compile", error);
  }

  if (state.scope !== "concepts") {
    try {
      const proofWorkspace: ProvisionedWorkspace = await state.phase("provision proofs", () =>
        provisionWorkspace(
          "proofs",
          state.fetched,
          request.source.folder,
          state.staticResult,
          state.resolution,
          state.jobDir,
          state.warmWs,
        ));
      await state.phase("install concept capture", () =>
        installOwnConceptCapture(proofWorkspace, state.captureRoot));
      await state.phase("compile proofs", () =>
        compileProofs(proofWorkspace, state.dependencyRoot, state.runner, state.limits));
      await state.phase("capture proofs", () => capturePackage(
        "proofs",
        state.fetched.submissionRoot,
        proofWorkspace.libraries.proofs,
        proofWorkspace.manifests.proofs,
        state.staticResult.proofs!.inventory,
        state.captureRoot,
      ));
    } catch (error) {
      return fail(state, "compile-proofs", "compile", error);
    }
  }

  return undefined;
}

async function replayStage(state: CompiledValidation): Promise<ValidationReport | undefined> {
  try {
    // Each checker receives the full container budget, so keep the two
    // heavyweight replays from stacking their limits against the host.
    const replay: Array<() => Promise<void>> = [];
    if (state.scope !== "proofs") replay.push(() => state.phase("replay concepts", () =>
      replayPackage(
        "concepts",
        state.captureRoot,
        state.staticResult.concepts!.inventory,
        state.resolution,
        state.jobDir,
        state.dependencyRoot,
        state.runner,
        state.limits,
      )));
    if (state.scope !== "concepts") replay.push(() => state.phase("replay proofs", () =>
      replayPackage(
        "proofs",
        state.captureRoot,
        state.staticResult.proofs!.inventory,
        state.resolution,
        state.jobDir,
        state.dependencyRoot,
        state.runner,
        state.limits,
      )));
    for (const check of replay) await check();
    return undefined;
  } catch (error) {
    return fail(state, "replay", "kernel-replay", error);
  }
}

async function inspectStage(state: CompiledValidation): Promise<ValidationOutcome> {
  let conceptReport;
  let proofReport;
  try {
    // Inspection has the same heavyweight container budget as replay.
    conceptReport = await state.phase("inspect concepts", () => runInspector(
      "concepts",
      state.captureRoot,
      state.staticResult.concepts!.inventory,
      state.resolution,
      state.jobDir,
      state.dependencyRoot,
      state.runner,
      state.limits,
    ));
    proofReport = state.scope === "concepts" ? undefined : await state.phase("inspect proofs", () => runInspector(
      "proofs",
      state.captureRoot,
      state.staticResult.proofs!.inventory,
      state.resolution,
      state.jobDir,
      state.dependencyRoot,
      state.runner,
      state.limits,
    ));
  } catch (error) {
    return fail(state, "inspect", "inspector", error);
  }
  const inspection = await state.phase("judge inspection", () => judgeInspection(
    conceptReport,
    proofReport,
    state.staticResult.concepts!.inventory,
    state.scope === "concepts" ? undefined : state.staticResult.proofs!.inventory,
    state.resolution,
    state.scope,
  ));
  state.warnings.push(...inspection.findings.warnings);
  state.violations.push(...inspection.findings.violations);
  if (inspection.findings.failed) return report(state, false);

  if (state.scope !== "both") return report(state, true);

  // The join: the paper's marks need the ids Inspect just produced.
  const paper = await joinPaper(state);
  if (paper?.findings.failed === true) return report(state, false);

  try {
    let paperOutput: PaperOutput | undefined;
    if (paper !== undefined) {
      // The trusted path never skips a declared paper; a result with neither
      // a compiled PDF nor a violation is a pipeline bug.
      if (paper.compiled === undefined) throw new Error("the paper phase produced neither a PDF nor a finding");
      const compiled = paper.compiled;
      const joined = await state.phase("resolve marks", () =>
        joinPaperMarks(compiled, state.staticResult, state.resolution, state.archive, inspection.result));
      for (const problem of joined.problems) state.violations.push({ phase: "paper", rule: "mark-id", message: problem });
      if (joined.output === undefined) return report(state, false);
      paperOutput = joined.output;
      capturePaperSources(state.staticResult.paper!, state.fetched.submissionRoot, state.captureRoot);
    }
    const capture = await state.phase("emit", async () =>
      state.options.sealCapture === false
        ? describeLocalCapture(state.captureRoot, state.request.source.commit, state.runtime)
        : await sealCapture(
            state.captureRoot,
            path.join(path.dirname(state.jobDir), "capture.tar"),
            state.request.source.commit,
            state.runtime,
            state.runner,
            state.limits,
          ));
    const buildOutput = emitBuildOutput(
      state.fetched.submissionRoot,
      state.staticResult,
      inspection.result,
      capture,
      paperOutput,
    );
    return {
      ...report(state, true),
      buildOutput,
      capture,
      ...(paper?.compiled === undefined ? {} : { paperPdfPath: paper.compiled.pdfPath }),
    };
  } catch (error) {
    return fail(state, "emit", "emit", error);
  }
}

/** Await the paper once and fold its findings into the report state. */
async function joinPaper(state: ReportState): Promise<PaperPhaseResult | undefined> {
  if (state.paperRun === undefined) return undefined;
  if (state.paperJoined === undefined) {
    state.paperJoined = await state.paperRun;
    state.warnings.push(...state.paperJoined.findings.warnings);
    state.violations.push(...state.paperJoined.findings.violations);
  }
  return state.paperJoined;
}

/**
 * Start the paper's independent piece: copy and rewrite, pull the TeX image,
 * compile, read the destinations back, count-check. Everything the phase
 * does not turn into a finding itself — a missing laxmark.sty, an image that
 * will not pull, a workspace over its cap — becomes one here, so the promise
 * never rejects while nothing is awaiting it.
 */
function startPaperPhase(
  paper: StaticPaper,
  state: {
    request: ValidationRequest;
    fetched: FetchedSource;
    jobDir: string;
    limits: ValidationLimits;
    runner: ValidationRunner;
    phase: PreparedValidation["phase"];
  },
): Promise<PaperPhaseResult> {
  const asFinding = (error: unknown): PaperPhaseResult => {
    const findings = new FindingCollector("paper");
    findings.violate("runtime", safeError(error));
    return { findings };
  };
  return state
    .phase("paper", async (): Promise<PaperPhaseResult> => {
      try {
        return await runPaperPhase({
          paper,
          submissionRoot: state.fetched.submissionRoot,
          jobDir: state.jobDir,
          sourceDateEpoch: commitTimestamp(state.fetched.repositoryRoot, state.request.source.commit),
          limits: state.limits,
          compile: containerPaperCompiler(state.runner, state.limits, laxmarkDirectory()),
        });
      } catch (error) {
        return asFinding(error);
      }
    })
    .catch(asFinding);
}

async function prepareValidation(
  request: ValidationRequest,
  jobDir: string,
  options: ValidationOptions,
): Promise<Preparation> {
  const runtime = options.runtime ?? configuredRuntime();
  const limits = DEFAULT_LIMITS;
  const profiler = options.profiler ?? new Profiler();
  const runner = options.runner ?? new ContainerRunner(runtime, limits, jobDir, profiler);
  const scope = options.scope ?? "both";
  const warnings: ValidationFinding[] = [];
  const violations: ValidationFinding[] = [];
  let dependencies: ResolvedDependency[] = [];
  const phase = async <T>(name: string, operation: () => Promise<T> | T): Promise<T> => {
    options.onPhase?.({ name, state: "start" });
    const started = performance.now();
    try {
      return await profiler.span(name, async () => {
        const result = await operation();
        assertWorkspaceWithinLimit(jobDir, limits);
        return result;
      });
    } finally {
      options.onPhase?.({ name, state: "complete", durationMs: performance.now() - started });
    }
  };
  const base = (): ReportState => ({ request, runtime, dependencies, warnings, violations });

  let fetched: FetchedSource;
  let archive: ArchiveSnapshot;
  try {
    if (options.local !== undefined) {
      ({ fetched, archive } = options.local);
    } else {
      [fetched, archive] = await Promise.all([
        fetchSource(request.source, jobDir, limits),
        fetchArchiveSnapshot(request.archiveSha, jobDir, limits),
      ]);
    }
  } catch (error) {
    return { report: fail(base(), "source", "fetch", error) };
  }

  const staticCheck = await phase("static validation", () =>
    runStaticValidation(request, fetched.submissionRoot, runtime));
  warnings.push(...staticCheck.findings.warnings);
  violations.push(...staticCheck.findings.violations);
  if (staticCheck.findings.failed || staticCheck.result.concepts === undefined || staticCheck.result.proofs === undefined)
    return { report: report(base(), false) };

  const resolution = await phase("dependency resolution", () =>
    runResolution(request, staticCheck.result, archive, runtime));
  warnings.push(...resolution.findings.warnings);
  violations.push(...resolution.findings.violations);
  dependencies = resolution.result.all;
  if (resolution.findings.failed) return { report: report(base(), false) };

  // Last of the preparation, and skipped entirely by the gate: making the
  // runtime available costs an image pull and a provisioned host, which
  // spec.md's Static → Resolution → Provision order spends only on a
  // submission that has already passed the millisecond-level phases.
  let paperRun: Promise<PaperPhaseResult> | undefined;
  if (options.stopAfter !== "resolution") {
    // The paper needs no Lean, so it starts here — before the runtime is even
    // verified — and overlaps the whole Lean chain.
    if (staticCheck.result.paper !== undefined && scope === "both") {
      paperRun = startPaperPhase(staticCheck.result.paper, { request, fetched, jobDir, limits, runner, phase });
    }
    try {
      await phase("validation runtime", () => runner.verifyRuntime());
    } catch (error) {
      const state = { ...base(), paperRun };
      state.violations.push({ phase: "provision", rule: "runtime", message: safeError(error) });
      await joinPaper(state);
      return { report: report(state, false) };
    }
  }

  return {
    state: {
      ...base(),
      jobDir,
      options,
      limits,
      runner,
      scope,
      fetched,
      archive,
      staticResult: staticCheck.result,
      resolution: resolution.result,
      dependencyRoot: path.join(jobDir, "dependencies"),
      // the same pin-keyed warm workspace verifyRuntime asserted ready and
      // the runner mounts; provisioning reads its locked manifest on the host
      warmWs: warmDir(),
      captureRoot: path.join(jobDir, "capture"),
      phase,
      ...(paperRun === undefined ? {} : { paperRun }),
    },
  };
}

function fail(
  state: ReportState,
  phase: ValidationFinding["phase"],
  rule: string,
  error: unknown,
): ValidationReport {
  state.violations.push({ phase, rule, message: safeError(error) });
  return report(state, false);
}

function report(state: ReportState, ok: boolean): ValidationReport {
  return {
    reportVersion: 1,
    ok,
    request: state.request,
    runtime: state.runtime,
    dependencies: state.dependencies,
    warnings: [...state.warnings],
    violations: [...state.violations],
  };
}

/**
 * Keep the shape of what failed. A compile, replay, or inspector failure
 * *is* its transcript, so line structure survives into the report and from
 * there into the issue comment and the author's terminal (comment-format.ts
 * renders it); only control characters are dropped. Over-long transcripts
 * keep their tail — the head of a `lake build` log is module names.
 */
function safeError(error: unknown): string {
  return safeTranscript(error instanceof Error ? error.message : String(error), 8_000);
}
