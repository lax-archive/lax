// Provision the validation host (a trusted-workflow VM, or any machine that
// runs the container smoke) for one archive environment: pinned elan, that
// environment's toolchain, its warm mathlib workspace, and its inspector —
// the same code path local `lax build` uses (ensureLocalWarm/inspectorBinary),
// so the trusted runner and an author's machine can never diverge. Everything
// is idempotent and fast when an actions-cache restored ~/.elan and the warm
// store; the expensive first run prints progress lines throughout.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Profiler } from "../../shared/profile.js";
import {
  admittedEnvironmentList,
  type ArchiveEnvironment,
  environment as environmentById,
  epoch,
} from "../environments.js";
import { ELAN_COMMIT } from "../pins.js";
import { inspectorBinary, inspectorSourceHash } from "./inspector.js";
import { elanHome, toolchainBinDir, toolchainDir } from "./leanenv.js";
import { run } from "./proc.js";
import { ensureLocalWarm } from "./warmstore.js";

/**
 * Ensure elan, one environment's toolchain, its warm store, and its inspector.
 * Returns false (after printing a clear message) on failure; the caller sets
 * the exit code. `lake exe cache get` stays fatal by default: a trusted run
 * must not silently fall back to compiling mathlib for hours. An optional
 * profiler (setup-vm.js passes one) records a span per provisioning step.
 */
export async function ensureValidationHost(
  opts: {
    /** The environment to provision — one at a time, never all of them. */
    environment: ArchiveEnvironment;
    echo?: boolean;
    fromSource?: boolean;
    profiler?: Profiler;
  },
): Promise<boolean> {
  const environment = opts.environment;
  const echo = opts.echo ?? true;
  const span = <T>(name: string, operation: () => Promise<T>): Promise<T> =>
    opts.profiler === undefined ? operation() : opts.profiler.span(name, operation);

  const elanBin = path.join(elanHome(), "bin", "elan");
  if (fs.existsSync(elanBin)) {
    console.log(`lax setup: elan present at ${elanBin}`);
  } else {
    console.log(`lax setup: installing elan (pinned installer ${ELAN_COMMIT.slice(0, 12)})`);
    const install = await span("elan install", () => installElan(elanBin, { echo }));
    if (!install.ok) {
      console.error(`lax setup: ${install.reason}`);
      return false;
    }
  }

  if (fs.existsSync(path.join(toolchainBinDir(environment), "lean"))) {
    console.log(`lax setup: toolchain ${environment.leanToolchain} present at ${toolchainDir(environment)}`);
  } else {
    console.log(`lax setup: installing toolchain ${environment.leanToolchain}`);
    const install = await span("toolchain install", () =>
      run(elanBin, ["toolchain", "install", environment.leanToolchain], os.homedir(), { echo }));
    if (install.code !== 0 || !fs.existsSync(path.join(toolchainBinDir(environment), "lean"))) {
      console.error(`lax setup: could not install the pinned toolchain (exit ${install.code})`);
      return false;
    }
  }

  // put the pinned toolchain itself first on PATH: the warm build and the
  // inspector build below run `lake` directly, not through elan's shims
  process.env.PATH = `${toolchainBinDir(environment)}${path.delimiter}${process.env.PATH ?? ""}`;

  console.log(`lax setup: ensuring the warm mathlib workspace for ${environment.id}`);
  const warm = await span("warm workspace", () =>
    ensureLocalWarm(environment, { echo, fromSource: opts.fromSource }));
  if (warm === undefined) {
    console.error("lax setup: the warm mathlib workspace could not be built (see the transcript above)");
    return false;
  }
  console.log(`lax setup: warm workspace ready at ${warm}`);

  const inspector = await span("inspector build", () => inspectorBinary(environment, { echo }));
  console.log(`lax setup: inspector ready at ${inspector}`);
  console.log("lax setup: validation host ready");
  return true;
}

/**
 * The Actions cache identity of what ensureValidationHost produces for one
 * environment (~/.elan, ~/.lax/warm, ~/.lax/tools): the runner OS, the
 * environment's id, its mathlib commit, and the hash of the inspector sources
 * under its toolchain. Every part derives from the *entry* — the id is a
 * table key by the time it gets here (trust rule 2) — and none of it from the
 * rest of the table, so a monthly admission evicts no other environment's
 * store; a hash of the whole table file would. The salt is bumped by hand
 * when the on-disk layout changes, or when the elan pin moves (elan itself
 * is not in the key: an installed elan is skipped, so a stale one would
 * survive a restore). Deliberately no prefix fallback anywhere it is used: a
 * store for other pins would restore gigabytes of dead weight beside the
 * fresh build.
 */
export const HOST_CACHE_SALT = "lax-validation-host-v2";

export function validationHostCacheKey(environment: ArchiveEnvironment, runnerOs: string): string {
  if (!/^[A-Za-z0-9_-]{1,32}$/u.test(runnerOs)) throw new Error("the runner OS must be a short token");
  return [
    HOST_CACHE_SALT,
    runnerOs,
    environment.id,
    environment.mathlibCommit.slice(0, 12),
    inspectorSourceHash(environment),
  ].join("-");
}

/** What setup-vm.js was asked to do. */
export interface SetupVmArguments {
  /** The environment to provision, or whose cache key to name. */
  environment: ArchiveEnvironment;
  /** `--cache-key`: name the key of what a provisioning run would produce
   * and provision nothing — for the cache restore step that precedes it. */
  cacheKeyOnly: boolean;
}

/**
 * `setup-vm.js [--env <id>] [--cache-key]`. No `--env` means the epoch: that
 * is what ci.yml and release.yml provision, as they provisioned the single pin
 * before there was a table. The trusted validate job passes the id its static
 * gate selected. The id is untrusted wherever it comes from and is only ever
 * a table key: an id the table does not admit is refused here, naming the
 * admitted ids, before anything is resolved to a path or a key from it.
 */
export function parseSetupVmArguments(argv: readonly string[]): SetupVmArguments {
  let id: string | undefined;
  let cacheKeyOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--env") {
      const value = argv[index + 1];
      if (value === undefined || value === "" || value.startsWith("--")) {
        throw new Error("usage: setup-vm.js [--env <id>] [--cache-key] (--env needs an environment id)");
      }
      if (id !== undefined) throw new Error("usage: setup-vm.js [--env <id>] [--cache-key] (--env given twice)");
      id = value;
      index += 1;
    } else if (argument === "--cache-key") {
      cacheKeyOnly = true;
    } else {
      throw new Error(`usage: setup-vm.js [--env <id>] [--cache-key] (unknown argument ${JSON.stringify(argument)})`);
    }
  }
  if (id === undefined) return { environment: epoch(), cacheKeyOnly };
  const environment = environmentById(id);
  if (environment === undefined) {
    throw new Error(
      `environment ${JSON.stringify(id)} is not admitted; the admitted environments are ${admittedEnvironmentList()}`,
    );
  }
  return { environment, cacheKeyOnly };
}

/** Why an install failed, for a caller that renders its own diagnosis. */
export type ElanInstall = { ok: true } | { ok: false; reason: string };

/**
 * Run elan's pinned bootstrap script non-interactively into elanHome().
 *
 * Shared with `lax doctor`, which installs elan the same way on an author's
 * machine — hence the returned reason rather than a printed one: doctor renders
 * a line per check and cannot have a child scribble over its spinner block, so
 * `echo: false` silences the installer's own output too. `--no-modify-path` is
 * deliberate on both paths: nothing in lax resolves elan or lake through PATH
 * (leanenv.ts and doctor's toolBinary() read elanHome()/toolchainBinDir()
 * directly), so editing the user's shell profile would buy nothing lax needs.
 */
export async function installElan(
  elanBin: string,
  opts: { echo?: boolean } = {},
): Promise<ElanInstall> {
  const url = `https://raw.githubusercontent.com/leanprover/elan/${ELAN_COMMIT}/elan-init.sh`;
  let script: string;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    script = await response.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `could not download the pinned elan installer: ${message}` };
  }
  const staged = path.join(os.tmpdir(), `lax-elan-init-${process.pid}.sh`);
  fs.writeFileSync(staged, script, { mode: 0o700 });
  try {
    const installed = await runWithEnv(
      "sh",
      [staged, "-y", "--no-modify-path", "--default-toolchain", "none"],
      { ...process.env, ELAN_HOME: elanHome() } as Record<string, string>,
      opts.echo ?? true,
    );
    if (installed !== 0 || !fs.existsSync(elanBin)) {
      return { ok: false, reason: `elan installation failed (exit ${installed})` };
    }
    return { ok: true };
  } finally {
    fs.rmSync(staged, { force: true });
  }
}

function runWithEnv(
  cmd: string,
  args: string[],
  env: Record<string, string>,
  echo = true,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const stream = echo ? "inherit" : "ignore";
    const child = spawn(cmd, args, { stdio: ["ignore", stream, stream], env });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}
