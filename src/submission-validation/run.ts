// Trusted-workflow validation entry point. One read-only job runs the whole
// pipeline — Compile, Replay, Inspect — sequentially in this single process
// (rewrite-plan.md "Build pipeline"); there is no stage resume, so there is
// no stage state. Exit codes: 0 validation passed, 2 violations, 1 anything
// else. The host must already be provisioned (host/setup-vm.js).

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
import { removeValidationWorkspace } from "./workspace-cleanup.js";

if (process.argv[2] !== undefined) {
  throw new Error("usage: run.js (single-process validation; stage modes no longer exist)");
}

const outputDir = validationOutputDirectory();
const jobDir = path.join(outputDir, "work");
const profiler = new Profiler();

let exitCode = 1;
try {
  // Keep the profile: host/setup-vm.js recorded its provisioning spans there
  // moments ago in this same job. The evidence files are always reset.
  resetValidationOutputs(outputDir, { keepProfile: true });
  removeValidationWorkspace(jobDir);
  fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  const report = await validateSubmission(readRequest(), jobDir, { profiler });
  writeValidationOutputs(outputDir, report);
  exitCode = report.ok ? 0 : 2;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  // Record the timings whatever the outcome: a slow failure is exactly the
  // run whose profile is worth reading.
  const snapshot = profiler.snapshot();
  recordValidationProfile(outputDir, "validate", snapshot);
  appendProfileStepSummary("validate", snapshot);
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
