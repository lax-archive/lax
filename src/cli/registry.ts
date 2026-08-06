// The submission registry: `lax init` and `lax build` record every
// submission root they touch so `lax doctor` can check the health of each
// submission on this machine without scanning the filesystem. Entries whose
// manifest.yaml has vanished are pruned on read.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { laxHome } from "../shared/lax-home.js";

export function registryFile(): string {
  return path.join(laxHome(), "submissions.json");
}

function readRoots(): string[] {
  try {
    const value = JSON.parse(fs.readFileSync(registryFile(), "utf8")) as unknown;
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function writeRoots(roots: string[]): void {
  const target = registryFile();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staged = `${target}.${process.pid}-${randomUUID()}`;
  fs.writeFileSync(staged, JSON.stringify(roots, null, 1) + "\n");
  fs.renameSync(staged, target);
}

/** Record a submission root, idempotently. Best-effort: the registry only
 * feeds `lax doctor`, so it never fails the surrounding command. */
export function recordSubmission(root: string): void {
  try {
    const canonical = fs.realpathSync(path.resolve(root));
    const roots = readRoots();
    if (roots.includes(canonical)) return;
    writeRoots([...roots, canonical].sort());
  } catch {
    // best-effort
  }
}

/** The registered submissions that still exist on disk, pruning the rest. */
export function registeredSubmissions(): string[] {
  const roots = readRoots();
  const live = roots.filter((root) => fs.existsSync(path.join(root, "manifest.yaml")));
  if (live.length !== roots.length) {
    try {
      writeRoots(live);
    } catch {
      // best-effort
    }
  }
  return live;
}
