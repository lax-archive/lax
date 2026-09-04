// The host validation pipeline behind local `lax build`: no container, no
// runtime image — the author's own elan/lake toolchain, building **in place**
// in the submission's concepts/ and proofs/ directories so `.lake` persists
// between runs and rebuilds stay incremental. Static validation, dependency
// resolution, inspection judging, and build-output emission are the exact
// modules the trusted container pipeline runs; only the Lean-touching
// execution differs. Cross-submission dependencies build **from source**
// here: resolution validates every declared rev-pinned require against the
// database, and the seeded manifest's locked git entries make lake clone and
// build each one in-workspace under `.lake/packages/` (the trusted path
// instead materializes published captures — see phases/provision.ts). Replay
// and Inspect still run against the captured artifacts with a
// pipeline-composed LEAN_PATH (never `lake env`), so a local pass exercises
// the same gate registration enforces.

import fs from "node:fs";
import path from "node:path";
import type { ArchiveSnapshot } from "../archive/snapshot.js";
import { capturePackage, describeLocalCapture } from "../captures/seal.js";
import { limitsFor, type ValidationLimits } from "../config.js";
import {
  epoch,
  resolveRuntime,
  type ArchiveEnvironment,
  type RuntimeSource,
} from "../environments.js";
import { FindingCollector } from "../findings.js";
import type {
  InspectionResult,
  ModuleInventory,
  PaperOutput,
  ResolutionResult,
  StaticResult,
  ValidationFailure,
  ValidationFinding,
  ValidationReport,
  ValidationRequest,
  ValidationRuntimeIdentity,
  ValidationScope,
} from "../contracts.js";
import {
  asPipelineFailure,
  compilationFailure,
  infrastructureFailure,
  replayFailure,
  type PipelineFailureKind,
} from "../failures.js";
import { joinPaperMarks } from "../paper/join.js";
import { capturePaperSources, runPaperPhase, type CompiledPaper, type PaperPhaseResult } from "../paper/phase.js";
import type { WebDeriver } from "../paper/web.js";
import { emitBuildOutput } from "../phases/emit.js";
import { judgeInspection } from "../phases/inspect.js";
import { parseInspectorReport } from "../phases/inspect-runner.js";
import { dependencyClosure, dependencySubDir } from "../phases/provision.js";
import { runResolution } from "../phases/resolution.js";
import { runStaticValidation } from "../phases/static.js";
import { hostValidationRuntime } from "../pins.js";
import type { FetchedSource } from "../source/fetch.js";
import { Profiler } from "../../shared/profile.js";
import { inspectorBinary } from "./inspector.js";
import { hostLeanEnv, lakeBinary, lakePathEnv, packageLibDir, type LeanEnv } from "./leanenv.js";
import { commitTimestamp, engineAvailable, hostPaperCompiler, MIN_LATEXMK_VERSION, probeLatexmkAsync } from "./paper.js";
import { run } from "./proc.js";
import {
  ensureLocalWarm,
  seedManifest,
  seedOverrides,
  type SeededDependency,
} from "./warmstore.js";

export interface HostValidationOptions {
  /** The working tree and local Archive clone the build validates against. */
  local: { fetched: FetchedSource; archive: ArchiveSnapshot };
  /** Kernel replay is opt-in locally (`lax build --replay`). */
  replay?: boolean;
  /** Fast local iteration may stop after one package. */
  scope?: ValidationScope;
  /** Build mathlib from source when its prebuilt artifacts cannot be fetched. */
  fromSource?: boolean;
  /**
   * Stream lake/lean transcripts live to stdout (the CLI default). When off
   * (library and test use) failed builds carry the full transcript in the
   * violation message instead.
   */
  echo?: boolean;
  /** Local presentation hook, mirroring ValidationOptions.onPhase. `ok` is
   * set on completion of the phases that settle out of order (the paper,
   * which runs beside the Lean chain) so a row can close on its own answer. */
  onPhase?: (event: { name: string; state: "start" | "complete"; durationMs?: number; ok?: boolean }) => void;
  /**
   * What a phase found, for the row it settles. `onPhase` says only that a
   * stage happened; the author's step list wants the answer next to it — which
   * dependencies were resolved, not that resolution ran.
   */
  onDetail?: (phase: string, detail: string) => void;
  /** Collects the span tree; the caller owns it (see ValidationOptions). */
  profiler?: Profiler;
  /**
   * The paper web derivation seam (paper-web-plan.md), mirroring the
   * runner/compiler seams: tests and fixture generation inject
   * `hostWebDeriver` (or a fake) here. Absent — the `lax build` default —
   * means no derived view is attempted; the archive-side derivation is the
   * trusted path's job.
   */
  webDeriver?: WebDeriver;
}

interface HostState {
  request: ValidationRequest;
  /** The environment the manifest selected; the epoch until the static phase
   * has answered, and nothing provisions before then. */
  environment: ArchiveEnvironment;
  runtime: ValidationRuntimeIdentity;
  limits: ValidationLimits;
  scope: ValidationScope;
  echo: boolean;
  jobDir: string;
  captureRoot: string;
  fetched: FetchedSource;
  warnings: ValidationFinding[];
  violations: ValidationFinding[];
  failure?: ValidationFailure;
  dependencies: ResolutionResult["all"];
  phase<T>(name: string, operation: () => Promise<T> | T, judge?: (result: T) => boolean): Promise<T>;
}

/** The host report, plus what the caller must copy out of the job directory
 * before it is removed: the compiled paper and its derived web bundle, when
 * there are any. */
export interface HostValidationReport extends ValidationReport {
  paperPdfPath?: string;
  paperWebPath?: string;
}

/** Run the full local validation pipeline on the host toolchain. */
export async function validateSubmissionOnHost(
  request: ValidationRequest,
  jobDir: string,
  options: HostValidationOptions,
): Promise<HostValidationReport> {
  const runtimeSource: RuntimeSource = (entry) => hostValidationRuntime(entry);
  let environment = epoch();
  let runtime = resolveRuntime(runtimeSource, environment);
  let limits = limitsFor(environment);
  const profiler = options.profiler ?? new Profiler();
  const scope = options.scope ?? "both";
  const echo = options.echo ?? true;
  const warnings: ValidationFinding[] = [];
  const violations: ValidationFinding[] = [];
  const state: HostState = {
    request,
    environment,
    runtime,
    limits,
    scope,
    echo,
    jobDir,
    captureRoot: path.join(jobDir, "capture"),
    fetched: options.local.fetched,
    warnings,
    violations,
    dependencies: [],
    phase: async <T>(name: string, operation: () => Promise<T> | T, judge?: (result: T) => boolean): Promise<T> => {
      options.onPhase?.({ name, state: "start" });
      const started = performance.now();
      let ok: boolean | undefined;
      try {
        const result = await profiler.span(name, async () => operation());
        ok = judge?.(result);
        return result;
      } finally {
        options.onPhase?.({
          name,
          state: "complete",
          durationMs: performance.now() - started,
          ...(ok === undefined ? {} : { ok }),
        });
      }
    },
  };
  const report = (ok: boolean): ValidationReport => {
    const value: ValidationReport = {
      reportVersion: 1,
      ok,
      request,
      runtime: state.runtime,
      dependencies: state.dependencies,
      warnings: [...warnings],
      violations: [...violations],
    };
    if (state.failure !== undefined) value.failure = state.failure;
    return value;
  };
  const fail = (
    phase: ValidationFinding["phase"],
    rule: string,
    error: unknown,
    fallbackKind: PipelineFailureKind = "infrastructure",
  ): ValidationReport => {
    // Locally keep the full multi-line message: the author owns the transcript.
    const failure = asPipelineFailure(error, fallbackKind);
    const message = failure.message;
    if (failure.kind === "submission") violations.push({ phase, rule, message });
    else state.failure = { kind: failure.kind, retryable: failure.retryable, phase, rule, message };
    return report(false);
  };

  let staticCheck: ReturnType<typeof runStaticValidation>;
  try {
    staticCheck = await state.phase("static validation", () =>
      runStaticValidation(request, state.fetched.submissionRoot, runtimeSource));
  } catch (error) {
    return fail("static", "validator", error);
  }
  // From here the run carries the environment the manifest selected: its
  // toolchain, its warm store, its inspector, its limits.
  environment = staticCheck.environment;
  runtime = staticCheck.runtime;
  limits = limitsFor(environment);
  state.environment = environment;
  state.runtime = runtime;
  state.limits = limits;
  warnings.push(...staticCheck.findings.warnings);
  violations.push(...staticCheck.findings.violations);
  if (staticCheck.findings.failed || staticCheck.result.concepts === undefined || staticCheck.result.proofs === undefined)
    return report(false);

  let resolution: ReturnType<typeof runResolution>;
  try {
    resolution = await state.phase("dependency resolution", () =>
      runResolution(request, staticCheck.result, options.local.archive, runtime));
  } catch (error) {
    return fail("resolution", "resolver", error);
  }
  warnings.push(...resolution.findings.warnings);
  violations.push(...resolution.findings.violations);
  state.dependencies = resolution.result.all;
  // mathlib is not a resolved dependency — it is the environment every
  // submission builds in — so it leads the list the author sees rather than
  // being absent from it.
  options.onDetail?.(
    "dependency resolution",
    ["mathlib", ...new Set(resolution.result.all.map((dependency) => dependency.submissionId))].join(", "),
  );
  if (resolution.findings.failed) return report(false);

  // The paper compiles beside the Lean chain: nothing in the TeX work depends
  // on Lean (the rewriter emits numbers, compile and extraction work on
  // numbers only), so it starts now and is joined before Emit. Whatever Lean
  // does, the promise is awaited before this function returns, so both
  // findings reach the author and the job directory outlives latexmk.
  const paperRun =
    staticCheck.result.paper !== undefined && scope === "both"
      ? startPaperPhase(state, staticCheck.result, options)
      : undefined;

  const lean = await runLeanChain();
  const paper = paperRun === undefined ? undefined : await paperRun;
  if (paper !== undefined) warnings.push(...paper.findings.warnings);
  if (isReport(lean)) {
    if (lean.failure === undefined && paper !== undefined) {
      violations.push(...paper.findings.violations);
      return paper.findings.failed ? report(false) : report(lean.ok);
    }
    return report(lean.ok);
  }
  if (paper !== undefined) violations.push(...paper.findings.violations);
  if (paper?.findings.failed === true) return report(false);

  try {
    const paperOutput = paper?.compiled === undefined
      ? undefined
      : await state.phase("resolve marks", () => resolveMarks(paper.compiled!, staticCheck.result, resolution.result, options.local.archive, lean.inspection, state));
    if (paperOutput === "failed") return report(false);
    if (staticCheck.result.paper !== undefined && scope === "both") {
      capturePaperSources(staticCheck.result.paper, state.fetched.submissionRoot, state.captureRoot);
    }
    const capture = await state.phase("emit", () =>
      describeLocalCapture(state.captureRoot, request.source.commit, state.runtime));
    const buildOutput = emitBuildOutput(
      state.fetched.submissionRoot,
      staticCheck.result,
      lean.inspection,
      capture,
      paperOutput,
    );
    return {
      ...report(true),
      buildOutput,
      capture,
      ...(paper?.compiled === undefined ? {} : { paperPdfPath: paper.compiled.pdfPath }),
      ...(paper?.compiled?.web === undefined ? {} : { paperWebPath: paper.compiled.web.bundlePath }),
    };
  } catch (error) {
    return fail("emit", "emit", error);
  }

  /** Provision, compile, capture, replay, inspect, judge — everything Lean.
   * Returns the report to hand back when the chain stops early (a failure,
   * or a partial scope), else the inspection Emit needs. */
  async function runLeanChain(): Promise<ValidationReport | { inspection: InspectionResult }> {
    let warmWs: string | undefined;
    try {
      warmWs = await state.phase("warm store", () =>
        ensureLocalWarm(state.environment, { fromSource: options.fromSource, echo }));
    } catch (error) {
      return fail("provision", "warm-store", error);
    }
    if (warmWs === undefined) {
      return fail(
        "provision",
        "warm-store",
        infrastructureFailure(
          "the shared mathlib environment could not be built (see the transcript above); " +
            "fix the cause (network, disk) and rerun `lax build`",
          true,
        ),
      );
    }
    const warm = warmWs;

    try {
      fs.mkdirSync(state.captureRoot, { recursive: true, mode: 0o700 });
    } catch (error) {
      return fail("provision", "capture-workspace", error);
    }
    const kinds: Array<"concepts" | "proofs"> =
      scope === "concepts" ? ["concepts"] : ["concepts", "proofs"];
    for (const kind of kinds) {
      // The concept package is built under every scope: even a proofs-only run
      // inspects its environment for the statements the proofs may assume.
      const failurePhase = kind === "concepts" ? "compile-concepts" : "compile-proofs";
      const staticPackage = staticCheck.result[kind]!;
      const pkgDir = path.join(state.fetched.submissionRoot, kind);
      try {
        await state.phase(`provision ${kind}`, () => {
          seedOverrides(warm, pkgDir);
          seedManifest(warm, pkgDir, hostDependencies(kind, staticCheck.result, resolution.result));
        });
      } catch (error) {
        return fail("provision", `${kind}-workspace`, error);
      }
      if (echo) console.log(`\n== lake build (${kind}) ==`);
      const build = await state.phase(`compile ${kind}`, () =>
        run(lakeBinary(state.environment), ["build"], pkgDir, {
          echo,
          env: { LAKE_ARTIFACT_CACHE: "false", LEAN_NUM_THREADS: "4", PATH: lakePathEnv(state.environment) },
          maxOutputBytes: state.limits.maxOutputBytes,
        }));
      if (build.code !== 0) {
        const failure = compilationFailure(
          build.output,
          `\`lake build\` failed in ${kind}/ (exit ${build.code})`,
        );
        if (failure.kind !== "submission") return fail(failurePhase, "build", failure);
        violations.push({
          phase: failurePhase,
          rule: "build",
          message:
            `\`lake build\` failed in ${kind}/ (exit ${build.code})` +
            (echo ? "" : `:\n${build.output.trim()}`),
        });
        return report(false);
      }
      let materialized: boolean;
      try {
        materialized = await state.phase(`materialize oleans (${kind})`, () =>
          materializeOwnOleans(staticPackage.inventory, pkgDir, failurePhase, state));
      } catch (error) {
        return fail(failurePhase, "build-artifacts", error);
      }
      if (!materialized) return report(false);
      try {
        await state.phase(`capture ${kind}`, () => capturePackage(
          kind,
          state.fetched.submissionRoot,
          packageLibDir(pkgDir),
          fs.readFileSync(path.join(pkgDir, "lake-manifest.json"), "utf8"),
          staticPackage.inventory,
          state.captureRoot,
        ));
      } catch (error) {
        return fail(failurePhase, "capture", error);
      }
    }

    // Dependency lib dirs come from the packages lake built in-workspace: a
    // git-type manifest entry is cloned to `<pkgDir>/.lake/packages/<name>` and
    // the package (at its subDir) builds into `<clone>/<subDir>/.lake/build/
    // lib/lean` — layout verified empirically at the pinned v4.30.0. Lake only
    // builds the dependency modules the package imports, so absent lib dirs
    // (a dependency nothing imported) are filtered like before.
    const dependencyLibDirs = (kind: "concepts" | "proofs"): string[] =>
      dependencyClosure(kind, resolution.result)
        .map((dependency) => packageLibDir(path.join(
          state.fetched.submissionRoot,
          kind,
          ".lake",
          "packages",
          dependency.packageName,
          dependencySubDir(dependency),
        )))
        .filter((directory) => fs.existsSync(directory));
    const leanEnvFor = (kind: "concepts" | "proofs"): LeanEnv => hostLeanEnv(
      state.environment,
      kind === "proofs"
        ? [path.join(state.captureRoot, "proofs", "lib"), path.join(state.captureRoot, "concepts", "lib")]
        : [path.join(state.captureRoot, "concepts", "lib")],
      dependencyLibDirs(kind),
      warm,
      state.limits.leanThreads,
    );

    if (options.replay === true) {
      // Mirror the trusted stage scoping: concepts replay under every scope but
      // `proofs`, proofs replay under every scope but `concepts`.
      const replayKinds = kinds.filter((kind) => !(scope === "proofs" && kind === "concepts"));
      for (const kind of replayKinds) {
        const inventory = staticCheck.result[kind]!.inventory;
        const leanEnv = leanEnvFor(kind);
        const cwd = path.join(state.captureRoot, kind, "package");
        const result = await state.phase(`replay ${kind}`, () =>
          leanEnv.exec(leanEnv.leancheckerBin, [inventory.rootModule], cwd));
        if (result.code !== 0) {
          const failure = replayFailure(
            result.output,
            `leanchecker failed for package ${inventory.packageName}`,
          );
          if (failure.kind !== "submission") return fail("replay", "kernel-replay", failure);
          violations.push({
            phase: "replay",
            rule: "kernel-replay",
            message: `leanchecker failed for package ${inventory.packageName}:\n${result.output.trim()}`,
          });
          return report(false);
        }
      }
    }

    let inspectorBin: string;
    try {
      inspectorBin = await state.phase("inspector binary", () =>
        inspectorBinary(state.environment, {
          echo,
          // Half a minute of lake with nothing else to show for it, once per
          // inspector source change. Say so on the row rather than let it read
          // as a hang.
          onBuild: () => options.onDetail?.("inspector binary", "building the inspector"),
        }));
    } catch (error) {
      return fail("inspect", "inspector", error);
    }
    const inspect = async (kind: "concepts" | "proofs") => {
      const inventory = staticCheck.result[kind]!.inventory;
      const outputDir = path.join(jobDir, "checks", `inspect-${kind}`);
      fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
      const reportPath = path.join(outputDir, "report.json");
      const leanEnv = leanEnvFor(kind);
      const cwd = path.join(state.captureRoot, kind, "package");
      const result = await leanEnv.exec(
        inspectorBin,
        [reportPath, inventory.rootModule, ...inventory.modules],
        cwd,
      );
      if (result.code !== 0) {
        throw new Error(
          `inspector failed for package ${inventory.packageName} (exit ${result.code}):\n${result.output.trim()}`,
        );
      }
      const stat = fs.lstatSync(reportPath);
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024)
        throw new Error(`${kind} inspector report is missing or oversized`);
      return parseInspectorReport(JSON.parse(fs.readFileSync(reportPath, "utf8")) as unknown);
    };
    let conceptReport;
    let proofReport;
    try {
      conceptReport = await state.phase("inspect concepts", () => inspect("concepts"));
      proofReport = scope === "concepts" ? undefined : await state.phase("inspect proofs", () => inspect("proofs"));
    } catch (error) {
      return fail("inspect", "inspector", error);
    }
    let inspection;
    try {
      inspection = await state.phase("judge inspection", () => judgeInspection(
        conceptReport,
        proofReport,
        staticCheck.result.concepts!.inventory,
        scope === "concepts" ? undefined : staticCheck.result.proofs!.inventory,
        resolution.result,
        scope,
      ));
    } catch (error) {
      return fail("inspect", "judge", error);
    }
    warnings.push(...inspection.findings.warnings);
    violations.push(...inspection.findings.violations);
    if (inspection.findings.failed) return report(false);

    if (scope !== "both") return report(true);
    return { inspection: inspection.result };
  }
}

function isReport(value: ValidationReport | { inspection: InspectionResult }): value is ValidationReport {
  return "reportVersion" in value;
}

/**
 * The independent piece of the paper phase on the host: latexmk from PATH.
 * No latexmk (or one too old to inject the marker package, or a missing
 * engine) skips the phase with a warning and omits `paper` from the build
 * output; Lean validation is unaffected. Local is a preview, the archive's
 * compile is the authority.
 */
async function startPaperPhase(
  state: HostState,
  staticResult: StaticResult,
  options: HostValidationOptions,
): Promise<PaperPhaseResult> {
  const paper = staticResult.paper!;
  return state.phase(
    "paper",
    async (): Promise<PaperPhaseResult> => {
      const skipped = (reason: string): PaperPhaseResult => {
        const findings = new FindingCollector("paper");
        findings.warn(
          "latexmk-missing",
          `${reason}; the paper was not compiled on this machine (the archive compiles it in its own TeX Live) — ` +
            "install TeX Live with latexmk to preview it locally",
        );
        options.onDetail?.("paper", `skipped: ${reason}`);
        return { findings };
      };
      const latexmk = await probeLatexmkAsync();
      if (latexmk === undefined) return skipped("latexmk is not installed");
      if (!latexmk.supported) return skipped(`latexmk ${latexmk.version} is older than ${MIN_LATEXMK_VERSION}`);
      if (!(await engineAvailable(paper.manifest.engine))) return skipped(`${paper.manifest.engine} is not installed`);
      let sourceDateEpoch: number;
      try {
        sourceDateEpoch = commitTimestamp(state.fetched.repositoryRoot, state.request.source.commit);
      } catch (error) {
        const findings = new FindingCollector("paper");
        findings.violate("source-date", error instanceof Error ? error.message : String(error));
        return { findings };
      }
      let result: PaperPhaseResult;
      try {
        result = await runPaperPhase({
          paper,
          submissionRoot: state.fetched.submissionRoot,
          jobDir: state.jobDir,
          sourceDateEpoch,
          limits: state.limits,
          compile: hostPaperCompiler({ echo: state.echo, maxOutputBytes: state.limits.maxOutputBytes }),
          // Absent by default: `lax build` never derives the web view on its
          // own (paper-web-plan.md, "CLI") — tests and fixture generation
          // inject a deriver here.
          ...(options.webDeriver === undefined ? {} : { deriveWeb: options.webDeriver }),
        });
      } catch (error) {
        // Anything the phase did not turn into a finding itself (a copy that
        // failed, a missing laxmark.sty) is still this row's answer, not a
        // crash that takes the Lean findings with it.
        const findings = new FindingCollector("paper");
        findings.violate("paper", error instanceof Error ? error.message : String(error));
        return { findings };
      }
      if (result.compiled !== undefined) {
        options.onDetail?.(
          "paper",
          `${result.compiled.pages} ${result.compiled.pages === 1 ? "page" : "pages"} · ` +
            `${result.compiled.located.length} ${result.compiled.located.length === 1 ? "mark" : "marks"}`,
        );
      }
      return result;
    },
    (result) => !result.findings.failed,
  );
}

/** The join piece (paper/join.ts); its problems are this pipeline's findings. */
function resolveMarks(
  compiled: CompiledPaper,
  staticResult: StaticResult,
  resolution: ResolutionResult,
  archive: ArchiveSnapshot,
  inspection: InspectionResult,
  state: HostState,
): PaperOutput | "failed" {
  const joined = joinPaperMarks(compiled, staticResult, resolution, archive, inspection);
  for (const problem of joined.problems) state.violations.push({ phase: "paper", rule: "mark-id", message: problem });
  return joined.output ?? "failed";
}

/** The manifest entries a package build needs: the proof package's own
 * concept package (the only in-tree path edge a lakefile may declare) and a
 * locked git entry per resolved dependency in the closure — its database
 * record's canonical repository URL, full commit, and package folder, i.e.
 * exactly the triple resolution just validated the author's declared require
 * against. Nothing resolution did not bless is ever seeded. The trusted
 * container path materializes captures instead (phases/provision.ts). */
function hostDependencies(
  kind: "concepts" | "proofs",
  staticResult: StaticResult,
  resolution: ResolutionResult,
): SeededDependency[] {
  const staticPackage = staticResult[kind]!;
  const entries: SeededDependency[] = [];
  if (
    kind === "proofs" &&
    staticPackage.lakefile.hasConceptPathRequire &&
    staticResult.concepts !== undefined
  ) {
    entries.push({ name: staticResult.concepts.lakefile.packageName, dir: "../concepts" });
  }
  for (const dependency of dependencyClosure(kind, resolution)) {
    entries.push({
      name: dependency.packageName,
      url: dependency.source.repository,
      rev: dependency.source.commit,
      subDir: dependencySubDir(dependency),
    });
  }
  return entries;
}

/**
 * Ensure every inventoried olean is at its canonical location for capture:
 * `lake build` covers the root's import closure, but a malformed root that
 * forgot a module leaves that olean unbuilt. Anything missing is asked of
 * `lake query` and hardlinked into place — a self-heal that doubles as the
 * "no build artifact" violation when lake cannot produce the module either.
 */
async function materializeOwnOleans(
  inventory: ModuleInventory,
  pkgDir: string,
  failurePhase: ValidationFinding["phase"],
  state: HostState,
): Promise<boolean> {
  const lib = packageLibDir(pkgDir);
  const jobs = [inventory.rootModule, ...inventory.modules]
    .map((mod) => ({ mod, dst: path.join(lib, ...mod.split(".")) + ".olean" }))
    .filter((job) => !fs.existsSync(job.dst));
  if (jobs.length === 0) return true;
  const result = await run(
    "lake",
    ["query", "-J", ...jobs.map((job) => `+${job.mod}:olean`)],
    pkgDir,
    { env: { LAKE_ARTIFACT_CACHE: "false" }, maxOutputBytes: state.limits.maxOutputBytes },
  );
  if (result.code !== 0) {
    state.violations.push({
      phase: failurePhase,
      rule: "build",
      message: `no build artifact for module(s) of package ${inventory.packageName}:\n${result.output.trim()}`,
    });
    return false;
  }
  const lines = result.output.split("\n").filter((line) => line.trim().startsWith("\""));
  if (lines.length !== jobs.length) {
    throw infrastructureFailure(`unexpected \`lake query\` output for package ${inventory.packageName}`);
  }
  for (const [index, job] of jobs.entries()) {
    const source = JSON.parse(lines[index]!.trim()) as string;
    // with the artifact cache off, `lake query` usually just built the olean
    // at the canonical path itself — nothing left to materialize
    if (path.resolve(source) === path.resolve(job.dst) || fs.existsSync(job.dst)) continue;
    fs.mkdirSync(path.dirname(job.dst), { recursive: true });
    // hardlink when possible (leanchecker's module scan ignores symlinks),
    // copy across filesystems
    try {
      fs.linkSync(source, job.dst);
    } catch {
      fs.copyFileSync(source, job.dst);
    }
  }
  return true;
}
