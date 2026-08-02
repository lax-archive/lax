import fs from "node:fs";
import path from "node:path";
import { ArchiveSnapshot, fetchArchiveSnapshot } from "./archive/snapshot.js";
import { materializeDependencyCaptures } from "./captures/materialize.js";
import { capturePackage, describeLocalCapture, sealCapture } from "./captures/seal.js";
import { configuredRuntime, DEFAULT_LIMITS } from "./config.js";
import type {
  ResolvedDependency,
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
  /** Local presentation hook. Trusted workflow output remains unchanged. */
  onPhase?: (event: { name: string; state: "start" | "complete"; durationMs?: number }) => void;
}

export async function validateSubmission(
  request: ValidationRequest,
  jobDir: string,
  options: ValidationOptions = {},
): Promise<ValidationReport> {
  const runtime = options.runtime ?? configuredRuntime();
  const limits = DEFAULT_LIMITS;
  const runner = new ContainerRunner(runtime, limits);
  const scope = options.scope ?? "both";
  const warnings: ValidationFinding[] = [];
  const violations: ValidationFinding[] = [];
  let dependencies: ResolvedDependency[] = [];
  const phase = async <T>(name: string, operation: () => Promise<T> | T): Promise<T> => {
    options.onPhase?.({ name, state: "start" });
    const started = performance.now();
    try {
      return await operation();
    } finally {
      options.onPhase?.({ name, state: "complete", durationMs: performance.now() - started });
    }
  };
  const fail = (phase: ValidationFinding["phase"], rule: string, error: unknown): ValidationReport => {
    violations.push({ phase, rule, message: safeError(error) });
    return {
      reportVersion: 1,
      ok: false,
      request,
      runtime,
      dependencies,
      warnings,
      violations,
    };
  };

  try {
    await phase("validation runtime", () => runner.verifyRuntime());
  } catch (error) {
    return fail("source", "runtime", error);
  }

  let fetched: FetchedSource;
  let archive: ArchiveSnapshot;
  try {
    if (options.local !== undefined) {
      ({ fetched, archive } = options.local);
    } else {
      [fetched, archive] = await Promise.all([
        fetchSource(request.source, jobDir, runner, limits),
        fetchArchiveSnapshot(request.archiveSha, jobDir, runner, limits),
      ]);
    }
  } catch (error) {
    return fail("source", "fetch", error);
  }

  const staticCheck = await phase("static validation", () =>
    runStaticValidation(request, fetched.submissionRoot, runtime));
  warnings.push(...staticCheck.findings.warnings);
  violations.push(...staticCheck.findings.violations);
  if (staticCheck.findings.failed || staticCheck.result.concepts === undefined || staticCheck.result.proofs === undefined)
    return { reportVersion: 1, ok: false, request, runtime, dependencies, warnings, violations };

  const resolution = await phase("dependency resolution", () =>
    runResolution(
      request,
      staticCheck.result,
      archive,
      runtime,
      fetched.repositoryRoot,
      fetched.submissionRoot,
    ),
  );
  warnings.push(...resolution.findings.warnings);
  violations.push(...resolution.findings.violations);
  dependencies = resolution.result.all;
  if (resolution.findings.failed)
    return { reportVersion: 1, ok: false, request, runtime, dependencies, warnings, violations };

  const dependencyRoot = path.join(jobDir, "dependencies");
  try {
    await phase("dependency provisioning", () =>
      materializeDependencyCaptures(dependencies, jobDir, runner, limits));
  } catch (error) {
    return fail("provision", "dependency-capture", error);
  }

  const captureRoot = path.join(jobDir, "capture");
  fs.mkdirSync(captureRoot, { recursive: true, mode: 0o700 });
  let conceptWorkspace: ProvisionedWorkspace;
  try {
    conceptWorkspace = await phase("provision concepts", () =>
      provisionWorkspace(
        "concepts",
        fetched,
        request.source.folder,
        staticCheck.result,
        resolution.result,
        resolution.siblings,
        jobDir,
        dependencyRoot,
        runner,
        limits,
      ));
    await phase("compile concepts", () =>
      compileConcepts(conceptWorkspace, dependencyRoot, runner, limits));
    capturePackage(
      "concepts",
      fetched.submissionRoot,
      conceptWorkspace.submissionRoot,
      conceptWorkspace.manifests.concepts,
      staticCheck.result.concepts.inventory,
      captureRoot,
    );
  } catch (error) {
    return fail("compile-concepts", "compile", error);
  }

  let proofWorkspace: ProvisionedWorkspace | undefined;
  if (scope !== "concepts") {
    try {
      proofWorkspace = await phase("provision proofs", () =>
        provisionWorkspace(
          "proofs",
          fetched,
          request.source.folder,
          staticCheck.result,
          resolution.result,
          resolution.siblings,
          jobDir,
          dependencyRoot,
          runner,
          limits,
        ));
      installOwnConceptCapture(proofWorkspace, captureRoot);
      await phase("compile proofs", () =>
        compileProofs(proofWorkspace!, dependencyRoot, runner, limits));
      capturePackage(
        "proofs",
        fetched.submissionRoot,
        proofWorkspace.submissionRoot,
        proofWorkspace.manifests.proofs,
        staticCheck.result.proofs.inventory,
        captureRoot,
      );
    } catch (error) {
      return fail("compile-proofs", "compile", error);
    }
  }

  if (options.replay !== false) {
    try {
      const replay: Promise<void>[] = [];
      if (scope !== "proofs") replay.push(phase("replay concepts", () =>
        replayPackage(
          "concepts",
          conceptWorkspace,
          staticCheck.result.concepts!.inventory,
          resolution.result,
          jobDir,
          dependencyRoot,
          runner,
          limits,
        )));
      if (scope !== "concepts") replay.push(phase("replay proofs", () =>
        replayPackage(
          "proofs",
          proofWorkspace!,
          staticCheck.result.proofs!.inventory,
          resolution.result,
          jobDir,
          dependencyRoot,
          runner,
          limits,
          path.join(captureRoot, "concepts", "lib"),
        )));
      await Promise.all(replay);
    } catch (error) {
      return fail("replay", "kernel-replay", error);
    }
  }

  let conceptReport;
  let proofReport;
  try {
    const reports = await Promise.all([
      phase("inspect concepts", () => runInspector(
        "concepts",
        conceptWorkspace,
        staticCheck.result.concepts!.inventory,
        resolution.result,
        jobDir,
        dependencyRoot,
        runner,
        limits,
      )),
      ...(scope === "concepts" ? [] : [phase("inspect proofs", () => runInspector(
          "proofs",
          proofWorkspace!,
          staticCheck.result.proofs!.inventory,
          resolution.result,
          jobDir,
          dependencyRoot,
          runner,
          limits,
          path.join(captureRoot, "concepts", "lib"),
        ))]),
    ]);
    conceptReport = reports[0]!;
    proofReport = reports[1];
  } catch (error) {
    return fail("inspect", "inspector", error);
  }
  const inspection = judgeInspection(
    conceptReport,
    proofReport,
    staticCheck.result.concepts.inventory,
    scope === "concepts" ? undefined : staticCheck.result.proofs.inventory,
    resolution.result,
    scope,
  );
  warnings.push(...inspection.findings.warnings);
  violations.push(...inspection.findings.violations);
  if (inspection.findings.failed)
    return { reportVersion: 1, ok: false, request, runtime, dependencies, warnings, violations };

  if (scope !== "both") {
    return { reportVersion: 1, ok: true, request, runtime, dependencies, warnings, violations };
  }

  try {
    const capture = await phase("emit", async () =>
      options.sealCapture === false
        ? describeLocalCapture(captureRoot, request.source.commit, runtime)
        : await sealCapture(
            captureRoot,
            path.join(path.dirname(jobDir), "capture.tar"),
            request.source.commit,
            runtime,
            runner,
            limits,
          ));
    const buildOutput = emitBuildOutput(
      fetched.submissionRoot,
      staticCheck.result,
      inspection.result,
      capture,
    );
    return {
      reportVersion: 1,
      ok: true,
      request,
      runtime,
      dependencies,
      warnings,
      violations,
      buildOutput,
      capture,
    };
  } catch (error) {
    return fail("emit", "emit", error);
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/gu, " ").slice(0, 8_000);
}
