// How host Replay and Inspect invoke toolchain binaries: always directly,
// with a pipeline-composed LEAN_PATH — never `lake env`, whose search path
// derives from workspace files Compile wrote. The entries point at the
// captured artifacts, the dependency packages lake built from source
// in-workspace, and the warm workspace lax itself provisioned — the local
// mirror of the trusted container's composed path
// (sandbox/tools/run-check.mjs), so a local build exercises the same gate
// registration enforces.

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

/** The pinned toolchain's directory inside elan's home (elan's directory
 * naming: `leanprover/lean4:v4.30.0` -> `leanprover--lean4---v4.30.0`). The
 * sandbox bind-mounts this whole directory read-only into the container. */
export function toolchainDir(): string {
  const name = LEAN_TOOLCHAIN.replace("/", "--").replace(":", "---");
  return path.join(elanHome(), "toolchains", name);
}

/** bin/ of the pinned toolchain. */
export function toolchainBinDir(): string {
  return path.join(toolchainDir(), "bin");
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
 * captured package artifacts), the in-workspace-built dependency packages'
 * lib dirs, and the warm workspace's mathlib dirs — the local mirror of the
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

/**
 * The lake this build runs: the pinned toolchain's own binary when it is
 * installed where lax puts it, and a PATH lookup only otherwise.
 *
 * elan is installed with `--no-modify-path` (setup.ts, doctor), so on a
 * machine lax provisioned nothing lax needs is on the user's PATH — a bare
 * `lake` there is either absent (`spawn lake ENOENT`, having passed a
 * preflight that probed the installed binary) or some other elan's shim,
 * which resolves `elan default` and would build against a toolchain no lax
 * build ever uses. Same reasoning as doctor's `toolBinary()`; the fallback
 * keeps a developer's own toolchain working.
 */
export function lakeBinary(): string {
  const owned = path.join(toolchainBinDir(), "lake");
  return fs.existsSync(owned) ? owned : "lake";
}

/**
 * PATH for a host lake invocation: the pinned toolchain's bin dir first, for
 * the tools lake's children look up by name rather than in the sysroot
 * (mathlib's `cache` needs `leantar`). `ensureValidationHost` prepends the
 * same dir to its own process environment, but it runs only on the trusted
 * VM — `lax build` and `lax doctor` never call it, so every host lake
 * invocation must carry this itself.
 */
export function lakePathEnv(): string {
  return `${toolchainBinDir()}${path.delimiter}${process.env.PATH ?? ""}`;
}
