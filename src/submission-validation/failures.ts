import type { ValidationFailure, ValidationReport } from "./contracts.js";
import { leanFacts } from "./lean-facts.js";

export type PipelineFailureKind = "submission" | ValidationFailure["kind"];

/** A phase error whose ownership has been decided at the closest boundary. */
export class PipelineFailure extends Error {
  constructor(
    readonly kind: PipelineFailureKind,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "PipelineFailure";
  }
}

export function submissionFailure(message: string): PipelineFailure {
  return new PipelineFailure("submission", message);
}

export function resourceLimitFailure(message: string): PipelineFailure {
  return new PipelineFailure("resource-limit", message);
}

export function infrastructureFailure(message: string, retryable = false): PipelineFailure {
  return new PipelineFailure("infrastructure", message, retryable);
}

export function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function asPipelineFailure(
  error: unknown,
  fallbackKind: PipelineFailureKind = "infrastructure",
  retryable = false,
): PipelineFailure {
  return error instanceof PipelineFailure
    ? error
    : new PipelineFailure(fallbackKind, failureMessage(error), retryable);
}

export function validationExitCode(
  report: Pick<ValidationReport, "ok" | "failure">,
): 0 | 1 | 2 {
  if (report.ok) return 0;
  return report.failure === undefined ? 2 : 1;
}

/**
 * Transport diagnostics are necessarily best-effort, but the positive cases
 * here are deliberately narrow: a bad repository/commit must not turn into an
 * endless "retry unchanged" loop, while DNS, connection, throttling, timeout,
 * and server-side HTTP failures are safe to call transient.
 */
export function looksRetryable(error: unknown): boolean {
  const message = failureMessage(error);
  return (
    /(?:timed? out|timeout|temporary failure|try again|network is unreachable)/iu.test(message) ||
    /(?:could not resolve host|failed to connect|connection (?:reset|refused|closed))/iu.test(message) ||
    /(?:cannot connect to|is the docker daemon running)/iu.test(message) ||
    /(?:TLS|SSL).*(?:failed|error|closed)/iu.test(message) ||
    /HTTP\s+(?:408|425|429|5[0-9]{2})\b/iu.test(message)
  );
}

/** Classify failures while fetching the author-controlled source. */
export function submittedSourceFailure(error: unknown): PipelineFailure {
  if (error instanceof PipelineFailure) return error;
  const message = failureMessage(error);
  if (looksRetryable(error)) return infrastructureFailure(message, true);
  if (
    /(?:could not initialize the fetch workspace|could not configure the fetch remote)/u.test(message) ||
    /(?:spawn git|ENOENT)/u.test(message)
  ) {
    return infrastructureFailure(message);
  }
  return submissionFailure(message);
}

/**
 * Docker reserves 125 for `docker run` itself, while 126/127 mean that its
 * configured command could not execute. 137 is the normal observable result
 * of the enforced memory ceiling. Other nonzero codes belong to the tool the
 * phase intentionally ran and are left to that phase to classify.
 */
export function containerBoundaryFailure(
  result: { code: number; output: string; timedOut: boolean },
  timeoutMessage: string,
  memoryMessage: string,
): PipelineFailure | undefined {
  if (result.timedOut) return resourceLimitFailure(timeoutMessage);
  if (result.code === 137) return resourceLimitFailure(memoryMessage);
  if (result.code === 125) {
    return infrastructureFailure(
      result.output.trim() || "the validation container could not start",
      looksRetryable(result.output),
    );
  }
  if (result.code === 126 || result.code === 127) {
    return infrastructureFailure(result.output.trim() || "the validation command could not start");
  }
  return undefined;
}

/**
 * Classify the tool-level failure of an authored build. Lean/Lake diagnostics
 * ordinarily belong to the submission. An attempted write to a platform-owned
 * read-only dependency or warm-store mount is different: it is the tripwire
 * for stale/incomplete Lake metadata or a capture/runtime compatibility bug,
 * so reporting it as an author's compile error would hide the LAX regression.
 */
export function compilationFailure(output: string, fallbackMessage: string): PipelineFailure {
  const message = output.trim() || fallbackMessage;
  const platformPath = /(?:\/deps\/|\/opt\/lax\/warm(?:\/|\b))/u;
  const writeDenied = /(?:read-only file system|permission denied|\bEROFS\b|\bEACCES\b)/iu;
  if (platformPath.test(message) && writeDenied.test(message)) {
    return infrastructureFailure(message);
  }
  return submissionFailure(message);
}

/** A replay has already compiled successfully from the complete source tree.
 * If the isolated captured view can no longer locate one of those modules,
 * LAX omitted or mis-laid-out an artifact; it is not a new author error. */
export function replayFailure(output: string, fallbackMessage: string): PipelineFailure {
  const message = output.trim() || fallbackMessage;
  // The wording is leanchecker's, so it belongs to the Lean release; this
  // classifier has no environment in hand, and lean-facts.ts answers for the
  // epoch until a release makes two admitted versions disagree.
  if (leanFacts().missingModulePattern.test(message)) {
    return infrastructureFailure(message);
  }
  return submissionFailure(message);
}
