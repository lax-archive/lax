// Trusted-workflow entry point: provision the runner VM with one archive
// environment's toolchain, warm mathlib workspace, and inspector before
// validation starts. `--env <id>` names the environment (the validate job
// passes the one its static gate selected); without it the epoch is
// provisioned, which is what ci.yml and release.yml do. `--cache-key` names
// the Actions cache identity of that provisioning instead of performing it,
// for the restore step that has to precede it. Idempotent; fast when the
// actions cache restored ~/.elan and the warm store; exits nonzero with a
// clear message on failure — including an id the table does not admit.
//
// When LAX_VALIDATION_OUTPUT is set (the trusted workflow always sets it),
// the provisioning spans — elan install, toolchain install, warm workspace,
// inspector build — are recorded into the same validation-profile.json and
// step summary the pipeline uses, replacing the per-job stitching that died
// with the multi-job layout. Profiling is diagnostics only: it never fails
// the setup, and nothing that authenticates a publication reads it.

import fs from "node:fs";
import path from "node:path";
import { Profiler } from "../../shared/profile.js";
import {
  appendProfileStepSummary,
  appendWorkflowOutput,
  recordValidationProfile,
  resetValidationOutputs,
} from "../outputs.js";
import {
  ensureValidationHost,
  parseSetupVmArguments,
  type SetupVmArguments,
  validationHostCacheKey,
} from "./setup.js";

const { environment, cacheKeyOnly } = readArguments();

if (cacheKeyOnly) {
  // Same function the static gate uses, so ci.yml and release.yml share the
  // trusted validate job's store for the epoch. RUNNER_OS is what
  // `${{ runner.os }}` renders; a local call may fall back to the platform.
  const key = validationHostCacheKey(environment, process.env.RUNNER_OS ?? process.platform);
  if (process.env.GITHUB_OUTPUT !== undefined && process.env.GITHUB_OUTPUT !== "") {
    appendWorkflowOutput("cache_key", key);
  }
  console.log(key);
  process.exitCode = 0;
} else {
  const outputDir = validationOutputDirectory();
  const profiler = new Profiler();

  let ok = false;
  try {
    // This is the first provisioning step of a validation run — only the static
    // gate ran before it, and a passing gate leaves nothing behind — so clear
    // any stale outputs: the profile accumulates from here and run.js keeps it.
    if (outputDir !== undefined) resetValidationOutputs(outputDir);
    console.log(`lax setup: provisioning environment ${environment.id}`);
    ok = await ensureValidationHost({ environment, echo: true, profiler });
  } finally {
    const snapshot = profiler.snapshot();
    if (outputDir !== undefined) recordValidationProfile(outputDir, "vm-setup", snapshot);
    appendProfileStepSummary("vm-setup", snapshot);
  }
  process.exitCode = ok ? 0 : 1;
}

/** The id behind --env arrives from the gate's step output through `env:`
 * and is untrusted until the table lookup admits it (trust rule 2); the
 * parser refuses anything the table does not hold, naming the admitted ids. */
function readArguments(): SetupVmArguments {
  try {
    return parseSetupVmArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`lax setup: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

/** Optional here, unlike run.js: local/smoke setups have no output dir. */
function validationOutputDirectory(): string | undefined {
  const value = process.env.LAX_VALIDATION_OUTPUT;
  if (value === undefined || value === "") return undefined;
  const directory = path.resolve(value);
  if (directory === "/" || directory === process.cwd()) {
    throw new Error("LAX_VALIDATION_OUTPUT must be a dedicated directory");
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}
