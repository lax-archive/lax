import {
  deletedFiles,
  initialFiles,
  parseIssueBinding,
  parseArchiveFiles,
  parseOwnerList,
  registeredFiles,
  replaceOwnerList,
  type ArchiveChanges,
  type ArchiveFilename,
} from "./archive-schema.js";
import { samePreconditions, type ArchiveSnapshot, type LoadedSubmission } from "./archive.js";
import { WEBSITE_REPOSITORY } from "./constants.js";
import { repositoryPath } from "./github.js";
import type {
  FilePreconditions,
  GitHubIdentity,
  ParsedCommand,
  PublishRequest,
} from "./types.js";
import {
  isObject,
  normalizeTitle,
  requireExactKeys,
  validateCommit,
  validateIdentity,
  validateSource,
  validateSubmissionId,
  ValidationCollector,
  ValidationError,
} from "./validation.js";
import {
  appendWorkflowRun,
  initializationMarker,
  resultMarker,
  resultStatusMarker,
  type WorkflowRunRef,
} from "./workflow-comments.js";

export interface PublisherControl {
  resultExists(issueNumber: number, commentId: number, since?: string): Promise<boolean>;
  successReactionExists(commentId: number): Promise<boolean>;
  resolveOwnerPairs(owners: GitHubIdentity[]): Promise<GitHubIdentity[]>;
  postIssueComment(issueNumber: number, body: string): Promise<void>;
  completeCommand(commentId: number): Promise<void>;
  clearCommandProgress(commentId: number): Promise<void>;
}

export interface PublisherArchive {
  load(id: string, snapshot?: ArchiveSnapshot): Promise<LoadedSubmission | undefined>;
  writeFiles(args: {
    id: string;
    changes: ArchiveChanges;
    message: string;
    validateCurrent: (loaded: LoadedSubmission | undefined) => void | Promise<void>;
  }): Promise<string>;
}

export interface PublisherWebsite {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
}

export type PublishResult =
  | { kind: "no-op" }
  | { kind: "committed"; archiveCommit: string };

/**
 * File-scoped publisher modes: init creates all files, owners changes only the
 * owner list, and update never includes the owner list. Delete and register
 * are also update-mode mutations; validated source imports use UpdatePublisher.
 */
export type PublisherMode = "init" | "owners" | "update";

interface PublishPlan {
  mode: PublisherMode;
  changes: ArchiveChanges;
  relevantPreconditions: Array<keyof FilePreconditions>;
}

export class Publisher {
  constructor(
    private readonly control: PublisherControl,
    private readonly archive: PublisherArchive,
    private readonly repositoryId: number,
  ) {}

  async publish(untrustedRequest: PublishRequest, run: WorkflowRunRef): Promise<PublishResult> {
    let request = parsePublishRequest(untrustedRequest, this.repositoryId);
    if (request.action === "update") {
      throw new ValidationError("validated update publication must use UpdatePublisher");
    }
    if (request.commentId !== undefined) {
      const alreadyFinished =
        request.action === "owners"
          ? await this.control.successReactionExists(request.commentId)
          : await this.control.resultExists(
              request.issue.number,
              request.commentId,
              request.eventCreatedAt,
            );
      if (alreadyFinished) {
        if (request.action === "owners") {
          await this.control.clearCommandProgress(request.commentId);
        }
        return { kind: "no-op" };
      }
    }
    request = parsePublishRequest(await this.recanonicalize(request), this.repositoryId);
    const current = await this.archive.load(request.id);
    const plan = this.preparePlan(request, current);
    if (
      plan.mode === "owners" &&
      current !== undefined &&
      request.command?.action === "owners" &&
      sameOwners(current.files.ownerList.owners, request.command.owners)
    ) {
      this.validateCurrent(request, current, plan);
      await this.control.completeCommand(request.commentId!);
      return { kind: "no-op" };
    }
    const commit = await this.archive.writeFiles({
      id: request.id,
      changes: plan.changes,
      message: commitMessage(request, run.url),
      validateCurrent: (latest) => this.validateCurrent(request, latest, plan),
    });

    return { kind: "committed", archiveCommit: commit };
  }

  private async recanonicalize(request: PublishRequest): Promise<PublishRequest> {
    const actor = (await this.control.resolveOwnerPairs([request.actor]))[0]!;
    if (request.command?.action !== "owners") return { ...request, actor };
    const owners = await this.control.resolveOwnerPairs(request.command.owners);
    return { ...request, actor, command: { action: "owners", owners } };
  }

  private preparePlan(request: PublishRequest, current: LoadedSubmission | undefined): PublishPlan {
    if (request.action === "create") {
      if (request.initialFiles === undefined) {
        throw new ValidationError("initialization files were not prepared by the unprivileged route job");
      }
      parseArchiveFiles(request.id, request.initialFiles);
      return {
        mode: "init",
        changes: selectChanges(request.initialFiles, [
          "record.json",
          "build-output.json",
          "owner-list.json",
        ]),
        relevantPreconditions: [],
      };
    }
    if (current === undefined) throw new ValidationError(`${request.id} no longer exists in lax-database`);
    if (request.action === "owners") {
      if (request.command?.action !== "owners") throw new ValidationError("owners request is malformed");
      const files = replaceOwnerList(request.id, current.texts, request.command.owners);
      return {
        mode: "owners",
        changes: selectChanges(files, ["owner-list.json"]),
        relevantPreconditions: ["ownerList"],
      };
    }
    if (request.action === "delete") {
      const files = deletedFiles(request.id, current.texts, request.eventCreatedAt);
      return {
        mode: "update",
        changes: selectChanges(files, ["record.json", "build-output.json"]),
        relevantPreconditions: ["record", "buildOutput", "ownerList"],
      };
    }
    if (request.action === "register") {
      const files = registeredFiles(request.id, current.texts);
      return {
        mode: "update",
        changes: selectChanges(files, ["record.json"]),
        relevantPreconditions: ["record", "buildOutput", "ownerList"],
      };
    }
    throw new ValidationError("unsupported publication action");
  }

  private validateCurrent(
    request: PublishRequest,
    current: LoadedSubmission | undefined,
    plan: PublishPlan,
  ): void {
    if (plan.mode === "init") {
      if (current !== undefined) throw new ValidationError(`${request.id} already exists in lax-database`);
      return;
    }
    if (current === undefined) throw new ValidationError(`${request.id} no longer exists in lax-database`);
    const problems: string[] = [];
    if (
      current.files.buildOutput.issue.repositoryId !== request.issue.repositoryId ||
      current.files.buildOutput.issue.number !== request.issue.number
    ) {
      problems.push(`${request.id} no longer has the expected issue binding`);
    }
    if (!current.files.ownerList.owners.some((owner) => owner.githubId === request.actor.githubId)) {
      problems.push(`${request.actor.handle} is no longer an owner of ${request.id}`);
    }
    if (current.files.record.state !== "init" && current.files.record.state !== "draft") {
      problems.push(`${request.id} is now ${current.files.record.state}`);
    }
    if (
      request.preconditions === undefined ||
      !samePreconditions(current.preconditions, request.preconditions, plan.relevantPreconditions)
    ) {
      problems.push(`${request.id} changed after validation; submit a new command comment`);
    }
    if (plan.mode === "owners") {
      const owners = request.command?.action === "owners" ? request.command.owners : [];
      if (!owners.some((owner) => owner.githubId === request.actor.githubId)) {
        problems.push("the replacement owner list no longer retains the commenter");
      }
    }
    if (problems.length > 0) throw new ValidationError(problems.join("\n- "));
  }
}

export async function dispatchWebsiteAndReport(
  control: PublisherControl,
  website: PublisherWebsite,
  untrustedRequest: PublishRequest,
  expectedRepositoryId: number,
  untrustedCommit: string,
  run: WorkflowRunRef,
  titleSyncError = "",
): Promise<void> {
  const request = parsePublishRequest(untrustedRequest, expectedRepositoryId);
  const commit = validateCommit(untrustedCommit);
  let dispatched = true;
  let dispatchError = "";
  try {
    await website.request("POST", `${repositoryPath(WEBSITE_REPOSITORY)}/dispatches`, {
      event_type: "lax-db-updated",
      client_payload: { archiveCommit: commit, submissionId: request.id, action: request.action },
    });
  } catch (error) {
    dispatched = false;
    dispatchError = (error as Error).message;
  }
  try {
    if (request.action === "owners" && dispatched && titleSyncError === "") {
      await control.completeCommand(request.commentId!);
    } else {
      await control.postIssueComment(
        request.issue.number,
        appendWorkflowRun(
          successComment(request, commit, dispatched, dispatchError, titleSyncError),
          run,
        ),
      );
      if (request.action === "update" && dispatched && titleSyncError === "") {
        await control.completeCommand(request.commentId!);
      } else if (request.action === "owners" || request.action === "update") {
        await control.clearCommandProgress(request.commentId!);
      }
    }
  } catch (error) {
    throw new PostCommitError(commit, (error as Error).message);
  }
  if (!dispatched) throw new WebsiteDispatchError(commit, dispatchError);
}

export function parsePublishRequest(value: unknown, expectedRepositoryId: number): PublishRequest {
  if (!isObject(value)) throw new ValidationError("publication request must be an object");
  if (!Number.isSafeInteger(expectedRepositoryId) || expectedRepositoryId <= 0) {
    throw new Error("the authoritative lax repository id must be a positive integer");
  }
  const problems = new ValidationCollector();
  const action = isPublishAction(value.action) ? value.action : undefined;
  if (action === undefined) problems.add("publication request action is invalid");
  const expectedKeys = [
    "action",
    "id",
    "issue",
    "actor",
    "issueNodeId",
    "eventCreatedAt",
    "archiveSha",
    ...(action === "create"
      ? ["title", "initialFiles"]
      : action === undefined
        ? []
        : ["commentId", "command", "preconditions"]),
    ...(action === "delete" && "dependents" in value ? ["dependents"] : []),
    ...(action === "update" && "legacyManifestWithoutIssue" in value
      ? ["legacyManifestWithoutIssue"]
      : []),
  ];
  problems.capture(() => requireExactKeys(value, expectedKeys, "publication request"));

  const issue = problems.capture(() => parseIssueBinding(value.issue));
  if (issue !== undefined && issue.repositoryId !== expectedRepositoryId) {
    problems.add("publication request repository id does not match the authoritative lax repository");
  }
  const id = problems.capture(() => {
    if (typeof value.id !== "string") throw new ValidationError("publication request id must be a string");
    return validateSubmissionId(value.id);
  });
  const actor = problems.capture(() => {
    if (!isObject(value.actor)) throw new ValidationError("publication request actor is missing");
    requireExactKeys(value.actor, ["githubId", "handle"], "publication request actor");
    return validateIdentity(value.actor, "publication request actor");
  });
  const issueNodeId = problems.capture(() => trustedNodeId(value.issueNodeId));
  const eventCreatedAt = problems.capture(() => trustedTimestamp(value.eventCreatedAt));
  const archiveSha = problems.capture(() => validateCommit(value.archiveSha));

  let title: string | undefined;
  let preparedFiles: Record<string, string> | undefined;
  let commentId: number | undefined;
  let command: ParsedCommand | undefined;
  let preconditions: FilePreconditions | undefined;
  let dependents: string[] | undefined;
  let legacyManifestWithoutIssue: true | undefined;
  if (action === "create") {
    title = problems.capture(() => {
      if (typeof value.title !== "string") throw new ValidationError("publication title must be a string");
      const normalized = normalizeTitle(value.title);
      if (normalized !== value.title) throw new ValidationError("publication title is not normalized");
      return normalized;
    });
    preparedFiles = problems.capture(() => trustedInitialFiles(value.initialFiles));
    if (
      preparedFiles !== undefined &&
      id !== undefined &&
      issue !== undefined &&
      actor !== undefined &&
      eventCreatedAt !== undefined
    ) {
      const expected = initialFiles(id, issue, actor, eventCreatedAt);
      if (Object.keys(expected).some((name) => expected[name] !== preparedFiles![name])) {
        problems.add(
          "initialization files do not exactly match the requested issue, actor, id, and timestamp",
        );
      }
    }
  } else if (action !== undefined) {
    commentId = problems.capture(() => positiveInteger(value.commentId, "publication comment id"));
    command = problems.capture(() => trustedCommand(value.command, action));
    preconditions = problems.capture(() => trustedPreconditions(value.preconditions));
    if (action === "delete" && "dependents" in value) {
      dependents = problems.capture(() => trustedDependents(value.dependents));
    }
    if (action === "update" && "legacyManifestWithoutIssue" in value) {
      if (value.legacyManifestWithoutIssue !== true) {
        problems.add("publication request legacy manifest compatibility flag is invalid");
      } else legacyManifestWithoutIssue = true;
    }
  }
  problems.throwIfAny();

  const common = {
    action: action!,
    id: id!,
    issue: issue!,
    actor: actor!,
    issueNodeId: issueNodeId!,
    eventCreatedAt: eventCreatedAt!,
    archiveSha: archiveSha!,
  };
  if (action === "create") {
    return { ...common, action, title: title!, initialFiles: preparedFiles! };
  }
  return {
    ...common,
    action: action!,
    commentId: commentId!,
    command: command!,
    preconditions: preconditions!,
    ...(dependents === undefined ? {} : { dependents }),
    ...(legacyManifestWithoutIssue === undefined ? {} : { legacyManifestWithoutIssue }),
  };
}

export class WebsiteDispatchError extends Error {
  constructor(
    readonly archiveCommit: string,
    detail: string,
  ) {
    super(`lax-database changed at ${archiveCommit}, but Website dispatch failed: ${safe(detail)}`);
    this.name = "WebsiteDispatchError";
  }
}

export class PostCommitError extends Error {
  constructor(
    readonly archiveCommit: string,
    detail: string,
  ) {
    super(`lax-database changed at ${archiveCommit}, but the result comment failed: ${detail}`);
    this.name = "PostCommitError";
  }
}

type PublishAction = PublishRequest["action"];

function isPublishAction(value: unknown): value is PublishAction {
  return ["create", "owners", "update", "delete", "register"].includes(String(value));
}

function trustedNodeId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_=-]{1,200}$/u.test(value)) {
    throw new ValidationError("publication issue node id is invalid");
  }
  return value;
}

function trustedTimestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u.test(value)) {
    throw new ValidationError("publication event timestamp must be canonical UTC without fractions");
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf()) || date.toISOString().replace(".000Z", "Z") !== value) {
    throw new ValidationError("publication event timestamp is not real");
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ValidationError(`${label} must be a positive integer`);
  }
  return value as number;
}

function trustedInitialFiles(value: unknown): Record<string, string> {
  if (!isObject(value)) throw new ValidationError("publication initialization files must be an object");
  requireExactKeys(
    value,
    ["record.json", "build-output.json", "owner-list.json"],
    "publication initialization files",
  );
  const files: Record<string, string> = {};
  for (const name of ["record.json", "build-output.json", "owner-list.json"]) {
    if (typeof value[name] !== "string") {
      throw new ValidationError(`publication initialization file ${name} must be text`);
    }
    files[name] = value[name];
  }
  return files;
}

function trustedCommand(value: unknown, expectedAction: Exclude<PublishAction, "create">): ParsedCommand {
  if (!isObject(value)) throw new ValidationError("publication command must be an object");
  if (value.action !== expectedAction) {
    throw new ValidationError("publication action and command action do not match");
  }
  if (expectedAction === "owners") {
    requireExactKeys(value, ["action", "owners"], "publication owners command");
    return { action: "owners", owners: parseOwnerList({ specVersion: "1", owners: value.owners }).owners };
  }
  if (expectedAction === "update") {
    requireExactKeys(
      value,
      ["action", "repository", "commit", "folder"],
      "publication update command",
    );
    return { action: "update", ...validateSource({
      repository: value.repository,
      commit: value.commit,
      folder: value.folder,
    }) };
  }
  requireExactKeys(value, ["action"], `publication ${expectedAction} command`);
  return { action: expectedAction };
}

function trustedPreconditions(value: unknown): FilePreconditions {
  if (!isObject(value)) throw new ValidationError("publication file preconditions must be an object");
  requireExactKeys(
    value,
    ["record", "buildOutput", "ownerList"],
    "publication file preconditions",
  );
  for (const key of ["record", "buildOutput", "ownerList"] as const) {
    if (typeof value[key] !== "string" || !/^[0-9a-f]{64}$/u.test(value[key])) {
      throw new ValidationError(`publication ${key} precondition must be a lowercase SHA-256 digest`);
    }
  }
  return {
    record: value.record as string,
    buildOutput: value.buildOutput as string,
    ownerList: value.ownerList as string,
  };
}

function trustedDependents(value: unknown): string[] {
  if (!Array.isArray(value)) throw new ValidationError("publication dependents must be an array");
  const dependents = value.map((entry) => {
    if (typeof entry !== "string") throw new ValidationError("publication dependent id must be a string");
    return validateSubmissionId(entry);
  });
  const sorted = [...new Set(dependents)].sort((left, right) =>
    Number(left.slice(4)) - Number(right.slice(4)),
  );
  if (sorted.length !== dependents.length || sorted.some((entry, index) => entry !== dependents[index])) {
    throw new ValidationError("publication dependents must be unique and sorted by submission number");
  }
  return dependents;
}

function sameOwners(left: GitHubIdentity[], right: GitHubIdentity[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (owner, index) =>
        owner.githubId === right[index]!.githubId && owner.handle === right[index]!.handle,
    )
  );
}

function selectChanges(files: Record<string, string>, names: ArchiveFilename[]): ArchiveChanges {
  return Object.fromEntries(names.map((name) => [name, files[name]!])) as ArchiveChanges;
}

function marker(request: PublishRequest): string {
  return request.commentId === undefined
    ? initializationMarker(request.issue.number)
    : resultMarker(request.commentId);
}

export function commitMessage(request: PublishRequest, runUrl: string): string {
  const actor = `${request.actor.handle} (${request.actor.githubId})`;
  const headline =
    request.action === "create"
      ? `initialize ${request.id} by ${actor}`
      : `${request.action} ${request.id} by ${actor}`;
  const trailers = [
    `lax-repository-id: ${request.issue.repositoryId}`,
    `lax-issue-number: ${request.issue.number}`,
    `lax-issue-node-id: ${request.issueNodeId}`,
    `lax-actor-id: ${request.actor.githubId}`,
    ...(request.commentId === undefined ? [] : [`lax-comment-id: ${request.commentId}`]),
    `lax-workflow-run: ${runUrl}`,
  ];
  return `${headline}\n\n${trailers.join("\n")}`;
}

function successComment(
  request: PublishRequest,
  commit: string,
  dispatched: boolean,
  dispatchError: string,
  titleSyncError: string,
): string {
  const actionText =
    request.action === "create"
      ? `Initialized **${request.id}** in lax-database.`
      : request.action === "owners"
        ? `Updated the owners of **${request.id}**.`
        : request.action === "delete"
          ? `Deleted **${request.id}**; the id is permanently retired.`
          : request.action === "update"
            ? `Updated **${request.id}** from its validated immutable source.`
          : `Registered **${request.id}**; it is now immutable.`;
  const dispatchText = dispatched
    ? "The Website rebuild event was accepted."
    : `lax-database changed, but the Website rebuild was not dispatched (${safe(dispatchError)}).`;
  const dependents =
    request.action === "delete" && (request.dependents?.length ?? 0) > 0
      ? `\n\nKnown dependents: ${request.dependents!.map((id) => `\`${id}\``).join(", ")}.`
      : "";
  const titleText = titleSyncError === ""
    ? ""
    : ` The Archive update succeeded, but the issue title was not synchronized (${safe(titleSyncError)}).`;
  return (
    `${actionText}\n\nArchive commit: \`${commit}\`. ${dispatchText}${titleText}${dependents}\n\n` +
    `${marker(request)}\n${resultStatusMarker(dispatched && titleSyncError === "" ? "success" : "failure")}`
  );
}

function safe(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").slice(0, 300);
}
