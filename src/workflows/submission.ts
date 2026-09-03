import fs from "node:fs";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { ArchiveRepository } from "../shared/archive.js";
import { GitHubReleaseCaptureStore } from "../shared/capture-store.js";
import { CONTROL_REPOSITORY } from "../shared/constants.js";
import { ControlPlane } from "../shared/control-plane.js";
import { GitHubClient, repositoryPath } from "../shared/github.js";
import {
  dispatchWebsiteAndReport,
  parsePublishRequest,
  PostCommitError,
  Publisher,
} from "../shared/publisher.js";
import { UpdatePublisher } from "../shared/update-publisher.js";
import type { PublishRequest } from "../shared/types.js";
import {
  parseSuccessfulValidationArtifacts,
  type SuccessfulValidationArtifacts,
} from "../submission-validation/artifact-schema.js";
import { verifyCaptureArchive } from "../submission-validation/capture-archive.js";
import { configuredRuntime } from "../submission-validation/config.js";
import type { ValidationReport, ValidationRequest } from "../submission-validation/contracts.js";
import { decodeUtf8, isObject, ValidationError } from "../shared/validation.js";
import {
  appendWorkflowRun,
  initializationMarker,
  resultMarker,
  resultStatusMarker,
  workflowRunMarker,
  type WorkflowRunRef,
} from "../shared/workflow-comments.js";

const mode = process.argv[2];

try {
  if (mode === "route") await route();
  else if (mode === "publish") await publish();
  else if (mode === "prepare-update") await prepareUpdate();
  else if (mode === "publish-update") await publishUpdate();
  else if (mode === "website") await website();
  else if (mode === "report-validation") await reportValidation();
  else throw new Error(
    "usage: submission.js route|publish|prepare-update|publish-update|website|report-validation",
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function route(): Promise<void> {
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
      if (result.request.action === "owners" || result.request.action === "update") {
        await control.markCommandStarted(result.request.commentId);
        startedCommandCommentId = result.request.commentId;
      }
    } else if (result.preview !== undefined) {
      const exists =
        result.request.commentId === undefined
          ? await control.initializationPreviewExists(
              result.request.issue.number,
              result.request.eventCreatedAt,
            )
          : await control.previewExists(
              result.request.issue.number,
              result.request.commentId,
              result.request.eventCreatedAt,
            );
      if (!exists) {
        await control.postIssueComment(
          result.request.issue.number,
          appendWorkflowRun(result.preview, run),
        );
      }
    }
    if (result.kind === "validate") {
      if (result.request.command?.action !== "update" || result.request.commentId === undefined)
        throw new Error("validated update route has no update command context");
      const request = validationRequest(result.request);
      writeOutput("operation", "validate");
      writeOutput("action", "update");
      writeOutput("validation_request", encode(request));
      writeOutput("publish_request", encode(result.request));
      writeOutput("context", encode({
        id: result.request.id,
        issueNumber: result.request.issue.number,
        commentId: result.request.commentId,
        eventCreatedAt: result.request.eventCreatedAt,
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
  eventCreatedAt: string;
}

async function reportValidation(): Promise<void> {
  const context = parseValidationContext(decodeBase64Json(requiredEnv("VALIDATION_CONTEXT")));
  const client = new GitHubClient(requiredEnv("GITHUB_TOKEN"));
  const control = new ControlPlane(client, new ArchiveRepository(client), repositoryId());
  if (await control.resultExists(context.issueNumber, context.commentId, context.eventCreatedAt)) {
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
      `lax-database was not changed.\n\n${marker}\n${resultStatusMarker("failure")}`
    : report.ok
      ? `Submission validation passed for **${context.id}**, but the validation job failed before trusted ` +
        `publication could start. lax-database was not changed.\n\n` +
        `${validationWarnings(report)}${marker}\n${resultStatusMarker("failure")}`
      : `Submission validation failed for **${context.id}**; lax-database was not changed.\n\n` +
        `${validationProblems(report)}\n\n${marker}\n${resultStatusMarker("failure")}`;
  await clearCommandProgress(control, context.commentId);
  await control.postIssueComment(context.issueNumber, appendWorkflowRun(body, workflowRun()));
}

async function publish(): Promise<void> {
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
    if (result.kind === "committed") {
      archiveCommit = result.archiveCommit;
      writeOutput("archive_commit", archiveCommit);
    }
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
          `The Archive commit must not be replayed.\n\n${marker}\n${resultStatusMarker("failure")}`
        : `Publication failed; lax-database was not changed by this command.\n\n` +
          `${problems(error)}\n\n${marker}\n${resultStatusMarker("failure")}`,
      workflowRun(),
    );
    await control.postIssueComment(request.issue.number, body);
    throw error;
  }
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
async function prepareUpdate(): Promise<void> {
  const authoritativeRepositoryId = repositoryId();
  const request = readPublishRequest(authoritativeRepositoryId);
  const client = new GitHubClient(requiredEnv("GITHUB_TOKEN"));
  const control = new ControlPlane(client, new ArchiveRepository(client), authoritativeRepositoryId);
  try {
    const artifacts = readSuccessfulArtifacts(request);
    const publisher = new UpdatePublisher(
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

async function publishUpdate(): Promise<void> {
  const authoritativeRepositoryId = repositoryId();
  const request = readPublishRequest(authoritativeRepositoryId);
  const controlClient = new GitHubClient(requiredEnv("GITHUB_TOKEN"));
  const control = new ControlPlane(
    controlClient,
    new ArchiveRepository(controlClient),
    authoritativeRepositoryId,
  );
  let archiveCommit: string | undefined;
  try {
    const artifacts = readSuccessfulArtifacts(request);
    const archiveClient = new GitHubClient(requiredEnv("LAX_DATABASE_TOKEN"));
    const publisher = new UpdatePublisher(
      control,
      new ArchiveRepository(archiveClient),
      new GitHubReleaseCaptureStore(archiveClient),
      authoritativeRepositoryId,
    );
    const result = await publisher.publish(
      request,
      artifacts,
      requiredEnv("VALIDATION_CAPTURE_PATH"),
      workflowRun(),
    );
    if (result.kind === "no-op") return;
    archiveCommit = result.archiveCommit;
    writeOutput("archive_commit", result.archiveCommit);
    try {
      await controlClient.request(
        "PATCH",
        `${repositoryPath(CONTROL_REPOSITORY)}/issues/${request.issue.number}`,
        { title: result.acceptedTitle },
      );
    } catch (error) {
      const message = safeCommentText((error as Error).message, 300);
      writeOutput("title_sync_error", message || "unknown title synchronization failure");
    }
  } catch (error) {
    await postPublicationFailure(control, request, error, archiveCommit);
    throw error;
  }
}

async function website(): Promise<void> {
  const authoritativeRepositoryId = repositoryId();
  const request = readPublishRequest(authoritativeRepositoryId);
  const controlClient = new GitHubClient(requiredEnv("GITHUB_TOKEN"));
  const control = new ControlPlane(
    controlClient,
    new ArchiveRepository(controlClient),
    authoritativeRepositoryId,
  );
  await dispatchWebsiteAndReport(
    control,
    new GitHubClient(requiredEnv("LAX_WEBSITE_TOKEN")),
    request,
    authoritativeRepositoryId,
    requiredEnv("ARCHIVE_COMMIT"),
    workflowRun(),
    process.env.TITLE_SYNC_ERROR ?? "",
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
        `The Archive commit must not be replayed.\n\n${markerText}\n${resultStatusMarker("failure")}`
      : `Publication failed; lax-database was not changed by this command.\n\n` +
        `${problems(error)}\n\n${markerText}\n${resultStatusMarker("failure")}`,
    workflowRun(),
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
    `${label}; no lax-database commit was created.\n\n${problems(error)}\n\n` +
      `${markerText}\n${resultStatusMarker("failure")}`,
    workflowRun(),
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
    .map((line) => `- ${safeCommentText(line.replace(/^-\s*/u, ""), 1_000)}`)
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
  if (request.action !== "update" || request.command?.action !== "update") {
    throw new ValidationError("validation artifacts require an update publication request");
  }
  return {
    requestVersion: 1,
    id: request.id,
    issue: request.issue,
    source: {
      repository: request.command.repository,
      commit: request.command.commit,
      folder: request.command.folder,
    },
    archiveSha: request.archiveSha,
    ...(request.legacyManifestWithoutIssue === undefined
      ? {}
      : { legacyManifestWithoutIssue: request.legacyManifestWithoutIssue }),
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
    configuredRuntime(requiredEnv("LAX_VALIDATION_IMAGE")),
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
  if (sha256File(capturePath) !== artifacts.report.capture.digest) {
    throw new ValidationError("validation capture digest does not match its report");
  }
  verifyCaptureArchive(capturePath, artifacts.report.capture);
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
  if (
    !isObject(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(["commentId", "eventCreatedAt", "id", "issueNumber"])
  )
    throw new ValidationError("validation context is malformed");
  if (typeof value.id !== "string" || !/^lax-[1-9][0-9]*$/u.test(value.id))
    throw new ValidationError("validation context id is malformed");
  for (const key of ["issueNumber", "commentId"] as const)
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) <= 0)
      throw new ValidationError(`validation context ${key} is malformed`);
  const eventCreatedAt = typeof value.eventCreatedAt === "string" ? value.eventCreatedAt : "";
  const eventDate = new Date(eventCreatedAt);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u.test(eventCreatedAt) ||
    Number.isNaN(eventDate.valueOf()) ||
    eventDate.toISOString().replace(".000Z", "Z") !== eventCreatedAt
  ) throw new ValidationError("validation context eventCreatedAt is malformed");
  return {
    id: value.id,
    issueNumber: value.issueNumber as number,
    commentId: value.commentId as number,
    eventCreatedAt,
  };
}

function validationProblems(report: ValidationReport): string {
  const findings = Array.isArray(report.violations) ? report.violations.slice(0, 30) : [];
  if (findings.length === 0) return "- Validation failed without a structured finding; inspect the workflow artifact.";
  return findings.map((finding) => {
    if (!isObject(finding)) return "- Malformed validation finding";
    const phase = safeCommentText(String(finding.phase ?? "validation"), 40);
    const message = safeCommentText(String(finding.message ?? "unspecified failure"), 600);
    return `- **${phase}**: ${message}`;
  }).join("\n");
}

function validationWarnings(report: ValidationReport): string {
  const findings = Array.isArray(report.warnings) ? report.warnings.slice(0, 10) : [];
  if (findings.length === 0) return "";
  const lines = findings.map((finding) =>
    `- ${safeCommentText(isObject(finding) ? String(finding.message ?? "warning") : "warning", 400)}`,
  );
  return `Warnings:\n\n${lines.join("\n")}\n\n`;
}

function safeCommentText(value: string, limit: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/@/gu, "@\u200b")
    .replace(/[<>]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
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
