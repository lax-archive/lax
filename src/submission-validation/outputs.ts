import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ValidationReport } from "./contracts.js";

export const VALIDATION_REPORT_FILENAME = "validation-report.json";
export const GENERATED_BUILD_OUTPUT_FILENAME = "generated-build-output.json";
export const CAPTURE_FILENAME = "capture.tar";

/** Remove only this workflow's known outputs so a reused runner cannot upload stale results. */
export function resetValidationOutputs(outputDir: string): void {
  for (const filename of [
    VALIDATION_REPORT_FILENAME,
    GENERATED_BUILD_OUTPUT_FILENAME,
    CAPTURE_FILENAME,
  ]) {
    fs.rmSync(path.join(outputDir, filename), { force: true });
  }
}

/**
 * Persist non-authoritative validation artifacts. The trusted publisher still
 * constructs record.json and the final build-output.json with its id and issue
 * binding after re-reading the current database state.
 */
export function writeValidationOutputs(outputDir: string, report: ValidationReport): void {
  if (!report.ok) {
    atomicWriteJson(path.join(outputDir, VALIDATION_REPORT_FILENAME), report);
    return;
  }
  if (report.buildOutput === undefined || report.capture === undefined) {
    throw new Error("successful full validation produced no build output or capture manifest");
  }
  for (const trustedKey of ["specVersion", "id", "issue", "state", "status"]) {
    if (trustedKey in report.buildOutput) {
      throw new Error(`generated build output must not supply trusted field ${trustedKey}`);
    }
  }
  if (JSON.stringify(report.buildOutput.capture) !== JSON.stringify(report.capture)) {
    throw new Error("generated build output and validation report have different capture manifests");
  }
  const capturePath = path.join(outputDir, CAPTURE_FILENAME);
  let captureStat: fs.Stats;
  try {
    captureStat = fs.lstatSync(capturePath);
  } catch {
    throw new Error("successful full validation produced no capture.tar");
  }
  if (!captureStat.isFile()) throw new Error("validation capture must be a regular file");

  // Write the report last. Consumers treat its presence as the indication that
  // the complete output set was persisted successfully.
  atomicWriteJson(
    path.join(outputDir, GENERATED_BUILD_OUTPUT_FILENAME),
    report.buildOutput,
  );
  atomicWriteJson(path.join(outputDir, VALIDATION_REPORT_FILENAME), report);
}

function atomicWriteJson(filename: string, value: unknown): void {
  const temporary = path.join(
    path.dirname(filename),
    `.${path.basename(filename)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporary, filename);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
