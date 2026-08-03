import { ArchiveRepository } from "./archive.js";
import { initialFiles } from "./archive-schema.js";
import { commandWord, parseCommand } from "./commands.js";
import {
  CONTROL_REPOSITORY,
  GITHUB_ACTIONS_BOT_ID,
  GITHUB_ACTIONS_BOT_LOGIN,
} from "./constants.js";
import { GitHubClient, repositoryPath } from "./github.js";
import type { GitHubIdentity, ParsedCommand, PublishRequest } from "./types.js";
import {
  isObject,
  normalizeTitle,
  submissionId,
  validateIdentity,
  ValidationCollector,
  ValidationError,
} from "./validation.js";
import {
  initializationPreviewMarker,
  previewMarker,
  resultMarker,
  upsertCommandContext,
} from "./workflow-comments.js";

interface IssueUser {
  id: number;
  login: string;
  type: string;
}

interface IssueResponse {
  number: number;
  node_id: string;
  state: string;
  title: string;
  created_at: string;
  user: IssueUser | null;
  pull_request?: unknown;
}

interface UserResponse {
  id: number;
  login: string;
  type: string;
}

interface CommentResponse {
  id: number;
  body: string | null;
  user: IssueUser | null;
}

interface ReactionResponse {
  id: number;
  content: string;
  user: IssueUser | null;
}

export type RouteResult =
  | { kind: "ignore" }
  | { kind: "publish"; request: PublishRequest; preview?: string }
  | { kind: "validate"; request: PublishRequest; preview: string };

export class ControlPlane {
  private readonly controlBase = repositoryPath(CONTROL_REPOSITORY);

  constructor(
    private readonly github: GitHubClient,
    private readonly archive: ArchiveRepository,
    private readonly repositoryId: number,
  ) {
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
      throw new Error("LAX_REPOSITORY_ID must be the positive numeric id of lax-archive/lax");
    }
  }

  async route(eventName: string, rawEvent: unknown): Promise<RouteResult> {
    const event = object(rawEvent, "GitHub event");
    const repository = object(event.repository, "event repository");
    const problems = new ValidationCollector();
    if (repository.id !== this.repositoryId)
      problems.add("event repository id does not match the authoritative lax repository");
    if (repository.full_name !== CONTROL_REPOSITORY)
      problems.add("event repository name does not match the authoritative lax repository");
    if (eventName !== "issues" && eventName !== "issue_comment")
      problems.add(`unsupported GitHub event ${eventName}`);
    problems.throwIfAny();
    if (eventName === "issues") return this.routeCreate(event);
    return this.routeComment(event);
  }

  async postIssueComment(issueNumber: number, body: string): Promise<void> {
    await this.github.request("POST", `${this.controlBase}/issues/${issueNumber}/comments`, { body });
  }

  async annotateIssueComment(commentId: number, context: string): Promise<void> {
    const path = `${this.controlBase}/issues/comments/${commentId}`;
    const comment = await this.github.request<CommentResponse>("GET", path);
    if (typeof comment.body !== "string") throw new ValidationError("command comment body is missing");
    await this.github.request("PATCH", path, {
      body: upsertCommandContext(comment.body, commentId, context),
    });
  }

  async markCommandStarted(commentId: number): Promise<void> {
    await this.github.request("POST", `${this.controlBase}/issues/comments/${commentId}/reactions`, {
      content: "rocket",
    });
  }

  async completeCommand(commentId: number): Promise<void> {
    await this.github.request("POST", `${this.controlBase}/issues/comments/${commentId}/reactions`, {
      content: "+1",
    });
    await this.clearCommandProgress(commentId);
  }

  async clearCommandProgress(commentId: number): Promise<void> {
    const reaction = await this.findBotReaction(commentId, "rocket");
    if (reaction === undefined) return;
    await this.github.request(
      "DELETE",
      `${this.controlBase}/issues/comments/${commentId}/reactions/${reaction.id}`,
    );
  }

  async successReactionExists(commentId: number): Promise<boolean> {
    return (await this.findBotReaction(commentId, "+1")) !== undefined;
  }

  private async findBotReaction(commentId: number, content: string): Promise<ReactionResponse | undefined> {
    const reactions = await this.github.paginate<ReactionResponse>(
      `${this.controlBase}/issues/comments/${commentId}/reactions`,
    );
    return reactions.find(
      (reaction) =>
        Number.isSafeInteger(reaction.id) &&
        reaction.id > 0 &&
        reaction.content === content &&
        reaction.user?.id === GITHUB_ACTIONS_BOT_ID &&
        reaction.user.login === GITHUB_ACTIONS_BOT_LOGIN &&
        reaction.user.type === "Bot",
    );
  }

  async resultExists(issueNumber: number, commentId: number): Promise<boolean> {
    return this.markerExists(issueNumber, resultMarker(commentId));
  }

  async previewExists(issueNumber: number, commentId: number): Promise<boolean> {
    return this.markerExists(issueNumber, previewMarker(commentId));
  }

  async initializationPreviewExists(issueNumber: number): Promise<boolean> {
    return this.markerExists(issueNumber, initializationPreviewMarker(issueNumber));
  }

  async resolveOwnerPairs(owners: GitHubIdentity[]): Promise<GitHubIdentity[]> {
    const canonical: GitHubIdentity[] = [];
    const errors: string[] = [];
    for (const owner of owners) {
      try {
        const user = await this.github.request<UserResponse>(
          "GET",
          `/users/${encodeURIComponent(owner.handle)}`,
        );
        if (user.type !== "User") errors.push(`${owner.handle} is not a human GitHub user`);
        else if (user.id !== owner.githubId)
          errors.push(`${owner.handle} currently resolves to numeric id ${user.id}, not ${owner.githubId}`);
        else canonical.push({ githubId: user.id, handle: user.login });
      } catch (error) {
        errors.push(`${owner.handle} could not be resolved: ${(error as Error).message}`);
      }
    }
    if (errors.length > 0) throw new ValidationError(errors.join("\n- "));
    canonical.sort((left, right) => left.githubId - right.githubId);
    return canonical;
  }

  private async routeCreate(event: Record<string, unknown>): Promise<RouteResult> {
    const problems = new ValidationCollector();
    if (event.action !== "opened") problems.add("issue event action must be opened");
    const payloadIssue = object(event.issue, "event issue");
    const number = problems.capture(() => positiveInteger(payloadIssue.number, "issue number"));
    if (number === undefined) problems.throwIfAny();
    const issue = await this.github.request<IssueResponse>("GET", `${this.controlBase}/issues/${number!}`);
    if (issue.state !== "open") problems.add("submission allocation requires an open issue");
    if ("pull_request" in issue) problems.add("submission allocation requires an ordinary issue, not a pull request");
    const actor = problems.capture(() => eventIdentity(issue.user, "issue creator"));
    const id = problems.capture(() => submissionId(number!));
    const title = problems.capture(() => normalizeTitle(issue.title));
    const issueNodeId = problems.capture(() => nodeId(issue.node_id));
    const eventCreatedAt = problems.capture(() => normalizeTimestamp(issue.created_at));
    const currentActor =
      actor === undefined
        ? undefined
        : await problems.captureAsync(() => this.resolveIdentity(actor));
    // Construct and schema-check all stubs before checking publication state or minting an App token.
    const files =
      id === undefined || currentActor === undefined || eventCreatedAt === undefined
        ? undefined
        : problems.capture(() =>
            initialFiles(
              id,
              { repositoryId: this.repositoryId, number: number! },
              currentActor,
              eventCreatedAt,
            ),
          );
    const snapshot = await problems.captureAsync(() => this.archive.snapshot());
    if (id !== undefined && snapshot !== undefined) {
      const exists = await problems.captureAsync(() => this.archive.exists(id, snapshot));
      if (exists === true) {
        problems.add(`${id} already exists in lax-database; initialization is never replayed`);
      }
    }
    problems.throwIfAny();
    return {
      kind: "publish",
      preview:
        `Initialization validated for **${id}**; publication of the three stub files is queued.\n\n` +
        initializationPreviewMarker(number!),
      request: {
        action: "create",
        id: id!,
        issue: { repositoryId: this.repositoryId, number: number! },
        actor: currentActor!,
        issueNodeId: issueNodeId!,
        eventCreatedAt: eventCreatedAt!,
        title: title!,
        archiveSha: snapshot!.sha,
        initialFiles: files!,
      },
    };
  }

  private async routeComment(event: Record<string, unknown>): Promise<RouteResult> {
    const problems = new ValidationCollector();
    if (event.action !== "created") problems.add("comment event action must be created");
    const payloadIssue = object(event.issue, "event issue");
    if ("pull_request" in payloadIssue) return { kind: "ignore" };
    const number = problems.capture(() => positiveInteger(payloadIssue.number, "issue number"));
    const comment = object(event.comment, "event comment");
    const body = typeof comment.body === "string" ? comment.body : "";
    const word = commandWord(body);
    if (word === "ignore") return { kind: "ignore" };
    if (word === "unknown") problems.add("unknown /lax command");
    if (number === undefined) problems.throwIfAny();
    const issue = await this.github.request<IssueResponse>("GET", `${this.controlBase}/issues/${number!}`);
    if (issue.state !== "open") problems.add("commands are accepted only on open issues");
    if ("pull_request" in issue) problems.add("commands are not accepted on pull requests");
    const commentId = problems.capture(() => positiveInteger(comment.id, "comment id"));
    const issueNodeId = problems.capture(() => nodeId(issue.node_id));
    const eventCreatedAt = problems.capture(() => normalizeTimestamp(String(comment.created_at ?? "")));
    problems.throwIfAny();
    if (await this.resultExists(number!, commentId!)) return { kind: "ignore" };
    const id = submissionId(number!);
    const snapshot = await this.archive.snapshot();
    const loaded = await this.archive.load(id, snapshot);
    if (loaded === undefined) throw new ValidationError(`${id} does not exist in lax-database`);
    if (
      loaded.files.buildOutput.issue.repositoryId !== this.repositoryId ||
      loaded.files.buildOutput.issue.number !== number
    ) {
      problems.add(`${id} is not bound to this lax issue`);
    }
    const eventActor = problems.capture(() => eventIdentity(comment.user, "commenter"));
    const actor =
      eventActor === undefined
        ? undefined
        : await problems.captureAsync(() => this.resolveIdentity(eventActor));
    if (loaded.files.record.state !== "init" && loaded.files.record.state !== "draft") {
      problems.add(`${id} is ${loaded.files.record.state} and cannot be changed`);
    }
    if (actor !== undefined && !loaded.files.ownerList.owners.some((owner) => owner.githubId === actor.githubId)) {
      problems.add(`${actor.handle} is not an owner of ${id}`);
    }
    problems.throwIfAny();

    // Arguments are parsed only after the issue binding, owner and state gates.
    let command = parseCommand(body);
    if (command.action === "owners") {
      const owners = await this.resolveOwnerPairs(command.owners);
      if (!owners.some((owner) => owner.githubId === actor!.githubId)) {
        throw new ValidationError("the replacement owner list must retain the commenter");
      }
      command = { action: "owners", owners };
    }
    const dependents = command.action === "delete" ? await this.archive.listDependents(id, snapshot) : undefined;
    const request: PublishRequest = {
      action: command.action,
      id,
      issue: { repositoryId: this.repositoryId, number: number! },
      actor: actor!,
      issueNodeId: issueNodeId!,
      eventCreatedAt: eventCreatedAt!,
      commentId: commentId!,
      command,
      archiveSha: snapshot.sha,
      preconditions: loaded.preconditions,
      dependents,
    };
    if (command.action === "update") {
      return {
        kind: "validate",
        request,
        preview: updatePreview(id, command, commentId!),
      };
    }
    const preview =
      command.action === "delete"
        ? deletePreview(id, loaded.files.record.state, dependents ?? [], commentId!)
        : command.action === "register"
          ? registerPreview(id, loaded.files.record.state, commentId!)
          : undefined;
    return { kind: "publish", request, preview };
  }

  private async resolveIdentity(identity: GitHubIdentity): Promise<GitHubIdentity> {
    const user = await this.github.request<UserResponse>(
      "GET",
      `/users/${encodeURIComponent(identity.handle)}`,
    );
    if (user.type !== "User" || user.id !== identity.githubId) {
      throw new ValidationError("GitHub identity no longer resolves to the event's numeric account id");
    }
    return { githubId: user.id, handle: user.login };
  }

  private async markerExists(issueNumber: number, marker: string): Promise<boolean> {
    const comments = await this.github.paginate<CommentResponse>(
      `${this.controlBase}/issues/${issueNumber}/comments`,
    );
    return comments.some(
      (comment) =>
        comment.user?.id === GITHUB_ACTIONS_BOT_ID &&
        comment.user.login === GITHUB_ACTIONS_BOT_LOGIN &&
        comment.user.type === "Bot" &&
        comment.body?.includes(marker) === true,
    );
  }
}

function eventIdentity(value: unknown, label: string): GitHubIdentity {
  const user = object(value, label);
  if (user.type !== "User") throw new ValidationError(`${label} must be a human GitHub user`);
  return validateIdentity({ githubId: user.id, handle: user.login }, label);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) throw new ValidationError(`${label} is missing or malformed`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ValidationError(`${label} must be a positive integer`);
  }
  return value as number;
}

function normalizeTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new ValidationError("event timestamp is invalid");
  const normalized = date.toISOString().replace(".000Z", "Z");
  if (normalized !== value) throw new ValidationError("event timestamp must be canonical UTC without fractions");
  return normalized;
}

function nodeId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_=-]{1,200}$/u.test(value)) {
    throw new ValidationError("issue node id is invalid");
  }
  return value;
}

function updatePreview(id: string, command: Extract<ParsedCommand, { action: "update" }>, commentId: number): string {
  return (
    `Update preview for **${id}**:\n\n` +
    `- Repository: \`${command.repository}\`\n` +
    `- Commit: \`${command.commit}\`\n` +
    `- Folder: \`${command.folder}\`\n\n` +
    previewMarker(commentId)
  );
}

function deletePreview(id: string, state: string, dependents: string[], commentId: number): string {
  const dependentText =
    dependents.length === 0
      ? "No known live dependents were found."
      : `Known dependents that will be stranded: ${dependents.map((value) => `\`${value}\``).join(", ")}.`;
  return (
    `Delete preview for **${id}** (currently \`${state}\`). Deletion is permanent and the id will ` +
    `never be reused. ${dependentText}\n\n${previewMarker(commentId)}`
  );
}

function registerPreview(id: string, state: string, commentId: number): string {
  return (
    `Registration preview for **${id}** (currently \`${state}\`). Registration is permanent and ` +
    `makes the record immutable.\n\n${previewMarker(commentId)}`
  );
}
