import fs from "node:fs";
import path from "node:path";
import type { ValidationLimits } from "../config.js";
import type { ModuleInventory, ResolutionResult } from "../contracts.js";
import type { ValidationRunner } from "../sandbox/container.js";

export async function replayPackage(
  kind: "concepts" | "proofs",
  captureRoot: string,
  inventory: ModuleInventory,
  resolution: ResolutionResult,
  jobDir: string,
  dependencyRoot: string,
  runner: ValidationRunner,
  limits: ValidationLimits,
): Promise<void> {
  const containerRoot = `/capture/${kind}/package`;
  const plan = {
    tool: "replay",
    cwd: containerRoot,
    // Capture contains only Static validation's inventoried module artifacts;
    // never put Compile's mutable library on the replay search path.
    ownLibs: kind === "proofs"
      ? ["/capture/proofs/lib", "/capture/concepts/lib"]
      : ["/capture/concepts/lib"],
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
    args: ["node", "/opt/lax/bin/run-check.mjs", `/out/plan.json`],
    mounts: [
      { source: captureRoot, target: "/capture" },
      { source: outputDir, target: "/out", writable: true },
      ...(fs.existsSync(dependencyRoot) ? [{ source: dependencyRoot, target: "/deps" }] : []),
    ],
    env: { LEAN_NUM_THREADS: String(limits.leanThreads) },
    timeoutMs: limits.checkTimeoutMs,
    maxOutputBytes: limits.maxOutputBytes,
  });
  if (result.code !== 0) {
    const reason = result.timedOut ? `${kind} kernel replay exceeded its time limit` : result.output.trim();
    throw new Error(reason || `${kind} kernel replay failed`);
  }
}
