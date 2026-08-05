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
// Deliberately dependency-free: fake-mathlib.ts (which imports this) runs
// from vitest setup files before the env seam is set, so it must not import
// src/ modules (their constants freeze the env at import time).

import os from "node:os";
import path from "node:path";

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
 * The base dir holding warm workspaces (`warmDir()` keys a workspace inside
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
