import fs from "node:fs";
import path from "node:path";
import { ArchiveSnapshot, fetchArchiveSnapshot } from "./archive/snapshot.js";
import { materializeDependencyCaptures } from "./captures/materialize.js";
import { capturePackage, describeLocalCapture, sealCapture } from "./captures/seal.js";
import { configuredRuntime, DEFAULT_LIMITS, type ValidationLimits } from "./config.js";
import type {
  ResolvedDependency,
  ResolutionResult,
  StaticResult,
  ValidationFinding,
  ValidationReport,
  ValidationRequest,
  ValidationRuntimeIdentity,
  ValidationScope,
} from "./contracts.js";
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
import { ContainerRunner } from "./sandbox/container.js";
import { assertWorkspaceWithinLimit } from "./sandbox/workspace-limit.js";
import { containedDirectory, fetchSource, type FetchedSource } from "./source/fetch.js";

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
  /** Local presentation hook. Trusted workflow output remains unchanged. */
  onPhase?: (event: { name: string; state: "start" | "complete"; durationMs?: number }) => void;
}

interface ReportState {
  request: ValidationRequest;
  runtime: ValidationRuntimeIdentity;
  dependencies: ResolvedDependency[];
  warnings: ValidationFinding[];
  violations: ValidationFinding[];
}

interface PreparedValidation extends ReportState {
  jobDir: string;
  options: ValidationOptions;
  limits: ValidationLimits;
  runner: ContainerRunner;
  scope: ValidationScope;
  fetched: FetchedSource;
  staticResult: StaticResult;
  resolution: ResolutionResult;
  siblings: ReturnType<typeof runResolution>["siblings"];
  dependencyRoot: string;
  captureRoot: string;
  phase<T>(name: string, operation: () => Promise<T> | T): Promise<T>;
}

type CompiledValidation = PreparedValidation;

type Preparation = { state: PreparedValidation } | { report: ValidationReport };
type Compilation = { state: CompiledValidation } | { report: ValidationReport };

/** Run all stages in one process for local builds and direct library callers. */
export async function validateSubmission(
  request: ValidationRequest,
  jobDir: string,
  options: ValidationOptions = {},
): Promise<ValidationReport> {
  const compiled = await compileStage(request, jobDir, options, false);
  if ("report" in compiled) return compiled.report;
  if (options.replay !== false) {
    const replayFailure = await replayStage(compiled.state);
    if (replayFailure !== undefined) return replayFailure;
  }
  return inspectStage(compiled.state);
}

/** Compile and retain the job workspace for a later workflow step. */
export async function compileSubmission(
  request: ValidationRequest,
  jobDir: string,
  options: ValidationOptions = {},
): Promise<ValidationReport | undefined> {
  const compiled = await compileStage(request, jobDir, options, false);
  return "report" in compiled ? compiled.report : undefined;
}

/** Resume a successful Compile workspace and kernel-replay its artifacts. */
export async function replaySubmission(
  request: ValidationRequest,
  jobDir: string,
  options: ValidationOptions = {},
): Promise<ValidationReport | undefined> {
  const compiled = await compileStage(request, jobDir, options, true, "replay");
  if ("report" in compiled) return compiled.report;
  return replayStage(compiled.state);
}

/** Resume a compiled (or sequentially replayed) workspace and inspect it. */
export async function inspectSubmission(
  request: ValidationRequest,
  jobDir: string,
  options: ValidationOptions = {},
): Promise<ValidationReport> {
  const compiled = await compileStage(request, jobDir, options, true, "inspect");
  if ("report" in compiled) return compiled.report;
  return inspectStage(compiled.state);
}

async function compileStage(
  request: ValidationRequest,
  jobDir: string,
  options: ValidationOptions,
  resume: boolean,
  resumePhase: "replay" | "inspect" = "replay",
): Promise<Compilation> {
  const prepared = await prepareValidation(request, jobDir, options, resume);
  if ("report" in prepared) return prepared;
  const state = prepared.state;

  if (resume) {
    try {
      capturedManifests(state.captureRoot, state.scope);
      return { state };
    } catch (error) {
      return { report: fail(state, resumePhase, "stage-workspace", error) };
    }
  }

  try {
    await state.phase("dependency provisioning", () =>
      materializeDependencyCaptures(
        state.dependencies,
        state.jobDir,
        state.runner,
        state.limits,
      ));
  } catch (error) {
    return { report: fail(state, "provision", "dependency-capture", error) };
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
        state.siblings,
        state.jobDir,
        state.dependencyRoot,
        state.runner,
        state.limits,
      ));
    await state.phase("compile concepts", () =>
      compileConcepts(conceptWorkspace, state.dependencyRoot, state.runner, state.limits));
    capturePackage(
      "concepts",
      state.fetched.submissionRoot,
      conceptWorkspace.libraries.concepts,
      conceptWorkspace.manifests.concepts,
      state.staticResult.concepts!.inventory,
      state.captureRoot,
    );
  } catch (error) {
    return { report: fail(state, "compile-concepts", "compile", error) };
  }

  let proofWorkspace: ProvisionedWorkspace | undefined;
  if (state.scope !== "concepts") {
    try {
      proofWorkspace = await state.phase("provision proofs", () =>
        provisionWorkspace(
          "proofs",
          state.fetched,
          request.source.folder,
          state.staticResult,
          state.resolution,
          state.siblings,
          state.jobDir,
          state.dependencyRoot,
          state.runner,
          state.limits,
        ));
      installOwnConceptCapture(proofWorkspace, state.captureRoot);
      await state.phase("compile proofs", () =>
        compileProofs(proofWorkspace!, state.dependencyRoot, state.runner, state.limits));
      capturePackage(
        "proofs",
        state.fetched.submissionRoot,
        proofWorkspace.libraries.proofs,
        proofWorkspace.manifests.proofs,
        state.staticResult.proofs!.inventory,
        state.captureRoot,
      );
    } catch (error) {
      return { report: fail(state, "compile-proofs", "compile", error) };
    }
  }

  return { state };
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

async function inspectStage(state: CompiledValidation): Promise<ValidationReport> {
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
  const inspection = judgeInspection(
    conceptReport,
    proofReport,
    state.staticResult.concepts!.inventory,
    state.scope === "concepts" ? undefined : state.staticResult.proofs!.inventory,
    state.resolution,
    state.scope,
  );
  state.warnings.push(...inspection.findings.warnings);
  state.violations.push(...inspection.findings.violations);
  if (inspection.findings.failed) return report(state, false);

  if (state.scope !== "both") return report(state, true);

  try {
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
    );
    return { ...report(state, true), buildOutput, capture };
  } catch (error) {
    return fail(state, "emit", "emit", error);
  }
}

async function prepareValidation(
  request: ValidationRequest,
  jobDir: string,
  options: ValidationOptions,
  resume: boolean,
): Promise<Preparation> {
  const runtime = options.runtime ?? configuredRuntime();
  const limits = DEFAULT_LIMITS;
  const runner = new ContainerRunner(runtime, limits, jobDir);
  const scope = options.scope ?? "both";
  const warnings: ValidationFinding[] = [];
  const violations: ValidationFinding[] = [];
  let dependencies: ResolvedDependency[] = [];
  const phase = async <T>(name: string, operation: () => Promise<T> | T): Promise<T> => {
    options.onPhase?.({ name, state: "start" });
    const started = performance.now();
    try {
      const result = await operation();
      assertWorkspaceWithinLimit(jobDir, limits);
      return result;
    } finally {
      options.onPhase?.({ name, state: "complete", durationMs: performance.now() - started });
    }
  };
  const base = (): ReportState => ({ request, runtime, dependencies, warnings, violations });

  try {
    await phase("validation runtime", () => runner.verifyRuntime());
  } catch (error) {
    return { report: fail(base(), "source", "runtime", error) };
  }

  let fetched: FetchedSource;
  let archive: ArchiveSnapshot;
  try {
    if (options.local !== undefined) {
      ({ fetched, archive } = options.local);
    } else if (resume) {
      const repositoryRoot = existingDirectory(path.join(jobDir, "source"), "fetched source");
      fetched = {
        repositoryRoot,
        submissionRoot: containedDirectory(repositoryRoot, request.source.folder),
      };
      archive = new ArchiveSnapshot(
        existingDirectory(path.join(jobDir, "archive"), "Archive snapshot"),
        request.archiveSha,
      );
    } else {
      [fetched, archive] = await Promise.all([
        fetchSource(request.source, jobDir, runner, limits),
        fetchArchiveSnapshot(request.archiveSha, jobDir, runner, limits),
      ]);
    }
  } catch (error) {
    return { report: fail(base(), "source", resume ? "resume" : "fetch", error) };
  }

  const staticCheck = await phase("static validation", () =>
    runStaticValidation(request, fetched.submissionRoot, runtime));
  warnings.push(...staticCheck.findings.warnings);
  violations.push(...staticCheck.findings.violations);
  if (staticCheck.findings.failed || staticCheck.result.concepts === undefined || staticCheck.result.proofs === undefined)
    return { report: report(base(), false) };

  const resolution = await phase("dependency resolution", () =>
    runResolution(
      request,
      staticCheck.result,
      archive,
      runtime,
      fetched.repositoryRoot,
      fetched.submissionRoot,
    ));
  warnings.push(...resolution.findings.warnings);
  violations.push(...resolution.findings.violations);
  dependencies = resolution.result.all;
  if (resolution.findings.failed) return { report: report(base(), false) };

  return {
    state: {
      ...base(),
      jobDir,
      options,
      limits,
      runner,
      scope,
      fetched,
      staticResult: staticCheck.result,
      resolution: resolution.result,
      siblings: resolution.siblings,
      dependencyRoot: path.join(jobDir, "dependencies"),
      captureRoot: path.join(jobDir, "capture"),
      phase,
    },
  };
}

function capturedManifests(
  captureRoot: string,
  scope: ValidationScope,
): Record<"concepts" | "proofs", string> {
  const concepts = readCapturedManifest(path.join(captureRoot, "concepts", "package", "lake-manifest.json"));
  return {
    concepts,
    proofs: scope === "concepts"
      ? concepts
      : readCapturedManifest(path.join(captureRoot, "proofs", "package", "lake-manifest.json")),
  };
}

function readCapturedManifest(filename: string): string {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) {
    throw new Error("compiled stage has no bounded captured manifest");
  }
  return fs.readFileSync(filename, "utf8");
}

function existingDirectory(directory: string, label: string): string {
  const absolute = path.resolve(directory);
  if (!fs.lstatSync(absolute).isDirectory()) throw new Error(`${label} is missing`);
  return absolute;
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
    warnings: state.warnings,
    violations: state.violations,
  };
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/gu, " ").slice(0, 8_000);
}
