// Where the test suite's machine-shared, expensive-to-rebuild state lives.
//
// These are caches in the strict sense: regenerable, safe to delete, and far
// too costly to rebuild per run (the real warm mathlib workspace is ~7.5 GB,
// the inspector build ~100 MB). They therefore live under the XDG cache root
// rather than in `os.tmpdir()`, which on a typical Linux box is cleared at
// boot (`D /tmp` in tmpfiles.d) — a reboot used to cost a full mathlib
// re-download on the next LAX_E2E run. Per-test scratch dirs still go to
// `os.tmpdir()`; only the shared, durable state is here.
//
// Importing src/ from here is fine: every pin is read at call time now (see
// src/submission-validation/environments.ts), so nothing freezes the mathlib
// seam at import.

import os from "node:os";
import path from "node:path";
import { epoch } from "../src/submission-validation/environments.js";
import { elanHome, toolchainBinDir } from "../src/submission-validation/host/leanenv.js";

/** The CLI's own home as the *user* sees it, captured before any test
 * repoints LAX_HOME at a temp dir (see sharedWarmBase). */
const userLaxHome = process.env.LAX_HOME ?? path.join(os.homedir(), ".lax");

/** Root of the shared test cache: $LAX_TEST_CACHE, else
 * $XDG_CACHE_HOME/lax-test, else ~/.cache/lax-test. */
export const TEST_CACHE =
  process.env.LAX_TEST_CACHE ??
  path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "lax-test");

/** The fake mathlib git fixture (see fake-mathlib.ts). */
export const FAKE_MATHLIB_FIXTURE = path.join(TEST_CACHE, "fake-mathlib");

/** The inspector build, shared by every test home so it is built once per
 * machine rather than once per LAX_HOME. */
export const SHARED_TOOLS = path.join(TEST_CACHE, "tools");

/** The mathlib e2e's stable submission dir: its `.lake/` trees survive
 * across runs, so the suite never re-seeds mathlib from scratch. */
export const E2E_WORKSPACE = path.join(TEST_CACHE, "e2e-workspace");

/**
 * The base dir holding warm workspaces (`warmDir(env)` keys a workspace inside
 * it by toolchain + mathlib rev).
 *
 * Under LAX_E2E the pin is the *real* one — exactly the workspace the CLI
 * builds at `~/.lax/warm` for its own `lax build`. Sharing that rather than
 * keeping a test-owned copy saves ~7.5 GB and makes the first e2e run free on
 * any machine where `lax build` has ever run. It is the same directory built
 * by the same code, keyed by pin and made read-only after the build, so the
 * two uses cannot diverge. The fast tests keep their own base: their pin is
 * the fake mathlib, which has no business in the user's real home.
 */
export function sharedWarmBase(): string {
  return process.env.LAX_E2E === "1"
    ? path.join(userLaxHome, "warm")
    : path.join(TEST_CACHE, "warm");
}

/**
 * Put the epoch toolchain's bin dir and elan's own bin dir first on PATH,
 * mirroring ensureValidationHost (host/setup.ts): the warm/inspector builds
 * and the host pipeline spawn `lake` by name, and CLI subprocesses preflight
 * `elan` — the suite must find them even when the caller's PATH has neither
 * (CI provisions ~/.elan but never edits the step's PATH). Every injected test
 * environment shares that one installed toolchain, so one call covers them all.
 */
export function putToolchainOnPath(): void {
  const current = (process.env.PATH ?? "").split(path.delimiter);
  const missing = [toolchainBinDir(epoch()), path.join(elanHome(), "bin")].filter(
    (dir) => !current.includes(dir),
  );
  if (missing.length > 0) process.env.PATH = [...missing, ...current].join(path.delimiter);
}
