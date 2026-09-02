import fs from "node:fs";
import type { ValidationLimits } from "../config.js";
import type { ValidationRunner } from "../sandbox/container.js";
import type { ProvisionedWorkspace } from "./provision.js";
import { compilationFailure, containerBoundaryFailure } from "../failures.js";

export interface CompileResult {
  output: string;
}

export async function compileConcepts(
  workspace: ProvisionedWorkspace,
  dependencyRoot: string,
  runner: ValidationRunner,
  limits: ValidationLimits,
): Promise<CompileResult> {
  return compile("concepts", workspace, dependencyRoot, runner, limits);
}

export async function compileProofs(
  workspace: ProvisionedWorkspace,
  dependencyRoot: string,
  runner: ValidationRunner,
  limits: ValidationLimits,
): Promise<CompileResult> {
  return compile("proofs", workspace, dependencyRoot, runner, limits);
}

async function compile(
  kind: "concepts" | "proofs",
  workspace: ProvisionedWorkspace,
  dependencyRoot: string,
  runner: ValidationRunner,
  limits: ValidationLimits,
): Promise<CompileResult> {
  const result = await runner.run({
    label: `compile-${kind}`,
    args: ["lake", "build"],
    mounts: [
      { source: workspace.repositoryRoot, target: "/source" },
      ...workspace.buildMounts[kind],
      ...(fs.existsSync(dependencyRoot) ? [{ source: dependencyRoot, target: "/deps" }] : []),
    ],
    workdir: `${workspace.containerSubmissionRoot}/${kind}`,
    env: {
      HOME: "/tmp/lax-home",
      // must stay off against the read-only warm mount — see the landmine
      // comment in host/warmstore.ts (lake would write .hash files beside
      // the shared oleans)
      LAKE_ARTIFACT_CACHE: "false",
      LEAN_NUM_THREADS: "4",
    },
    timeoutMs: limits.compileTimeoutMs,
    maxOutputBytes: limits.maxOutputBytes,
  });
  if (result.code !== 0) {
    const boundary = containerBoundaryFailure(
      result,
      `${kind} compilation exceeded its time limit`,
      `${kind} compilation exceeded its memory limit`,
    );
    if (boundary !== undefined) throw boundary;
    throw compilationFailure(result.output, `${kind} compilation failed`);
  }
  return { output: result.output };
}
