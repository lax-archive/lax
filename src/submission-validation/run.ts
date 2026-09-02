// Trusted-workflow validation entry point. One read-only job runs the whole
// pipeline — Compile, Replay, Inspect — sequentially in this single process
// (rewrite-plan.md "Build pipeline"); there is no stage resume, so there is
// no stage state. Exit codes: 0 validation passed, 2 violations, 1 anything
// else. The host must already be provisioned (host/setup-vm.js).
//
// `--gate` runs the same pipeline stopped after dependency resolution, before
// the job restores the toolchain cache and provisions the host: a manifest
// typo then costs seconds instead of a warm-mathlib build. It is not a stage —
// it threads no state to the full run, which re-executes fetch, static
// validation, and resolution from scratch and overwrites every output.

import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import { Profiler } from "../shared/profile.js";
import { decodeUtf8, ValidationError } from "../shared/validation.js";
import {
  type ValidationRequest,
  validationRequestFromUnknown,
} from "./contracts.js";
import {
  appendProfileStepSummary,
  recordValidationProfile,
  resetValidationOutputs,
  writeValidationOutputs,
} from "./outputs.js";
import { validateSubmission } from "./pipeline.js";
import { validationExitCode } from "./failures.js";
import { removeValidationWorkspace } from "./workspace-cleanup.js";

const gate = process.argv[2] === "--gate";
if (process.argv[2] !== undefined && !gate) {
  throw new Error("usage: run.js [--gate] (single-process validation; stage modes no longer exist)");
}

const outputDir = validationOutputDirectory();
const jobDir = path.join(outputDir, "work");
const profiler = new Profiler();

let exitCode = 1;
try {
  // Keep the profile: host/setup-vm.js recorded its provisioning spans there
  // moments ago in this same job. The evidence files are always reset. The
  // gate runs before that setup, so it has no profile to preserve.
  resetValidationOutputs(outputDir, { keepProfile: !gate });
  removeValidationWorkspace(jobDir);
  fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  const report = await validateSubmission(readRequest(), jobDir, {
    profiler,
    ...(gate ? { stopAfter: "resolution" as const } : {}),
  });
  // A passing gate leaves nothing behind: its report is not evidence of a
  // validation (nothing compiled), and the full run writes the real outputs.
  if (!gate || !report.ok) writeValidationOutputs(outputDir, report);
  // A typed failure means no content verdict was reached. Keep exit 2 for an
  // ordinary submission rejection and exit 1 for capacity/infrastructure so
  // callers never have to infer ownership from a transcript.
  exitCode = validationExitCode(report);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  // Record the timings whatever the outcome: a slow failure is exactly the
  // run whose profile is worth reading. The gate's own spans would only be
  // wiped by the host setup that follows it, so it records none.
  if (!gate) {
    const snapshot = profiler.snapshot();
    recordValidationProfile(outputDir, "validate", snapshot);
    appendProfileStepSummary("validate", snapshot);
  }
  removeValidationWorkspace(jobDir);
}
process.exitCode = exitCode;

function readRequest(): ValidationRequest {
  const encoded = requiredEnv("VALIDATION_REQUEST");
  let raw: unknown;
  try {
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) throw new Error("non-canonical base64");
    raw = JSON.parse(decodeUtf8(bytes)) as unknown;
  } catch {
    throw new ValidationError("VALIDATION_REQUEST is not canonical base64-encoded JSON");
  }
  return validationRequestFromUnknown(raw);
}

function validationOutputDirectory(): string {
  const directory = path.resolve(requiredEnv("LAX_VALIDATION_OUTPUT"));
  if (directory === "/" || directory === process.cwd()) {
    throw new Error("LAX_VALIDATION_OUTPUT must be a dedicated directory");
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}
