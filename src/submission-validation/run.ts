import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import { decodeUtf8, ValidationError } from "../shared/validation.js";
import { validationRequestFromUnknown } from "./contracts.js";
import { resetValidationOutputs, writeValidationOutputs } from "./outputs.js";
import { validateSubmission } from "./pipeline.js";
import { removeValidationWorkspace } from "./workspace-cleanup.js";

const outputDir = path.resolve(requiredEnv("LAX_VALIDATION_OUTPUT"));
if (outputDir === "/" || outputDir === process.cwd()) throw new Error("LAX_VALIDATION_OUTPUT must be a dedicated directory");
fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
resetValidationOutputs(outputDir);
const jobDir = path.join(outputDir, "work");
removeValidationWorkspace(jobDir);
fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });

let exitCode = 1;
try {
  const encoded = requiredEnv("VALIDATION_REQUEST");
  let raw: unknown;
  try {
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) throw new Error("non-canonical base64");
    raw = JSON.parse(decodeUtf8(bytes)) as unknown;
  } catch {
    throw new ValidationError("VALIDATION_REQUEST is not canonical base64-encoded JSON");
  }
  const request = validationRequestFromUnknown(raw);
  const report = await validateSubmission(request, jobDir);
  writeValidationOutputs(outputDir, report);
  exitCode = report.ok ? 0 : 2;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  removeValidationWorkspace(jobDir);
}
process.exitCode = exitCode;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}
