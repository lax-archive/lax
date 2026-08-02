import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CaptureManifest, ValidationReport } from "../../src/submission-validation/contracts.js";
import {
  CAPTURE_FILENAME,
  GENERATED_BUILD_OUTPUT_FILENAME,
  resetValidationOutputs,
  VALIDATION_REPORT_FILENAME,
  writeValidationOutputs,
} from "../../src/submission-validation/outputs.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("submission validation outputs", () => {
  it("writes a standalone non-authoritative build-output payload after success", () => {
    const directory = temporaryDirectory();
    const report = successfulReport();
    fs.writeFileSync(path.join(directory, CAPTURE_FILENAME), "capture", { mode: 0o600 });

    writeValidationOutputs(directory, report);

    expect(readJson(path.join(directory, GENERATED_BUILD_OUTPUT_FILENAME))).toEqual(report.buildOutput);
    expect(readJson(path.join(directory, VALIDATION_REPORT_FILENAME))).toEqual(report);
    expect(report.buildOutput).not.toHaveProperty("specVersion");
    expect(report.buildOutput).not.toHaveProperty("id");
    expect(report.buildOutput).not.toHaveProperty("issue");
  });

  it("removes stale successful outputs before recording a failed validation", () => {
    const directory = temporaryDirectory();
    for (const filename of [
      VALIDATION_REPORT_FILENAME,
      GENERATED_BUILD_OUTPUT_FILENAME,
      CAPTURE_FILENAME,
    ]) fs.writeFileSync(path.join(directory, filename), "stale");

    resetValidationOutputs(directory);
    const report: ValidationReport = {
      ...baseReport(),
      ok: false,
      violations: [{ phase: "static", rule: "manifest", message: "manifest is invalid" }],
    };
    writeValidationOutputs(directory, report);

    expect(readJson(path.join(directory, VALIDATION_REPORT_FILENAME))).toEqual(report);
    expect(fs.existsSync(path.join(directory, GENERATED_BUILD_OUTPUT_FILENAME))).toBe(false);
    expect(fs.existsSync(path.join(directory, CAPTURE_FILENAME))).toBe(false);
  });

  it("does not publish a success report unless the complete output set exists", () => {
    const directory = temporaryDirectory();
    expect(() => writeValidationOutputs(directory, successfulReport())).toThrow("no capture.tar");
    expect(fs.existsSync(path.join(directory, VALIDATION_REPORT_FILENAME))).toBe(false);
    expect(fs.existsSync(path.join(directory, GENERATED_BUILD_OUTPUT_FILENAME))).toBe(false);
  });

  it("rejects database-owned fields in the generated payload", () => {
    const directory = temporaryDirectory();
    const report = successfulReport();
    Object.assign(report.buildOutput!, {
      issue: { repositoryId: 123456789, number: 42 },
    });
    fs.writeFileSync(path.join(directory, CAPTURE_FILENAME), "capture", { mode: 0o600 });

    expect(() => writeValidationOutputs(directory, report)).toThrow("trusted field issue");
    expect(fs.existsSync(path.join(directory, VALIDATION_REPORT_FILENAME))).toBe(false);
    expect(fs.existsSync(path.join(directory, GENERATED_BUILD_OUTPUT_FILENAME))).toBe(false);
  });
});

function successfulReport(): ValidationReport {
  const capture: CaptureManifest = {
    formatVersion: 1,
    digest: "a".repeat(64),
    sourceCommit: "b".repeat(40),
    leanToolchain: "leanprover/lean4:v4.30.0",
    mathlibCommit: "c".repeat(40),
    files: [{ path: "concepts/lib/Lax42.olean", bytes: 7, sha256: "d".repeat(64) }],
  };
  return {
    ...baseReport(),
    ok: true,
    buildOutput: {
      inputs: {
        manifest: {
          specVersion: "1",
          id: "lax-42",
          leanVersion: "v4.30.0",
          mathlibVersion: "c".repeat(40),
          title: "Example",
          authors: [{ name: "Alice" }],
          bibEntries: [],
        },
        abstract: "An example.",
      },
      requiredByConcepts: [],
      requiredByProofs: [],
      concepts: [],
      proofs: [],
      capture,
    },
    capture,
  };
}

function baseReport(): Omit<ValidationReport, "ok"> {
  return {
    reportVersion: 1,
    request: {
      requestVersion: 1,
      id: "lax-42",
      source: {
        repository: "https://github.com/alice/example",
        commit: "b".repeat(40),
        folder: ".",
      },
      archiveSha: "e".repeat(40),
    },
    runtime: {
      image: `ghcr.io/lax-archive/validation@sha256:${"f".repeat(64)}`,
      imageDigest: "f".repeat(64),
      layoutVersion: 1,
      leanToolchain: "leanprover/lean4:v4.30.0",
      leanVersion: "v4.30.0",
      mathlibRepository: "https://github.com/leanprover-community/mathlib4",
      mathlibCommit: "c".repeat(40),
    },
    dependencies: [],
    warnings: [],
    violations: [],
  };
}

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lax-validation-output-"));
  temporaryDirectories.push(directory);
  return directory;
}

function readJson(filename: string): unknown {
  return JSON.parse(fs.readFileSync(filename, "utf8")) as unknown;
}
