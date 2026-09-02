import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CaptureManifest, ValidationReport } from "../../src/submission-validation/contracts.js";
import {
  CAPTURE_FILENAME,
  GENERATED_BUILD_OUTPUT_FILENAME,
  PAPER_FILENAME,
  PAPER_WEB_FILENAME,
  resetValidationOutputs,
  VALIDATION_REPORT_FILENAME,
  type ValidationOutcome,
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

  it("writes a typed operational failure without manufacturing a violation", () => {
    const directory = temporaryDirectory();
    const report: ValidationReport = {
      ...baseReport(),
      ok: false,
      failure: {
        kind: "infrastructure",
        retryable: true,
        phase: "source",
        rule: "archive-snapshot",
        message: "GitHub returned HTTP 503",
      },
    };

    writeValidationOutputs(directory, report);

    expect(readJson(path.join(directory, VALIDATION_REPORT_FILENAME))).toEqual(report);
    expect(report.violations).toEqual([]);
  });

  it("rejects contradictory or unexplained unsuccessful reports", () => {
    const directory = temporaryDirectory();
    const failure = {
      kind: "resource-limit" as const,
      retryable: false,
      phase: "compile-concepts" as const,
      rule: "compile",
      message: "memory limit",
    };
    expect(() => writeValidationOutputs(directory, {
      ...baseReport(),
      ok: false,
      failure,
      violations: [{ phase: "static", rule: "manifest", message: "invalid" }],
    })).toThrow("both an operational failure and submission violations");
    expect(() => writeValidationOutputs(directory, { ...baseReport(), ok: false }))
      .toThrow("must describe a failure or a submission violation");
  });

  it("does not publish a success report unless the complete output set exists", () => {
    const directory = temporaryDirectory();
    expect(() => writeValidationOutputs(directory, successfulReport())).toThrow("no capture.tar");
    expect(fs.existsSync(path.join(directory, VALIDATION_REPORT_FILENAME))).toBe(false);
    expect(fs.existsSync(path.join(directory, GENERATED_BUILD_OUTPUT_FILENAME))).toBe(false);
  });

  it("copies a recorded paper beside the capture, bound by its digest, and keeps the path out of the report", () => {
    const directory = temporaryDirectory();
    const pdf = Buffer.from("%PDF-1.7 fixture");
    const outcome = paperOutcome(pdf);
    fs.writeFileSync(path.join(directory, CAPTURE_FILENAME), "capture", { mode: 0o600 });

    writeValidationOutputs(directory, outcome);

    expect(fs.readFileSync(path.join(directory, PAPER_FILENAME))).toEqual(pdf);
    const { paperPdfPath, ...report } = outcome;
    expect(readJson(path.join(directory, VALIDATION_REPORT_FILENAME))).toEqual(report);
    expect(readJson(path.join(directory, VALIDATION_REPORT_FILENAME))).not.toHaveProperty("paperPdfPath");
    expect(fs.existsSync(paperPdfPath!)).toBe(true);

    // A stale paper.pdf never survives into a run that records none.
    resetValidationOutputs(directory);
    expect(fs.existsSync(path.join(directory, PAPER_FILENAME))).toBe(false);
  });

  it("refuses a paper that does not match its recorded digest, and a paper without its PDF", () => {
    const directory = temporaryDirectory();
    fs.writeFileSync(path.join(directory, CAPTURE_FILENAME), "capture", { mode: 0o600 });
    const tampered = paperOutcome(Buffer.from("%PDF-1.7 fixture"));
    fs.writeFileSync(tampered.paperPdfPath!, "%PDF-1.7 other bytes");
    expect(() => writeValidationOutputs(directory, tampered)).toThrow("does not match the digest");
    expect(fs.existsSync(path.join(directory, VALIDATION_REPORT_FILENAME))).toBe(false);
    expect(fs.existsSync(path.join(directory, PAPER_FILENAME))).toBe(false);

    const { paperPdfPath, ...withoutPdf } = paperOutcome(Buffer.from("%PDF-1.7 fixture"));
    expect(() => writeValidationOutputs(directory, withoutPdf)).toThrow("recorded a paper without its PDF");
    const strayPdf: ValidationOutcome = { ...successfulReport(), paperPdfPath };
    expect(() => writeValidationOutputs(directory, strayPdf)).toThrow("a PDF without a paper");
  });

  it("copies a recorded web bundle bound by its digest, and resets it with the rest", () => {
    const directory = temporaryDirectory();
    const bundle = Buffer.from("a deterministic tar stand-in");
    const outcome = webOutcome(bundle);
    fs.writeFileSync(path.join(directory, CAPTURE_FILENAME), "capture", { mode: 0o600 });

    writeValidationOutputs(directory, outcome);

    expect(fs.readFileSync(path.join(directory, PAPER_WEB_FILENAME))).toEqual(bundle);
    const { paperPdfPath, paperWebPath, ...report } = outcome;
    expect(readJson(path.join(directory, VALIDATION_REPORT_FILENAME))).toEqual(report);
    expect(readJson(path.join(directory, VALIDATION_REPORT_FILENAME))).not.toHaveProperty("paperWebPath");
    expect(fs.existsSync(paperWebPath!)).toBe(true);

    // A stale paper-web.tar never survives into a run that records none.
    resetValidationOutputs(directory);
    expect(fs.existsSync(path.join(directory, PAPER_WEB_FILENAME))).toBe(false);
  });

  it("refuses a tampered bundle, a web view without its tar, and a tar without a web view", () => {
    const directory = temporaryDirectory();
    fs.writeFileSync(path.join(directory, CAPTURE_FILENAME), "capture", { mode: 0o600 });
    const tampered = webOutcome(Buffer.from("the sealed bundle"));
    fs.writeFileSync(tampered.paperWebPath!, "other bytes entirely");
    expect(() => writeValidationOutputs(directory, tampered)).toThrow(
      "the derived web bundle does not match the digest its build output records",
    );
    expect(fs.existsSync(path.join(directory, VALIDATION_REPORT_FILENAME))).toBe(false);
    expect(fs.existsSync(path.join(directory, PAPER_WEB_FILENAME))).toBe(false);

    const { paperWebPath, ...withoutTar } = webOutcome(Buffer.from("the sealed bundle"));
    expect(() => writeValidationOutputs(directory, withoutTar)).toThrow(
      "recorded a web view without its bundle",
    );
    const strayTar: ValidationOutcome = { ...paperOutcome(Buffer.from("%PDF-1.7 fixture")), paperWebPath };
    expect(() => writeValidationOutputs(directory, strayTar)).toThrow("a bundle without a web view");
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

/** A successful outcome whose build output records `pdf` as its paper. */
function paperOutcome(pdf: Buffer): ValidationOutcome {
  const report = successfulReport();
  const pdfPath = path.join(temporaryDirectory(), "main.pdf");
  fs.writeFileSync(pdfPath, pdf);
  report.buildOutput!.inputs.manifest.paper = { folder: "paper", main: "main.tex", engine: "pdflatex" };
  report.buildOutput!.paper = {
    folder: "paper",
    main: "main.tex",
    engine: "pdflatex",
    pdf: { digest: createHash("sha256").update(pdf).digest("hex"), bytes: pdf.length, pages: 1 },
    pageSizes: [[612, 792]],
    marks: [],
  };
  return { ...report, paperPdfPath: pdfPath };
}

/** A paper outcome whose build output additionally records a derived web
 * view, with `bundle` as the sealed tar. */
function webOutcome(bundle: Buffer): ValidationOutcome {
  const outcome = paperOutcome(Buffer.from("%PDF-1.7 fixture"));
  const bundlePath = path.join(temporaryDirectory(), "paper-web.tar");
  fs.writeFileSync(bundlePath, bundle);
  outcome.buildOutput!.paper!.web = {
    format: { tool: "reflowtex", rev: "a".repeat(40), schema: "b".repeat(64) },
    bundle: { digest: createHash("sha256").update(bundle).digest("hex"), bytes: bundle.length },
  };
  return { ...outcome, paperWebPath: bundlePath };
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
