// Trusted-workflow entry point: provision the runner VM with the pinned
// toolchain and warm mathlib workspace before validation starts. Idempotent;
// fast when the actions cache restored ~/.elan and the warm store; exits
// nonzero with a clear message on failure.
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
  recordValidationProfile,
  resetValidationOutputs,
} from "../outputs.js";
import { ensureValidationHost } from "./setup.js";

const outputDir = validationOutputDirectory();
const profiler = new Profiler();

let ok = false;
try {
  // This is the first provisioning step of a validation run — only the static
  // gate ran before it, and a passing gate leaves nothing behind — so clear
  // any stale outputs: the profile accumulates from here and run.js keeps it.
  if (outputDir !== undefined) resetValidationOutputs(outputDir);
  ok = await ensureValidationHost({ echo: true, profiler });
} finally {
  const snapshot = profiler.snapshot();
  if (outputDir !== undefined) recordValidationProfile(outputDir, "vm-setup", snapshot);
  appendProfileStepSummary("vm-setup", snapshot);
}
process.exitCode = ok ? 0 : 1;

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
