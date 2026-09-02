import fs from "node:fs";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { ArchiveRepository } from "../shared/archive.js";
import { GhcrCaptureStore } from "../shared/capture-store.js";
import { CONTROL_REPOSITORY } from "../shared/constants.js";
import { safeInline } from "../shared/comment-format.js";
import { ControlPlane } from "../shared/control-plane.js";
import { GitHubClient, repositoryPath } from "../shared/github.js";
import {
  dispatchWebsiteAndReport,
  parsePublishRequest,
  PostCommitError,
  Publisher,
} from "../shared/publisher.js";
import { SubmitPublisher } from "../shared/submit-publisher.js";
import type { PublishRequest } from "../shared/types.js";
import {
  parseSuccessfulValidationArtifacts,
  type SuccessfulValidationArtifacts,
} from "../submission-validation/artifact-schema.js";
import { configuredRuntime } from "../submission-validation/config.js";
import type {
  ValidationFinding,
  ValidationReport,
  ValidationRequest,
} from "../submission-validation/contracts.js";
import { decodeUtf8, isObject, ValidationError } from "../shared/validation.js";
import {
  appendWorkflowRun,
  initializationMarker,
  resultMarker,
  workflowRunMarker,
  type WorkflowRunRef,
} from "../shared/workflow-comments.js";

// Dispatch only when executed as a workflow entry point; tests import the
// exported mode functions directly and drive them against a fake fetch.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const mode = process.argv[2];
  try {
    if (mode === "route") await route();
    else if (mode === "publish") await publish();
    else if (mode === "prepare-submit") await prepareSubmit();
    else if (mode === "publish-submit") await publishSubmit();
    else if (mode === "report-validation") await reportValidation();
    else if (mode === "report-failure") await reportFailure();
    else throw new Error(
      "usage: submission.js route|publish|prepare-submit|publish-submit|report-validation|report-failure",
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export async function route(): Promise<void> {
  const event = readEvent();
  const eventName = requiredEnv("GITHUB_EVENT_NAME");
  const token = requiredEnv("GITHUB_TOKEN");
  const client = new GitHubClient(token);
  const control = new ControlPlane(client, new ArchiveRepository(client), repositoryId());
  let startedCommandCommentId: number | undefined;
  try {
    const result = await control.route(eventName, event);
    if (result.kind === "ignore") {
      writeOutput("operation", "ignore");
      return;
    }
    const run = workflowRun();
    if (
      result.request.commentId !== undefined &&
      (result.kind === "validate" || result.request.action === "owners")
    ) {
      const context =
        result.kind === "validate"
          ? appendWorkflowRun(result.preview, run)
          : workflowRunMarker(run.id);
      await control.annotateIssueComment(result.request.commentId, context);
      if (result.request.action === "owners" || result.request.action === "submit") {
        await control.markCommandStarted(result.request.commentId);
        startedCommandCommentId = result.request.commentId;
      }
    } else if (result.preview !== undefined) {
      const exists =
        result.request.commentId === undefined
          ? await control.initializationPreviewExists(result.request.issue.number)
          : await control.previewExists(result.request.issue.number, result.request.commentId);
      if (!exists) {
        await control.postIssueComment(
          result.request.issue.number,
          appendWorkflowRun(result.preview, run),
        );
      }
    }
    if (result.kind === "validate") {
      if (result.request.command?.action !== "submit" || result.request.commentId === undefined)
        throw new Error("validated submit route has no submit command context");
      const request = validationRequest(result.request);
      writeOutput("operation", "validate");
      writeOutput("action", "submit");
      writeOutput("validation_request", encode(request));
      writeOutput("publish_request", encode(result.request));
      writeOutput("context", encode({
        id: result.request.id,
        issueNumber: result.request.issue.number,
        commentId: result.request.commentId,
      }));
      return;
    }
    writeOutput("operation", "publish");
    writeOutput("action", result.request.action);
    writeOutput("publish_request", encode(result.request));
  } catch (error) {
    if (startedCommandCommentId !== undefined) {
      await clearCommandProgress(control, startedCommandCommentId);
    }
    await postFailure(control, event, eventName, error, false);
    throw error;
  }
}

interface ValidationContext {
  id: string;
  issueNumber: number;
  commentId: number;
}

export async function reportValidation(): Promise<void> {
  const context = parseValidationContext(decodeBase64Json(requiredEnv("VALIDATION_CONTEXT")));
  const client = new GitHubClient(requiredEnv("GITHUB_TOKEN"));
  const control = new ControlPlane(client, new ArchiveRepository(client), repositoryId());
  if (await control.resultExists(context.issueNumber, context.commentId)) {
    await clearCommandProgress(control, context.commentId);
    return;
  }
  let report: ValidationReport | undefined;
  const reportPath = process.env.VALIDATION_REPORT_PATH;
  if (reportPath !== undefined && fs.existsSync(reportPath)) {
    const stat = fs.statSync(reportPath);
    if (stat.isFile() && stat.size <= 64 * 1024 * 1024) {
      try {
        const parsed = JSON.parse(decodeUtf8(fs.readFileSync(reportPath))) as unknown;
        if (
          isObject(parsed) &&
          parsed.reportVersion === 1 &&
          typeof parsed.ok === "boolean" &&
          Array.isArray(parsed.violations) &&
          Array.isArray(parsed.warnings) &&
          isObject(parsed.request) &&
          parsed.request.id === context.id &&
          validValidationFailure(parsed.failure) &&
          (parsed.failure === undefined || (!parsed.ok && parsed.violations.length === 0)) &&
          (!parsed.ok || (isObject(parsed.buildOutput) && isObject(parsed.capture)))
        ) report = parsed as unknown as ValidationReport;
      } catch {
        report = undefined;
      }
    }
  }
  const marker = resultMarker(context.commentId);
  const body = report === undefined
    ? `Validation infrastructure failed for **${context.id}**; no trustworthy report was produced. ` +
      `lax-database was not changed.\n\n${marker}`
    : report.ok
      ? `Submission validation passed for **${context.id}**, but the validation job failed before trusted ` +
        `publication could start. lax-database was not changed.\n\n${marker}`
      : report.failure?.kind === "infrastructure"
        ? `Validation infrastructure failed for **${context.id}**; the submission did not receive a content ` +
          `verdict and lax-database was not changed.\n${validationFailureSummary(report)}\n` +
          (report.failure.retryable
            ? "This failure appears transient; retrying the unchanged submission may succeed."
            : "Inspect this workflow run; if the failure persists, report it as an Archive problem.") +
          `\n\n${marker}`
        : report.failure?.kind === "resource-limit"
          ? `Validation for **${context.id}** reached an Archive resource limit; the submission was not rejected ` +
            `on content and lax-database was not changed.\n${validationFailureSummary(report)}\n` +
            `Reduce the submission's resource use before retrying.\n\n${marker}`
          : `Submission validation failed for **${context.id}**; lax-database was not changed.\n` +
            `${firstViolation(report)}\n` +
            `The complete findings are in this run's artifacts, where \`lax submit\` reads them.` +
            `\n\n${marker}`;
  await clearCommandProgress(control, context.commentId);
  await control.postIssueComment(
    context.issueNumber,
    appendWorkflowRun(body, workflowRun(), "failure"),
  );
}

export async function publish(): Promise<void> {
  const authoritativeRepositoryId = repositoryId();
  const request = readPublishRequest(authoritativeRepositoryId);
  const controlClient = new GitHubClient(requiredEnv("GITHUB_TOKEN"));
  const control = new ControlPlane(
    controlClient,
    new ArchiveRepository(controlClient),
    authoritativeRepositoryId,
  );
  const archive = new ArchiveRepository(new GitHubClient(requiredEnv("LAX_DATABASE_TOKEN")));
  const publisher = new Publisher(control, archive, authoritativeRepositoryId);
  let archiveCommit: string | undefined;
  try {
    const result = await publisher.publish(request, workflowRun());
    if (result.kind === "committed") archiveCommit = result.archiveCommit;
  } catch (error) {
    if (request.action === "owners" && request.commentId !== undefined) {
      await clearCommandProgress(control, request.commentId);
    }
    const committed =
      archiveCommit ?? (error instanceof PostCommitError ? error.archiveCommit : undefined);
    const marker =
      request.commentId === undefined
        ? initializationMarker(request.issue.number)
        : resultMarker(request.commentId);
    const body = appendWorkflowRun(
      committed !== undefined
        ? `lax-database changed at commit \`${committed}\`, but workflow continuation failed. ` +
          `The Archive commit must not be replayed.\n\n${marker}`
        : `Publication failed; lax-database was not changed by this command.\n\n` +
          `${problems(error)}\n\n${marker}`,
      workflowRun(),
      "failure",
    );
    await control.postIssueComment(request.issue.number, body);
    throw error;
  }
  if (archiveCommit === undefined) return;
  await dispatchWebsite(control, request, authoritativeRepositoryId, archiveCommit);
}

/**
 * Website dispatch and the final result comment, on the commit this process
 * just created. dispatchWebsiteAndReport owns its own reporting — including
 * the comment for a failed dispatch — so its errors must not be routed
 * through the publication-failure reporters, which would post a second
 * comment for the same event.
 */
async function dispatchWebsite(
  control: ControlPlane,
  request: PublishRequest,
  authoritativeRepositoryId: number,
  archiveCommit: string,
  titleSyncError = "",
): Promise<void> {
  await dispatchWebsiteAndReport(
    control,
    new GitHubClient(requiredEnv("LAX_WEBSITE_TOKEN")),
    request,
    authoritativeRepositoryId,
    archiveCommit,
    workflowRun(),
    titleSyncError,
  );
}

async function clearCommandProgress(control: ControlPlane, commentId: number): Promise<void> {
  try {
    await control.clearCommandProgress(commentId);
  } catch (error) {
    console.error(`could not clear command progress reaction: ${(error as Error).message}`);
  }
}

/**
 * Parse all untrusted validation artifacts and repeat authorization/fresh-state
 * checks before the protected job is allowed to mint an Archive token.
 */
export async function prepareSubmit(): Promise<void> {
  const authoritativeRepositoryId = repositoryId();
  const request = readPublishRequest(authoritativeRepositoryId);
  const client = new GitHubClient(requiredEnv("GITHUB_TOKEN"));
  const control = new ControlPlane(client, new ArchiveRepository(client), authoritativeRepositoryId);
  try {
    const artifacts = readSuccessfulArtifacts(request);
    const publisher = new SubmitPublisher(
      control,
      new ArchiveRepository(client),
      undefined,
      authoritativeRepositoryId,
    );
    const result = await publisher.preflight(request, artifacts);
    writeOutput("should_publish", result.kind === "ready" ? "true" : "false");
  } catch (error) {
    await postPublicationFailure(control, request, error);
    throw error;
  }
}

export async function publishSubmit(): Promise<void> {
  const authoritativeRepositoryId = repositoryId();
  const request = readPublishRequest(authoritativeRepositoryId);
  const controlClient = new GitHubClient(requiredEnv("GITHUB_TOKEN"));
  const control = new ControlPlane(
    controlClient,
    new ArchiveRepository(controlClient),
    authoritativeRepositoryId,
  );
  let archiveCommit: string | undefined;
  let titleSyncError = "";
  try {
    const artifacts = readSuccessfulArtifacts(request);
    const archiveClient = new GitHubClient(requiredEnv("LAX_DATABASE_TOKEN"));
    // The capture store pushes with the job's own GITHUB_TOKEN
    // (packages: write on the control repository's ghcr namespace); the
    // App-minted database token never leaves the archive write path.
    const publisher = new SubmitPublisher(
      control,
      new ArchiveRepository(archiveClient),
      new GhcrCaptureStore(requiredEnv("GITHUB_TOKEN")),
      authoritativeRepositoryId,
    );
    const result = await publisher.publish(
      request,
      artifacts,
      requiredEnv("VALIDATION_CAPTURE_PATH"),
      workflowRun(),
      artifacts.buildOutput.paper === undefined ? undefined : requiredEnv("VALIDATION_PAPER_PATH"),
    );
    if (result.kind === "no-op") return;
    archiveCommit = result.archiveCommit;
    try {
      await controlClient.request(
        "PATCH",
        `${repositoryPath(CONTROL_REPOSITORY)}/issues/${request.issue.number}`,
        { title: result.acceptedTitle },
      );
    } catch (error) {
      const message = safeInline((error as Error).message, 300);
      titleSyncError = message || "unknown title synchronization failure";
    }
  } catch (error) {
    await postPublicationFailure(control, request, error, archiveCommit);
    throw error;
  }
  await dispatchWebsite(control, request, authoritativeRepositoryId, archiveCommit, titleSyncError);
}

/**
 * Final fallback for jobs that fail before their structured TS reporters can
 * run (checkout, npm ci, compilation, App-token actions). It replaces the old
 * inline actions/github-script body with the same typed marker helpers the
 * rest of the control plane uses: post the correlated operational failure
 * once per workflow run, and clear the command progress reaction that the
 * route job may have left on the triggering comment.
 */
export async function reportFailure(): Promise<void> {
  const event = readEvent();
  const number = issueNumber(event);
  if (number === undefined) return;
  const triggeringComment = commentId(event);
  const marker =
    triggeringComment === undefined ? initializationMarker(number) : resultMarker(triggeringComment);
  const client = new GitHubClient(requiredEnv("GITHUB_TOKEN"));
  const control = new ControlPlane(client, new ArchiveRepository(client), repositoryId());
  const action = process.env.ACTION;
  if ((action === "owners" || action === "submit") && triggeringComment !== undefined) {
    await clearCommandProgress(control, triggeringComment);
  }
  const run = workflowRun();
  if (await control.failureReportExists(number, marker, run.id)) return;
  // A publishing job that died before its own reporter ran cannot say whether
  // it committed; only it could have. Every other failure is upstream of any
  // lax-database write, so those messages stay definite.
  const summary =
    process.env.PUBLICATION_FAILED === "true"
      ? "Publication did not complete. Inspect this run before retrying: if it created a " +
        "lax-database commit, that commit must not be replayed."
      : process.env.OPERATION === "validate"
        ? "Validation or result reporting failed; no trustworthy validation result was produced. " +
          "lax-database was not changed."
        : "The workflow failed before publication completed; no lax-database commit was created by this run.";
  await control.postIssueComment(
    number,
    appendWorkflowRun(`${summary}\n\n${marker}`, run, "failure"),
  );
}

async function postPublicationFailure(
  control: ControlPlane,
  request: PublishRequest,
  error: unknown,
  archiveCommit?: string,
): Promise<void> {
  if (request.commentId !== undefined) await clearCommandProgress(control, request.commentId);
  const committed = archiveCommit ?? (error instanceof PostCommitError ? error.archiveCommit : undefined);
  const markerText =
    request.commentId === undefined
      ? initializationMarker(request.issue.number)
      : resultMarker(request.commentId);
  const body = appendWorkflowRun(
    committed !== undefined
      ? `lax-database changed at commit \`${committed}\`, but workflow continuation failed. ` +
        `The Archive commit must not be replayed.\n\n${markerText}`
      : `Publication failed; lax-database was not changed by this command.\n\n` +
        `${problems(error)}\n\n${markerText}`,
    workflowRun(),
    "failure",
  );
  try {
    await control.postIssueComment(request.issue.number, body);
  } catch (commentError) {
    console.error(`could not post publication failure: ${(commentError as Error).message}`);
  }
}

async function postFailure(
  control: ControlPlane,
  event: unknown,
  eventName: string,
  error: unknown,
  publication: boolean,
): Promise<void> {
  const number = issueNumber(event);
  if (number === undefined) return;
  const label =
    eventName === "issues"
      ? "Initialization failed"
      : publication
        ? "Publication failed"
        : "Command rejected";
  const triggeringComment = commentId(event);
  const markerText =
    triggeringComment === undefined
      ? initializationMarker(number)
      : resultMarker(triggeringComment);
  const body = appendWorkflowRun(
    `${label}; no lax-database commit was created.\n\n${problems(error)}\n\n${markerText}`,
    workflowRun(),
    "failure",
  );
  try {
    await control.postIssueComment(number, body);
  } catch (commentError) {
    console.error(`could not post failure comment: ${(commentError as Error).message}`);
  }
}

function problems(error: unknown): string {
  const message =
    error instanceof ValidationError
      ? error.message
      : "An unexpected operational error occurred. See the workflow run; secrets and event data are not included here.";
  return message
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => `- ${safeInline(line.replace(/^-\s*/u, ""), 1_000)}`)
    .join("\n")
    .slice(0, 8_000);
}

function readEvent(): unknown {
  return JSON.parse(decodeUtf8(fs.readFileSync(requiredEnv("GITHUB_EVENT_PATH")))) as unknown;
}

function repositoryId(): number {
  return Number(requiredEnv("LAX_REPOSITORY_ID"));
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

function workflowRunUrl(): string {
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  return `${server}/${process.env.GITHUB_REPOSITORY ?? "lax-archive/lax"}/actions/runs/${process.env.GITHUB_RUN_ID ?? "unknown"}`;
}

function workflowRun(): WorkflowRunRef {
  return { id: process.env.GITHUB_RUN_ID ?? "unknown", url: workflowRunUrl() };
}

function writeOutput(name: string, value: string): void {
  const file = requiredEnv("GITHUB_OUTPUT");
  const delimiter = `lax_${process.pid}_${Date.now()}`;
  fs.appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, "utf8");
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function decodeBase64Json(encoded: string): unknown {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new ValidationError("workflow context is not canonical base64");
  return JSON.parse(decodeUtf8(bytes)) as unknown;
}

function readPublishRequest(expectedRepositoryId: number): PublishRequest {
  try {
    return parsePublishRequest(
      decodeBase64Json(requiredEnv("PUBLISH_REQUEST")),
      expectedRepositoryId,
    );
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError("publication request is malformed JSON");
  }
}

function validationRequest(request: PublishRequest): ValidationRequest {
  if (request.action !== "submit" || request.command?.action !== "submit") {
    throw new ValidationError("validation artifacts require a submit publication request");
  }
  return {
    requestVersion: 1,
    id: request.id,
    source: {
      repository: request.command.repository,
      commit: request.command.commit,
      folder: request.command.folder,
    },
    archiveSha: request.archiveSha,
  };
}

function readSuccessfulArtifacts(request: PublishRequest): SuccessfulValidationArtifacts {
  const report = readBoundedJson(requiredEnv("VALIDATION_REPORT_PATH"), "validation report");
  const output = readBoundedJson(
    requiredEnv("GENERATED_BUILD_OUTPUT_PATH"),
    "generated build output",
  );
  const artifacts = parseSuccessfulValidationArtifacts(
    report,
    output,
    validationRequest(request),
    configuredRuntime(),
  );
  const capturePath = requiredEnv("VALIDATION_CAPTURE_PATH");
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(capturePath);
  } catch {
    throw new ValidationError("validation capture is missing");
  }
  if (!stat.isFile() || stat.size <= 0 || stat.size > 2 * 1024 * 1024 * 1024) {
    throw new ValidationError("validation capture must be a non-empty regular file no larger than 2 GiB");
  }
  // Credential-free revalidation stops at the whole-tarball sha256: sealing
  // already hashed the deterministic tar, and every consumer re-verifies the
  // per-file inventory at materialize time. (The old USTAR structural walk
  // here was the redundant third verification; rewrite-plan.md cut it.)
  if (sha256File(capturePath) !== artifacts.report.capture.digest) {
    throw new ValidationError("validation capture digest does not match its report");
  }
  // The compiled paper travels in the same artifact, present exactly when
  // the build output records one, and is hashed against the recorded digest
  // here — credential-free — before anything is minted.
  const paperPath = requiredEnv("VALIDATION_PAPER_PATH");
  const paper = artifacts.buildOutput.paper;
  let paperStat: fs.Stats | undefined;
  try {
    paperStat = fs.lstatSync(paperPath);
  } catch {
    paperStat = undefined;
  }
  if (paper === undefined) {
    if (paperStat !== undefined) throw new ValidationError("validation artifact carries a paper.pdf its build output does not record");
    return artifacts;
  }
  if (paperStat === undefined) throw new ValidationError("validation paper is missing");
  if (!paperStat.isFile() || paperStat.size !== paper.pdf.bytes) {
    throw new ValidationError("validation paper must be a regular file of the recorded size");
  }
  if (sha256File(paperPath) !== paper.pdf.digest) {
    throw new ValidationError("validation paper digest does not match its build output");
  }
  return artifacts;
}

function readBoundedJson(filename: string, label: string): unknown {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filename);
  } catch {
    throw new ValidationError(`${label} is missing`);
  }
  if (!stat.isFile() || stat.size <= 0 || stat.size > 64 * 1024 * 1024) {
    throw new ValidationError(`${label} must be a non-empty regular file no larger than 64 MiB`);
  }
  try {
    return JSON.parse(decodeUtf8(fs.readFileSync(filename))) as unknown;
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(`${label} is malformed JSON`);
  }
}

function sha256File(filename: string): string {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(filename, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function parseValidationContext(value: unknown): ValidationContext {
  if (!isObject(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["commentId", "id", "issueNumber"]))
    throw new ValidationError("validation context is malformed");
  if (typeof value.id !== "string" || !/^lax-[1-9][0-9]*$/u.test(value.id))
    throw new ValidationError("validation context id is malformed");
  for (const key of ["issueNumber", "commentId"] as const)
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) <= 0)
      throw new ValidationError(`validation context ${key} is malformed`);
  if (value.id !== `lax-${value.issueNumber as number}`)
    throw new ValidationError("validation context id does not match its issue");
  return { id: value.id, issueNumber: value.issueNumber as number, commentId: value.commentId as number };
}

/**
 * One line, to say what broke without becoming the record of it: the report
 * artifact carries every finding with its transcript intact, and `lax submit`
 * renders that directly. A comment that also carried the transcripts would be
 * a second, worse copy — permanent, markdown-escaped, and truncated.
 */
function firstViolation(report: ValidationReport): string {
  const finding = (Array.isArray(report.violations) ? report.violations : [])
    .find((value): value is ValidationFinding => isObject(value));
  if (finding === undefined) return "Validation failed without a structured finding.";
  const phase = safeInline(String(finding.phase ?? "validation"), 40) || "validation";
  const rule = safeInline(String(finding.rule ?? "unspecified"), 60) || "unspecified";
  const message = String(finding.message ?? "").split("\n")[0] ?? "";
  return `First finding \`[${phase}/${rule}]\`: ${safeInline(message, 400) || "unspecified failure"}`;
}

function validationFailureSummary(report: ValidationReport): string {
  const failure = report.failure;
  if (failure === undefined) return "Validation stopped without a structured operational failure.";
  const phase = safeInline(String(failure.phase), 40) || "validation";
  const rule = safeInline(String(failure.rule), 60) || "unspecified";
  const message = String(failure.message ?? "").split("\n")[0] ?? "";
  return `Failure \`[${phase}/${rule}]\`: ${safeInline(message, 400) || "unspecified failure"}`;
}

function validValidationFailure(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    isObject(value) &&
    (value.kind === "resource-limit" || value.kind === "infrastructure") &&
    typeof value.retryable === "boolean" &&
    typeof value.phase === "string" &&
    typeof value.rule === "string" &&
    typeof value.message === "string"
  );
}

function issueNumber(event: unknown): number | undefined {
  if (!isObject(event) || !isObject(event.issue)) return undefined;
  return Number.isSafeInteger(event.issue.number) && (event.issue.number as number) > 0
    ? (event.issue.number as number)
    : undefined;
}

function commentId(event: unknown): number | undefined {
  if (!isObject(event) || !isObject(event.comment)) return undefined;
  return Number.isSafeInteger(event.comment.id) && (event.comment.id as number) > 0
    ? (event.comment.id as number)
    : undefined;
}
