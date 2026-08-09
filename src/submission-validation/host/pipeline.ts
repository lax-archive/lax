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
import { DEFAULT_LIMITS, type ValidationLimits } from "../config.js";
import type {
  ModuleInventory,
  ResolutionResult,
  StaticResult,
  ValidationFinding,
  ValidationReport,
  ValidationRequest,
  ValidationScope,
} from "../contracts.js";
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
import { hostLeanEnv, packageLibDir, type LeanEnv } from "./leanenv.js";
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
  /** Local presentation hook, mirroring ValidationOptions.onPhase. */
  onPhase?: (event: { name: string; state: "start" | "complete"; durationMs?: number }) => void;
  /**
   * What a phase found, for the row it settles. `onPhase` says only that a
   * stage happened; the author's step list wants the answer next to it — which
   * dependencies were resolved, not that resolution ran.
   */
  onDetail?: (phase: string, detail: string) => void;
  /** Collects the span tree; the caller owns it (see ValidationOptions). */
  profiler?: Profiler;
}

interface HostState {
  request: ValidationRequest;
  runtime: ReturnType<typeof hostValidationRuntime>;
  limits: ValidationLimits;
  scope: ValidationScope;
  echo: boolean;
  jobDir: string;
  captureRoot: string;
  fetched: FetchedSource;
  warnings: ValidationFinding[];
  violations: ValidationFinding[];
  dependencies: ResolutionResult["all"];
  phase<T>(name: string, operation: () => Promise<T> | T): Promise<T>;
}

/** Run the full local validation pipeline on the host toolchain. */
export async function validateSubmissionOnHost(
  request: ValidationRequest,
  jobDir: string,
  options: HostValidationOptions,
): Promise<ValidationReport> {
  const runtime = hostValidationRuntime();
  const limits = DEFAULT_LIMITS;
  const profiler = options.profiler ?? new Profiler();
  const scope = options.scope ?? "both";
  const echo = options.echo ?? true;
  const warnings: ValidationFinding[] = [];
  const violations: ValidationFinding[] = [];
  const state: HostState = {
    request,
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
    phase: async <T>(name: string, operation: () => Promise<T> | T): Promise<T> => {
      options.onPhase?.({ name, state: "start" });
      const started = performance.now();
      try {
        return await profiler.span(name, async () => operation());
      } finally {
        options.onPhase?.({ name, state: "complete", durationMs: performance.now() - started });
      }
    },
  };
  const report = (ok: boolean): ValidationReport => ({
    reportVersion: 1,
    ok,
    request,
    runtime,
    dependencies: state.dependencies,
    warnings,
    violations,
  });
  const fail = (phase: ValidationFinding["phase"], rule: string, error: unknown): ValidationReport => {
    // Unlike the trusted pipeline's safeError, keep the full multi-line
    // message: locally the author owns the transcript.
    violations.push({
      phase,
      rule,
      message: error instanceof Error ? error.message : String(error),
    });
    return report(false);
  };

  const staticCheck = await state.phase("static validation", () =>
    runStaticValidation(request, state.fetched.submissionRoot, runtime));
  warnings.push(...staticCheck.findings.warnings);
  violations.push(...staticCheck.findings.violations);
  if (staticCheck.findings.failed || staticCheck.result.concepts === undefined || staticCheck.result.proofs === undefined)
    return report(false);

  const resolution = await state.phase("dependency resolution", () =>
    runResolution(request, staticCheck.result, options.local.archive, runtime));
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

  let warmWs: string | undefined;
  try {
    warmWs = await state.phase("warm store", () =>
      ensureLocalWarm({ fromSource: options.fromSource, echo }));
  } catch (error) {
    return fail("provision", "warm-store", error);
  }
  if (warmWs === undefined) {
    violations.push({
      phase: "provision",
      rule: "warm-store",
      message:
        "the shared mathlib environment could not be built (see the transcript above); " +
        "fix the cause (network, disk) and rerun `lax build`",
    });
    return report(false);
  }
  const warm = warmWs;

  fs.mkdirSync(state.captureRoot, { recursive: true, mode: 0o700 });
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
      return fail(failurePhase, "provision", error);
    }
    if (echo) console.log(`\n== lake build (${kind}) ==`);
    const build = await state.phase(`compile ${kind}`, () =>
      run("lake", ["build"], pkgDir, {
        echo,
        env: { LAKE_ARTIFACT_CACHE: "false", LEAN_NUM_THREADS: "4" },
        maxOutputBytes: limits.maxOutputBytes,
      }));
    if (build.code !== 0) {
      violations.push({
        phase: failurePhase,
        rule: "build",
        message:
          `\`lake build\` failed in ${kind}/ (exit ${build.code})` +
          (echo ? "" : `:\n${build.output.trim()}`),
      });
      return report(false);
    }
    const materialized = await state.phase(`materialize oleans (${kind})`, () =>
      materializeOwnOleans(staticPackage.inventory, pkgDir, failurePhase, state));
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
    kind === "proofs"
      ? [path.join(state.captureRoot, "proofs", "lib"), path.join(state.captureRoot, "concepts", "lib")]
      : [path.join(state.captureRoot, "concepts", "lib")],
    dependencyLibDirs(kind),
    warm,
    limits.leanThreads,
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
      inspectorBinary({
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
  const inspection = await state.phase("judge inspection", () => judgeInspection(
    conceptReport,
    proofReport,
    staticCheck.result.concepts!.inventory,
    scope === "concepts" ? undefined : staticCheck.result.proofs!.inventory,
    resolution.result,
    scope,
  ));
  warnings.push(...inspection.findings.warnings);
  violations.push(...inspection.findings.violations);
  if (inspection.findings.failed) return report(false);

  if (scope !== "both") return report(true);

  try {
    const capture = await state.phase("emit", () =>
      describeLocalCapture(state.captureRoot, request.source.commit, runtime));
    const buildOutput = emitBuildOutput(
      state.fetched.submissionRoot,
      staticCheck.result,
      inspection.result,
      capture,
    );
    return { ...report(true), buildOutput, capture };
  } catch (error) {
    return fail("emit", "emit", error);
  }
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
    state.violations.push({
      phase: failurePhase,
      rule: "build",
      message: `unexpected \`lake query\` output for package ${inventory.packageName}`,
    });
    return false;
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

