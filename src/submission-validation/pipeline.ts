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
  ValidationFailure,
  ValidationFinding,
  ValidationReport,
  ValidationRequest,
  ValidationRuntimeIdentity,
  ValidationScope,
} from "./contracts.js";
import {
  asPipelineFailure,
  infrastructureFailure,
  looksRetryable,
  type PipelineFailure,
  type PipelineFailureKind,
  submittedSourceFailure,
} from "./failures.js";
import { commitTimestamp, laxmarkDirectory } from "./host/paper.js";
import { warmDir } from "./host/warmstore.js";
import { FindingCollector } from "./findings.js";
import type { ValidationOutcome } from "./outputs.js";
import { containerPaperCompiler } from "./paper/container.js";
import { joinPaperMarks } from "./paper/join.js";
import { capturePaperSources, runPaperPhase, type PaperPhaseResult } from "./paper/phase.js";
import { containerWebDeriver } from "./paper/web-container.js";
import type { WebDeriver } from "./paper/web.js";
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
  /**
   * The paper web derivation seam (paper-web-plan.md stage 3), mirroring the
   * runner seam: the trusted workflow never sets it and gets the
   * container-backed deriver (paper/web-container.ts) over `runner`; tests
   * inject fakes here. Non-blocking by construction either way — a deriver
   * only ever contributes `web-*` warnings.
   */
  webDeriver?: WebDeriver;
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
  failure?: ValidationFailure;
  /**
   * The paper's independent piece, running beside the Lean chain from right
   * after resolution (paper-plan.md, "Pipeline placement"). Never rejects.
   * Joined exactly once — by joinPaper — whatever the Lean side does, so
   * both findings reach the author and the job directory outlives latexmk.
   */
  paperRun?: Promise<PaperRun>;
  paperJoined?: PaperRun;
}

/**
 * What the paper phase hands back: its findings, and — when it stopped on
 * something that is not a verdict on the paper at all — the classified
 * failure it stopped on, for joinPaper to give the report.
 */
interface PaperRun extends PaperPhaseResult {
  failure?: PipelineFailure;
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
    return fail(state, "provision", "dependency-capture", error, "infrastructure", looksRetryable(error));
  }

  try {
    fs.mkdirSync(state.captureRoot, { recursive: true, mode: 0o700 });
  } catch (error) {
    return fail(state, "provision", "capture-workspace", error);
  }
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
  } catch (error) {
    return fail(state, "provision", "concept-workspace", error);
  }
  try {
    await state.phase("compile concepts", () =>
      compileConcepts(conceptWorkspace, state.dependencyRoot, state.runner, state.limits));
  } catch (error) {
    return fail(state, "compile-concepts", "compile", error);
  }
  try {
    await state.phase("capture concepts", () => capturePackage(
      "concepts",
      state.fetched.submissionRoot,
      conceptWorkspace.libraries.concepts,
      conceptWorkspace.manifests.concepts,
      state.staticResult.concepts!.inventory,
      state.captureRoot,
    ));
  } catch (error) {
    return fail(state, "compile-concepts", "capture", error);
  }

  if (state.scope !== "concepts") {
    let proofWorkspace: ProvisionedWorkspace;
    try {
      proofWorkspace = await state.phase("provision proofs", () =>
        provisionWorkspace(
          "proofs",
          state.fetched,
          request.source.folder,
          state.staticResult,
          state.resolution,
          state.jobDir,
          state.warmWs,
        ));
    } catch (error) {
      return fail(state, "provision", "proof-workspace", error);
    }
    try {
      await state.phase("install concept capture", () =>
        installOwnConceptCapture(proofWorkspace, state.captureRoot));
    } catch (error) {
      return fail(state, "provision", "concept-capture", error);
    }
    try {
      await state.phase("compile proofs", () =>
        compileProofs(proofWorkspace, state.dependencyRoot, state.runner, state.limits));
    } catch (error) {
      return fail(state, "compile-proofs", "compile", error);
    }
    try {
      await state.phase("capture proofs", () => capturePackage(
        "proofs",
        state.fetched.submissionRoot,
        proofWorkspace.libraries.proofs,
        proofWorkspace.manifests.proofs,
        state.staticResult.proofs!.inventory,
        state.captureRoot,
      ));
    } catch (error) {
      return fail(state, "compile-proofs", "capture", error);
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
  let inspection;
  try {
    inspection = await state.phase("judge inspection", () => judgeInspection(
      conceptReport,
      proofReport,
      state.staticResult.concepts!.inventory,
      state.scope === "concepts" ? undefined : state.staticResult.proofs!.inventory,
      state.resolution,
      state.scope,
    ));
  } catch (error) {
    return fail(state, "inspect", "judge", error);
  }
  state.warnings.push(...inspection.findings.warnings);
  state.violations.push(...inspection.findings.violations);
  if (inspection.findings.failed) return report(state, false);

  if (state.scope !== "both") return report(state, true);

  // The join: the paper's marks need the ids Inspect just produced.
  const paper = await joinPaper(state);
  if (paper !== undefined && (paper.findings.failed || paper.failure !== undefined))
    return report(state, false);

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
      ...(paper?.compiled?.web === undefined ? {} : { paperWebPath: paper.compiled.web.bundlePath }),
    };
  } catch (error) {
    return fail(state, "emit", "emit", error);
  }
}

/**
 * Await the paper once and fold what it produced into the report state: its
 * findings when it judged the paper, and the outcome-ownership decision
 * below when it never got that far.
 */
async function joinPaper(state: ReportState): Promise<PaperRun | undefined> {
  if (state.paperRun === undefined) return undefined;
  if (state.paperJoined === undefined) {
    const paper = await state.paperRun;
    state.paperJoined = paper;
    // A Lean side that already failed operationally keeps precedence: one
    // report carries one reason why no verdict was reached.
    if (state.failure === undefined) {
      if (paper.failure === undefined) {
        state.violations.push(...paper.findings.violations);
      } else if (state.violations.length === 0) {
        // The paper phase reached no verdict and neither did anything else:
        // the report says the archive could not compile the paper — an
        // operational outcome, retryable where the fault was — instead of
        // telling the author their paper is broken.
        recordFailure(state, "paper", "runtime", paper.failure);
      } else {
        // A report is either a verdict on the submission or an operational
        // failure, never both (writeValidationOutputs refuses the mixture),
        // and the Lean side has already given the verdict this submission is
        // refused on. The archive's own fault still belongs in the report, so
        // it goes where it can stand beside a verdict — a warning that blames
        // nobody's paper.
        paper.findings.warn(
          "runtime",
          `the archive could not compile the paper this run: ${safeError(paper.failure)}` +
            "; the paper was not judged, and is compiled again on the next attempt",
        );
      }
    }
    state.warnings.push(...paper.findings.warnings);
  }
  return state.paperJoined;
}

/**
 * Start the paper's independent piece: copy and rewrite, pull the TeX image,
 * compile, read the destinations back, count-check. Nothing may reject while
 * nothing is awaiting the promise, so everything the phase does not turn into
 * a finding itself is caught here — but catching it is not the same as
 * blaming the author for it. A TeX image that will not pull, a laxmark.sty
 * the copy could not read, a job workspace over its cap: none of those is a
 * statement about the submitted paper, so they keep the ownership their
 * thrower gave them and default to the pipeline's usual guess for an
 * unclassified error — the archive's own, not the author's.
 */
function startPaperPhase(
  paper: StaticPaper,
  state: {
    request: ValidationRequest;
    fetched: FetchedSource;
    jobDir: string;
    limits: ValidationLimits;
    runner: ValidationRunner;
    webDeriver: WebDeriver;
    phase: PreparedValidation["phase"];
  },
): Promise<PaperRun> {
  const owned = (error: unknown): PaperRun => ({
    findings: new FindingCollector("paper"),
    failure: asPipelineFailure(error, "infrastructure", looksRetryable(error)),
  });
  return state
    .phase("paper", async (): Promise<PaperRun> => {
      try {
        return await runPaperPhase({
          paper,
          submissionRoot: state.fetched.submissionRoot,
          jobDir: state.jobDir,
          sourceDateEpoch: commitTimestamp(state.fetched.repositoryRoot, state.request.source.commit),
          limits: state.limits,
          compile: containerPaperCompiler(state.runner, state.limits, laxmarkDirectory()),
          deriveWeb: state.webDeriver,
        });
      } catch (error) {
        return owned(error);
      }
    })
    // The phase wrapper's own throw — the workspace cap it asserts after the
    // operation returns — is classified here too, and lands like the rest.
    .catch(owned);
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
  if (options.local !== undefined) {
    ({ fetched, archive } = options.local);
  } else {
    const [sourceResult, archiveResult] = await Promise.allSettled([
      fetchSource(request.source, jobDir, limits),
      fetchArchiveSnapshot(request.archiveSha, jobDir, limits),
    ]);
    if (archiveResult.status === "rejected") {
      const error = archiveResult.reason;
      return {
        report: fail(
          base(),
          "source",
          "archive-snapshot",
          infrastructureFailure(
            error instanceof Error ? error.message : String(error),
            looksRetryable(error),
          ),
        ),
      };
    }
    if (sourceResult.status === "rejected") {
      return { report: fail(base(), "source", "fetch", submittedSourceFailure(sourceResult.reason)) };
    }
    fetched = sourceResult.value;
    archive = archiveResult.value;
  }

  let staticCheck;
  try {
    staticCheck = await phase("static validation", () =>
      runStaticValidation(request, fetched.submissionRoot, runtime));
  } catch (error) {
    return { report: fail(base(), "static", "validator", error) };
  }
  warnings.push(...staticCheck.findings.warnings);
  violations.push(...staticCheck.findings.violations);
  if (staticCheck.findings.failed || staticCheck.result.concepts === undefined || staticCheck.result.proofs === undefined)
    return { report: report(base(), false) };

  let resolution;
  try {
    resolution = await phase("dependency resolution", () =>
      runResolution(request, staticCheck.result, archive, runtime));
  } catch (error) {
    return { report: fail(base(), "resolution", "resolver", error) };
  }
  warnings.push(...resolution.findings.warnings);
  violations.push(...resolution.findings.violations);
  dependencies = resolution.result.all;
  if (resolution.findings.failed) return { report: report(base(), false) };

  // Last of the preparation, and skipped entirely by the gate: making the
  // runtime available costs an image pull and a provisioned host, which
  // spec.md's Static → Resolution → Provision order spends only on a
  // submission that has already passed the millisecond-level phases.
  let paperRun: Promise<PaperRun> | undefined;
  if (options.stopAfter !== "resolution") {
    // The paper needs no Lean, so it starts here — before the runtime is even
    // verified — and overlaps the whole Lean chain. The web derivation rides
    // inside it: the container-backed deriver by default (the trusted
    // workflow sets no options), a test's fake through the seam.
    if (staticCheck.result.paper !== undefined && scope === "both") {
      const webDeriver = options.webDeriver ?? containerWebDeriver(runner);
      paperRun = startPaperPhase(staticCheck.result.paper, { request, fetched, jobDir, limits, runner, webDeriver, phase });
    }
    try {
      await phase("validation runtime", () => runner.verifyRuntime());
    } catch (error) {
      const state = { ...base(), paperRun };
      fail(state, "provision", "runtime", error, "infrastructure", looksRetryable(error));
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
  fallbackKind: PipelineFailureKind = "infrastructure",
  retryable = false,
): ValidationReport {
  recordFailure(state, phase, rule, error, fallbackKind, retryable);
  return report(state, false);
}

/**
 * The ownership decision itself, for the callers that have no report to
 * return yet: a submission-kind failure is a finding against the author's
 * content, and everything else — capacity, the archive's own machinery — is
 * the report's failure, which says no verdict was reached at all.
 */
function recordFailure(
  state: ReportState,
  phase: ValidationFinding["phase"],
  rule: string,
  error: unknown,
  fallbackKind: PipelineFailureKind = "infrastructure",
  retryable = false,
): void {
  const failure = asPipelineFailure(error, fallbackKind, retryable);
  const message = safeError(failure);
  if (failure.kind === "submission") {
    state.violations.push({ phase, rule, message });
  } else {
    state.failure = { kind: failure.kind, retryable: failure.retryable, phase, rule, message };
  }
}

function report(state: ReportState, ok: boolean): ValidationReport {
  const validationReport: ValidationReport = {
    reportVersion: 1,
    ok,
    request: state.request,
    runtime: state.runtime,
    dependencies: state.dependencies,
    warnings: [...state.warnings],
    violations: [...state.violations],
  };
  if (state.failure !== undefined) validationReport.failure = state.failure;
  return validationReport;
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
