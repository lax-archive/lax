// How host Replay and Inspect invoke toolchain binaries: always directly,
// with a pipeline-composed LEAN_PATH — never `lake env`, whose search path
// derives from workspace files Compile wrote. The entries point at the
// captured artifacts, the materialized dependency captures, and the warm
// workspace lax itself provisioned — the local mirror of the trusted
// container's composed path (runtime/run-check.mjs), so a local build
// exercises the same gate registration enforces.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEAN_TOOLCHAIN } from "../pins.js";
import { run, type RunResult } from "./proc.js";

export interface LeanEnv {
  /** absolute path of leanchecker inside the pinned toolchain */
  leancheckerBin: string;
  /** run a binary with the composed LEAN_PATH from the given directory */
  exec: (bin: string, args: string[], cwd: string) => Promise<RunResult>;
}

export function elanHome(): string {
  return process.env.ELAN_HOME ?? path.join(os.homedir(), ".elan");
}

/** bin/ of the pinned toolchain inside elan's home (elan's directory naming:
 * `leanprover/lean4:v4.30.0` -> `leanprover--lean4---v4.30.0`). */
export function toolchainBinDir(): string {
  const name = LEAN_TOOLCHAIN.replace("/", "--").replace(":", "---");
  return path.join(elanHome(), "toolchains", name, "bin");
}

export function leancheckerBin(): string {
  return path.join(toolchainBinDir(), "leanchecker");
}

export function packageLibDir(packageDir: string): string {
  return path.join(packageDir, ".lake", "build", "lib", "lean");
}

/** Lib dirs of a warm workspace's `.lake/packages` — mathlib and its upstream
 * dependencies at their canonical build paths. */
export function workspaceLibDirs(ws: string): string[] {
  const pkgs = path.join(ws, ".lake", "packages");
  if (!fs.existsSync(pkgs)) return [];
  const dirs: string[] = [];
  for (const name of fs.readdirSync(pkgs).sort()) {
    const lib = packageLibDir(path.join(pkgs, name));
    if (fs.existsSync(lib)) dirs.push(lib);
  }
  return dirs;
}

/**
 * The host pipeline's LeanEnv: LEAN_PATH over the given own lib dirs (the
 * captured package artifacts), the materialized dependency captures' lib
 * dirs, and the warm workspace's mathlib dirs — the local mirror of the
 * container's composed path. Entries are realpath'd where they may be
 * symlinks (test homes symlink the warm workspace into a shared cache;
 * leanchecker's module scan is symlink-blind).
 */
export function hostLeanEnv(
  ownLibs: string[],
  depLibDirs: string[],
  warmWs: string,
  leanThreads?: number,
): LeanEnv {
  const leanPath = [
    ...ownLibs,
    ...depLibDirs,
    ...workspaceLibDirs(fs.existsSync(warmWs) ? fs.realpathSync(warmWs) : warmWs),
  ].map((entry) => (fs.existsSync(entry) ? fs.realpathSync(entry) : entry));
  const env = {
    LEAN_PATH: leanPath.join(path.delimiter),
    PATH: `${toolchainBinDir()}${path.delimiter}${process.env.PATH ?? ""}`,
    // The same worker budget the container checks pin (see history/oom.md);
    // leanchecker and the inspector replay modules concurrently.
    ...(leanThreads === undefined ? {} : { LEAN_NUM_THREADS: String(leanThreads) }),
  };
  return {
    leancheckerBin: leancheckerBin(),
    exec: (bin, args, cwd) => run(bin, args, cwd, { env }),
  };
}
