// The submission registry: `lax init` and `lax build` record every
// submission root they touch so `lax doctor` can check the health of each
// submission on this machine without scanning the filesystem. Entries whose
// manifest.yaml has vanished are pruned on read.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { laxHome } from "../shared/lax-home.js";
import { submissionIdFromFolder } from "./manifest.js";

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

/**
 * Drop every registered root whose manifest carries this id — `lax delete`
 * deleted the submission, so `lax doctor` has nothing left to check there.
 * The folder itself stays; only the registry forgets it. Best-effort like
 * the rest of the registry, and a root whose manifest cannot be read keeps
 * its entry (the read-side pruning owns vanished manifests).
 */
export function forgetSubmissionsById(id: string): string[] {
  try {
    const roots = readRoots();
    const kept: string[] = [];
    const dropped: string[] = [];
    for (const root of roots) {
      let rootId: string | undefined;
      try {
        rootId = submissionIdFromFolder(root);
      } catch {
        rootId = undefined;
      }
      (rootId === id ? dropped : kept).push(root);
    }
    if (dropped.length > 0) writeRoots(kept);
    return dropped;
  } catch {
    return [];
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
