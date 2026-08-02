import fs from "node:fs";
import path from "node:path";
import type { ValidationLimits } from "../config.js";
import type { ModuleInventory, ResolutionResult } from "../contracts.js";
import type { ContainerRunner } from "../sandbox/container.js";
import type { ProvisionedWorkspace } from "./provision.js";

export async function replayPackage(
  kind: "concepts" | "proofs",
  workspace: ProvisionedWorkspace,
  inventory: ModuleInventory,
  resolution: ResolutionResult,
  jobDir: string,
  dependencyRoot: string,
  runner: ContainerRunner,
  limits: ValidationLimits,
  ownConceptLibrary?: string,
): Promise<void> {
  const workspaceBase = path.dirname(workspace.repositoryRoot);
  const containerRoot = `/work/${path.relative(workspaceBase, workspace.submissionRoot).split(path.sep).join("/")}`;
  const plan = {
    tool: "replay",
    cwd: containerRoot,
    ownLibs: kind === "proofs" && ownConceptLibrary !== undefined
      ? [`${containerRoot}/proofs/.lake/build/lib/lean`, "/own-concepts"]
      : [`${containerRoot}/concepts/.lake/build/lib/lean`],
    dependencyLibs: resolution.all.map(
      (dependency) => `/deps/${dependency.submissionId}/${dependency.kind}/lib`,
    ),
    args: [inventory.rootModule],
  };
  const outputDir = path.join(jobDir, "checks", `replay-${kind}`);
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const planPath = path.join(outputDir, "plan.json");
  fs.writeFileSync(planPath, `${JSON.stringify(plan)}\n`, { mode: 0o600 });
  const result = await runner.run({
    label: `replay-${kind}`,
    args: ["node", "/opt/lax-runtime/bin/run-check.mjs", `/out/plan.json`],
    mounts: [
      { source: workspaceBase, target: "/work" },
      { source: outputDir, target: "/out", writable: true },
      ...(ownConceptLibrary === undefined ? [] : [{ source: ownConceptLibrary, target: "/own-concepts" }]),
      ...(fs.existsSync(dependencyRoot) ? [{ source: dependencyRoot, target: "/deps" }] : []),
    ],
    timeoutMs: limits.checkTimeoutMs,
    maxOutputBytes: limits.maxOutputBytes,
  });
  if (result.code !== 0) {
    const reason = result.timedOut ? `${kind} kernel replay exceeded its time limit` : result.output.trim();
    throw new Error(reason || `${kind} kernel replay failed`);
  }
}
