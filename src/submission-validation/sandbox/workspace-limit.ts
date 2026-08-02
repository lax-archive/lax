import fs from "node:fs";
import path from "node:path";
import type { ValidationLimits } from "../config.js";

export interface WorkspaceUsage {
  bytes: number;
  entries: number;
}

/**
 * Bound the complete disposable validation tree, including git data, build
 * products, dependency downloads, and extracted captures. Apparent size is
 * deliberately used so sparse files cannot bypass the limit.
 */
export function assertWorkspaceWithinLimit(
  root: string,
  limits: Pick<ValidationLimits, "maxWorkspaceBytes" | "maxWorkspaceEntries" | "minFreeDiskBytes">,
): WorkspaceUsage {
  const usage = measureWorkspace(root, limits);
  if (usage.bytes > limits.maxWorkspaceBytes) {
    throw new Error(`validation workspace exceeds ${formatGiB(limits.maxWorkspaceBytes)} GiB`);
  }
  if (usage.entries > limits.maxWorkspaceEntries) {
    throw new Error(
      `validation workspace contains more than ${limits.maxWorkspaceEntries.toLocaleString("en-US")} entries`,
    );
  }
  const filesystem = fs.statfsSync(root);
  if (filesystem.bavail < Math.ceil(limits.minFreeDiskBytes / filesystem.bsize)) {
    throw new Error(`validation filesystem has less than ${formatGiB(limits.minFreeDiskBytes)} GiB free`);
  }
  return usage;
}

function measureWorkspace(
  root: string,
  limits: Pick<ValidationLimits, "maxWorkspaceBytes" | "maxWorkspaceEntries">,
): WorkspaceUsage {
  if (!fs.existsSync(root)) return { bytes: 0, entries: 0 };
  const pending = [path.resolve(root)];
  let bytes = 0;
  let entries = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let names: string[];
    try {
      names = fs.readdirSync(directory);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    for (const name of names) {
      const filename = path.join(directory, name);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(filename);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      entries += 1;
      bytes += stat.size;
      if (bytes > limits.maxWorkspaceBytes || entries > limits.maxWorkspaceEntries) {
        return { bytes, entries };
      }
      if (stat.isDirectory()) pending.push(filename);
    }
  }
  return { bytes, entries };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function formatGiB(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toLocaleString("en-US", { maximumFractionDigits: 2 });
}
