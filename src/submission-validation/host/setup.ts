// Provision the validation host (a trusted-workflow VM, or any machine that
// runs the container smoke): pinned elan + toolchain, the warm mathlib
// workspace, and the inspector binary — the same code path local `lax build`
// uses (ensureLocalWarm/inspectorBinary), so the trusted runner and an
// author's machine can never diverge. Everything is idempotent and fast when
// an actions-cache restored ~/.elan and the warm store; the expensive first
// run prints progress lines throughout.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Profiler } from "../../shared/profile.js";
import { ELAN_COMMIT, LEAN_TOOLCHAIN } from "../pins.js";
import { inspectorBinary } from "./inspector.js";
import { elanHome, toolchainBinDir, toolchainDir } from "./leanenv.js";
import { run } from "./proc.js";
import { ensureLocalWarm } from "./warmstore.js";

/**
 * Ensure elan, the pinned toolchain, the warm store, and the inspector.
 * Returns false (after printing a clear message) on failure; the caller sets
 * the exit code. `lake exe cache get` stays fatal by default: a trusted run
 * must not silently fall back to compiling mathlib for hours. An optional
 * profiler (setup-vm.js passes one) records a span per provisioning step.
 */
export async function ensureValidationHost(
  opts: { echo?: boolean; fromSource?: boolean; profiler?: Profiler } = {},
): Promise<boolean> {
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

  if (fs.existsSync(path.join(toolchainBinDir(), "lean"))) {
    console.log(`lax setup: toolchain ${LEAN_TOOLCHAIN} present at ${toolchainDir()}`);
  } else {
    console.log(`lax setup: installing toolchain ${LEAN_TOOLCHAIN}`);
    const install = await span("toolchain install", () =>
      run(elanBin, ["toolchain", "install", LEAN_TOOLCHAIN], os.homedir(), { echo }));
    if (install.code !== 0 || !fs.existsSync(path.join(toolchainBinDir(), "lean"))) {
      console.error(`lax setup: could not install the pinned toolchain (exit ${install.code})`);
      return false;
    }
  }

  // put the pinned toolchain itself first on PATH: the warm build and the
  // inspector build below run `lake` directly, not through elan's shims
  process.env.PATH = `${toolchainBinDir()}${path.delimiter}${process.env.PATH ?? ""}`;

  console.log("lax setup: ensuring the warm mathlib workspace");
  const warm = await span("warm workspace", () =>
    ensureLocalWarm({ echo, fromSource: opts.fromSource }));
  if (warm === undefined) {
    console.error("lax setup: the warm mathlib workspace could not be built (see the transcript above)");
    return false;
  }
  console.log(`lax setup: warm workspace ready at ${warm}`);

  const inspector = await span("inspector build", () => inspectorBinary({ echo }));
  console.log(`lax setup: inspector ready at ${inspector}`);
  console.log("lax setup: validation host ready");
  return true;
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
