import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { formatProfile, type Span } from "../shared/profile.js";
import type { ValidationReport } from "./contracts.js";

export const VALIDATION_REPORT_FILENAME = "validation-report.json";
export const GENERATED_BUILD_OUTPUT_FILENAME = "generated-build-output.json";
export const CAPTURE_FILENAME = "capture.tar";
/** The compiled paper, present exactly when the build output records one. */
export const PAPER_FILENAME = "paper.pdf";
/** The derived web bundle, present exactly when the build output records
 * `paper.web` (paper-web-plan.md, "Storage"). */
export const PAPER_WEB_FILENAME = "paper-web.tar";
export const VALIDATION_PROFILE_FILENAME = "validation-profile.json";

/** What the pipeline hands back beyond the report: files still inside the
 * job directory that must leave it before it is removed. */
export interface ValidationOutcome extends ValidationReport {
  /** The compiled paper, when the build output records one. */
  paperPdfPath?: string;
  /** The derived web bundle, when the build output records one. */
  paperWebPath?: string;
}

const MAX_PROFILE_BYTES = 4 * 1024 * 1024;
const MAX_PROFILE_STAGES = 16;

/**
 * Remove only this workflow's known outputs so a reused runner cannot upload
 * stale results. `keepProfile` lets run.js preserve the provisioning spans
 * host/setup-vm.js recorded earlier in the same job — the profile is
 * diagnostics, never authenticated evidence, so keeping it is safe.
 */
export function resetValidationOutputs(
  outputDir: string,
  opts: { keepProfile?: boolean } = {},
): void {
  const filenames = [
    VALIDATION_REPORT_FILENAME,
    GENERATED_BUILD_OUTPUT_FILENAME,
    CAPTURE_FILENAME,
    PAPER_FILENAME,
    PAPER_WEB_FILENAME,
    ...(opts.keepProfile === true ? [] : [VALIDATION_PROFILE_FILENAME]),
  ];
  for (const filename of filenames) {
    fs.rmSync(path.join(outputDir, filename), { force: true });
  }
}

export interface RecordedProfile {
  profileVersion: 1;
  stages: Array<{ stage: string; completedAt: string; totalMs: number; span: Span }>;
}

/**
 * Append this stage's span tree to the accumulating profile: host setup
 * (vm-setup) first, then the pipeline (validate), so the uploaded artifact
 * carries the whole job. Purely diagnostic: this file is not part of the
 * evidence `parseSuccessfulValidationArtifacts` authenticates, and nothing
 * here may fail a validation — every error is swallowed on purpose.
 */
export function recordValidationProfile(outputDir: string, stage: string, root: Span): void {
  try {
    const filename = path.join(outputDir, VALIDATION_PROFILE_FILENAME);
    const profile = readProfile(filename);
    profile.stages.push({
      stage,
      completedAt: new Date().toISOString(),
      totalMs: Math.round(root.ms),
      span: root,
    });
    if (profile.stages.length > MAX_PROFILE_STAGES) {
      profile.stages.splice(0, profile.stages.length - MAX_PROFILE_STAGES);
    }
    atomicWriteJson(filename, profile);
  } catch {
    // Profiling never breaks a run.
  }
}

/** Echo the span tree into the workflow run's step summary when there is one. */
export function appendProfileStepSummary(stage: string, root: Span): void {
  const filename = process.env.GITHUB_STEP_SUMMARY;
  if (filename === undefined || filename === "") return;
  try {
    fs.appendFileSync(
      filename,
      `\n### lax validation profile — ${stage}\n\n\`\`\`\n${formatProfile(root)}\n\`\`\`\n`,
      "utf8",
    );
  } catch {
    // Profiling never breaks a run.
  }
}

function readProfile(filename: string): RecordedProfile {
  const fresh: RecordedProfile = { profileVersion: 1, stages: [] };
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filename);
  } catch {
    return fresh;
  }
  if (!stat.isFile() || stat.size > MAX_PROFILE_BYTES) return fresh;
  try {
    const value = JSON.parse(fs.readFileSync(filename, "utf8")) as RecordedProfile;
    if (value.profileVersion !== 1 || !Array.isArray(value.stages)) return fresh;
    return value;
  } catch {
    return fresh;
  }
}

/**
 * Persist non-authoritative validation artifacts. The trusted publisher still
 * constructs record.json and the final build-output.json with its id and issue
 * binding after re-reading the current database state.
 */
export function writeValidationOutputs(outputDir: string, outcome: ValidationOutcome): void {
  // The PDF and bundle paths are the job's, not the report's: the serialized
  // report keeps exactly the shape parseSuccessfulValidationArtifacts accepts.
  const { paperPdfPath, paperWebPath, ...report } = outcome;
  if (!report.ok) {
    if (report.failure !== undefined && report.violations.length > 0) {
      throw new Error("a validation report cannot contain both an operational failure and submission violations");
    }
    if (report.failure === undefined && report.violations.length === 0) {
      throw new Error("an unsuccessful validation report must describe a failure or a submission violation");
    }
    atomicWriteJson(path.join(outputDir, VALIDATION_REPORT_FILENAME), report);
    return;
  }
  if (report.failure !== undefined) {
    throw new Error("a successful validation report cannot contain an operational failure");
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
  // The paper travels beside the capture, bound by the digest the build
  // output records — present exactly when a paper was recorded.
  const paper = report.buildOutput.paper;
  if ((paper === undefined) !== (paperPdfPath === undefined)) {
    throw new Error("successful full validation recorded a paper without its PDF, or a PDF without a paper");
  }
  if (paper !== undefined && paperPdfPath !== undefined) {
    const bytes = fs.readFileSync(paperPdfPath);
    if (bytes.length !== paper.pdf.bytes || createHash("sha256").update(bytes).digest("hex") !== paper.pdf.digest) {
      throw new Error("the compiled paper does not match the digest its build output records");
    }
    fs.writeFileSync(path.join(outputDir, PAPER_FILENAME), bytes, { mode: 0o600 });
  }
  // The derived web bundle travels the same way, bound by its recorded
  // content address — present exactly when `paper.web` was recorded.
  const web = paper?.web;
  if ((web === undefined) !== (paperWebPath === undefined)) {
    throw new Error("successful full validation recorded a web view without its bundle, or a bundle without a web view");
  }
  if (web !== undefined && paperWebPath !== undefined) {
    const bytes = fs.readFileSync(paperWebPath);
    if (bytes.length !== web.bundle.bytes || createHash("sha256").update(bytes).digest("hex") !== web.bundle.digest) {
      throw new Error("the derived web bundle does not match the digest its build output records");
    }
    fs.writeFileSync(path.join(outputDir, PAPER_WEB_FILENAME), bytes, { mode: 0o600 });
  }

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
