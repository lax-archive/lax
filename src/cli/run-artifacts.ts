// The validation report, read from the Actions run instead of from an issue
// comment. The validate job is credential-free and its artifact is its only
// egress; that artifact is now also the channel the author's terminal reads,
// so a failed submit prints the same findings `lax build` prints locally
// instead of a markdown summary of them.
//
// Everything in the report is untrusted display input — a finding's message is
// whatever the submission made Lean print — so the zip is opened under hard
// bounds, the shape is checked before anything is read out of it, and every
// string is sanitized for the terminal here rather than at the print site.

import { setTimeout as delay } from "node:timers/promises";
import { unzipSync, type UnzipFileInfo } from "fflate";
import { CONTROL_REPOSITORY } from "../shared/constants.js";
import { GitHubError, repositoryPath, type GitHubClient } from "../shared/github.js";
import type {
  ValidationFailure,
  ValidationFinding,
  ValidationPhase,
} from "../submission-validation/contracts.js";
import { sanitizeTerminalText } from "./render.js";

/** The report is capped at 64 MiB where it is read by the publisher; nothing
 * larger is a report, deflated or not. */
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const MAX_FINDINGS = 1_000;
const MESSAGE_LIMIT = 12_000;
const REPORT_ENTRY = "validation-report.json";

/** What the terminal needs from the report; the rest is the publisher's. */
export interface RemoteValidationReport {
  ok: boolean;
  warnings: ValidationFinding[];
  violations: ValidationFinding[];
  failure?: ValidationFailure;
}

/**
 * The report exists but cannot be read: no Actions-read permission on this
 * token, or bytes that are not a report. Distinguished from "not uploaded",
 * which is the workflow's own failure to describe and not the CLI's.
 */
export class ValidationReportUnavailableError extends Error {}

interface ArtifactEntry {
  id: number;
  name: string;
  expired?: boolean;
}

export interface ReportFetchOptions {
  /** List polls after the job concludes; artifacts appear a moment later. */
  attempts?: number;
  intervalMs?: number;
}

/**
 * Fetch and parse the validate job's report for one submission. `undefined`
 * means the run uploaded no report — a validate job that died before writing
 * one — which the workflow reports itself through the issue comment.
 */
export async function fetchValidationReport(
  client: GitHubClient,
  issueNumber: number,
  runId: string,
  options: ReportFetchOptions = {},
): Promise<RemoteValidationReport | undefined> {
  const attempts = options.attempts ?? 5;
  const intervalMs = options.intervalMs ?? 1_000;
  const base = repositoryPath(CONTROL_REPOSITORY);
  // The report-only artifact the validate job uploads first (submission.yml);
  // the full artifact next to it carries the capture and is the publisher's.
  const wanted = `submission-validation-report-${issueNumber}`;
  for (let attempt = 1; ; attempt += 1) {
    let listed: { artifacts?: unknown };
    try {
      listed = await client.request<{ artifacts?: unknown }>(
        "GET",
        `${base}/actions/runs/${runId}/artifacts?per_page=100`,
      );
    } catch (error) {
      if (attempt < attempts && !denied(error)) {
        await delay(intervalMs);
        continue;
      }
      throw unreadable(error);
    }
    const artifact = (Array.isArray(listed.artifacts) ? listed.artifacts : [])
      .filter((entry): entry is ArtifactEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as ArtifactEntry).name === "string" &&
        Number.isSafeInteger((entry as ArtifactEntry).id))
      .find((entry) => entry.name === wanted && entry.expired !== true);
    if (artifact === undefined) {
      if (attempt >= attempts) return undefined;
      await delay(intervalMs);
      continue;
    }
    let zip: Uint8Array;
    try {
      zip = await client.requestBinary(`${base}/actions/artifacts/${artifact.id}/zip`, {
        maxBytes: MAX_REPORT_BYTES,
      });
    } catch (error) {
      if (attempt < attempts && !denied(error)) {
        await delay(intervalMs);
        continue;
      }
      throw unreadable(error);
    }
    return parseValidationReportZip(zip);
  }
}

/** Read `validation-report.json` out of an artifact zip, bounds first. */
export function parseValidationReportZip(zip: Uint8Array): RemoteValidationReport {
  let entries: Record<string, Uint8Array>;
  try {
    // Only the report is inflated, and only if its declared inflated size is
    // plausible: a zip is attacker-shaped input the moment it names anything
    // else or claims to hold more than a report can be.
    entries = unzipSync(zip, {
      filter: (file: UnzipFileInfo) =>
        file.name === REPORT_ENTRY && file.originalSize <= MAX_REPORT_BYTES,
    });
  } catch (error) {
    throw new ValidationReportUnavailableError(
      `the validation report artifact is not a readable zip: ${(error as Error).message}`,
    );
  }
  const bytes = entries[REPORT_ENTRY];
  if (bytes === undefined) {
    throw new ValidationReportUnavailableError(
      `the validation report artifact has no ${REPORT_ENTRY} within bounds`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new ValidationReportUnavailableError("the validation report is not valid JSON");
  }
  return parseValidationReport(parsed);
}

/**
 * Shape-check the report and sanitize it. This is not the trusted parse — the
 * publisher does that, credential-free, against the real bytes — it is only as
 * much structure as printing findings needs.
 */
export function parseValidationReport(value: unknown): RemoteValidationReport {
  if (typeof value !== "object" || value === null) {
    throw new ValidationReportUnavailableError("the validation report is not an object");
  }
  const report = value as Record<string, unknown>;
  if (report.reportVersion !== 1) {
    throw new ValidationReportUnavailableError("the validation report is not a version 1 report");
  }
  if (typeof report.ok !== "boolean") {
    throw new ValidationReportUnavailableError("the validation report has no verdict");
  }
  const warnings = findings(report.warnings, "warnings");
  const violations = findings(report.violations, "violations");
  const failure = validationFailure(report.failure);
  if (report.ok && failure !== undefined) {
    throw new ValidationReportUnavailableError("a successful validation report contains a failure");
  }
  if (failure !== undefined && violations.length > 0) {
    throw new ValidationReportUnavailableError(
      "the validation report mixes an operational failure with submission violations",
    );
  }
  return {
    ok: report.ok,
    warnings,
    violations,
    ...(failure === undefined ? {} : { failure }),
  };
}

function validationFailure(value: unknown): ValidationFailure | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) {
    throw new ValidationReportUnavailableError("the validation report failure is not an object");
  }
  const failure = value as Record<string, unknown>;
  if (
    (failure.kind !== "resource-limit" && failure.kind !== "infrastructure") ||
    typeof failure.retryable !== "boolean"
  ) {
    throw new ValidationReportUnavailableError("the validation report has an invalid failure classification");
  }
  return {
    kind: failure.kind,
    retryable: failure.retryable,
    phase: (text(failure.phase, 40) || "validation") as ValidationPhase,
    rule: text(failure.rule, 60) || "unspecified",
    message: text(failure.message, MESSAGE_LIMIT) || "unspecified failure",
  };
}

function findings(value: unknown, label: string): ValidationFinding[] {
  if (!Array.isArray(value)) {
    throw new ValidationReportUnavailableError(`the validation report ${label} are not a list`);
  }
  return value.slice(0, MAX_FINDINGS).map((entry) => {
    const finding = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    return {
      phase: (text(finding.phase, 40) || "validation") as ValidationPhase,
      rule: text(finding.rule, 60) || "unspecified",
      message: text(finding.message, MESSAGE_LIMIT) || "unspecified failure",
    };
  });
}

function text(value: unknown, limit: number): string {
  return typeof value === "string" ? sanitizeTerminalText(value, limit).trim() : "";
}

/** An authoritative refusal; retrying the same token cannot change it. */
function denied(error: unknown): boolean {
  return error instanceof GitHubError && (error.status === 403 || error.status === 404);
}

function unreadable(error: unknown): ValidationReportUnavailableError {
  return new ValidationReportUnavailableError(
    "could not read the validation report from the workflow run " +
      `(${error instanceof Error ? error.message : String(error)}). ` +
      "This needs the Actions read permission on your login; run `lax login` to re-grant it, " +
      "then reattach with `lax submit --resume`.",
  );
}
