import { adminStateProblem, maintainerProblem } from "./admin.js";
import { ArchiveRepository } from "./archive.js";
import { initialFiles } from "./archive-schema.js";
import { commandHead, commandSubmissionId, parseRoutedCommand } from "./commands.js";
import {
  ADMIN_GITHUB_IDS,
  CONTROL_REPOSITORY,
  GITHUB_ACTIONS_BOT_ID,
  GITHUB_ACTIONS_BOT_LOGIN,
} from "./constants.js";
import { GitHubClient, repositoryPath } from "./github.js";
import {
  isLegacyIssueReservationBody,
  submissionIdFromIssueBody,
} from "./issue-reservation.js";
import {
  validatesManifest,
  type AdminVerb,
  type GitHubIdentity,
  type ParsedCommand,
  type PublishRequest,
  type SourceLocation,
} from "./types.js";
import {
  isObject,
  normalizeTitle,
  submissionId,
  validateIdentity,
  validateSource,
  ValidationCollector,
  ValidationError,
} from "./validation.js";
import {
  initializationPreviewMarker,
  previewMarker,
  resultMarker,
  upsertCommandContext,
  workflowRunMarker,
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
  body: string | null;
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
    /** Maintainer ids; injectable for tests, ADMIN_GITHUB_IDS in production. */
    private readonly admins: ReadonlySet<number> = ADMIN_GITHUB_IDS,
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

  async resultExists(issueNumber: number, commentId: number, since?: string): Promise<boolean> {
    return this.markerExists(issueNumber, [resultMarker(commentId)], since);
  }

  async previewExists(issueNumber: number, commentId: number, since?: string): Promise<boolean> {
    return this.markerExists(issueNumber, [previewMarker(commentId)], since);
  }

  async initializationPreviewExists(issueNumber: number, since?: string): Promise<boolean> {
    return this.markerExists(issueNumber, [initializationPreviewMarker(issueNumber)], since);
  }

  /**
   * True when this workflow run already posted a bot comment carrying both the
   * correlation marker and this run's marker. The fallback failure reporter
   * uses it to stay idempotent under re-run attempts of the same run without
   * being suppressed by result comments from earlier runs.
   */
  async failureReportExists(issueNumber: number, marker: string, runId: string): Promise<boolean> {
    return this.markerExists(issueNumber, [marker, workflowRunMarker(runId)]);
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
    const payloadIssue = object(event.issue, "event issue");
    const number = problems.capture(() => positiveInteger(payloadIssue.number, "issue number"));
    if (number === undefined) problems.throwIfAny();
    const issue = await this.github.request<IssueResponse>("GET", `${this.controlBase}/issues/${number!}`);
    const markedId = problems.capture(() => submissionIdFromIssueBody(issue.body));
    const id = markedId ?? (isLegacyIssueReservationBody(issue.body) ? submissionId(number!) : undefined);
    if (id === undefined) {
      problems.throwIfAny();
      return { kind: "ignore" };
    }
    if (event.action !== "opened") problems.add("issue event action must be opened");
    if (issue.number !== number) problems.add("fetched issue number does not match the event issue");
    if (issue.state !== "open") problems.add("submission allocation requires an open issue");
    if ("pull_request" in issue) problems.add("submission allocation requires an ordinary issue, not a pull request");
    const actor = problems.capture(() => eventIdentity(issue.user, "issue creator"));
    const title = problems.capture(() => normalizeTitle(issue.title));
    const issueNodeId = problems.capture(() => nodeId(issue.node_id));
    const eventCreatedAt = problems.capture(() => normalizeTimestamp(issue.created_at));
    const currentActor =
      actor === undefined
        ? undefined
        : await problems.captureAsync(() => this.resolveIdentity(actor));
    // Construct and schema-check all stubs before checking publication state or minting an App token.
    const files =
      currentActor === undefined || eventCreatedAt === undefined
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
    if (snapshot !== undefined) {
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
        id,
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
    const head = commandHead(body);
    if (head === "ignore") return { kind: "ignore" };
    if (head === "unknown") problems.add("unknown /lax command");
    // The maintainer form is decided from the closed head alone; its actor
    // gate replaces the owner gate below, and its lifecycle gate is per verb.
    const adminVerb = head !== "unknown" && head.admin ? (head.action as AdminVerb) : undefined;
    const admin = adminVerb !== undefined;
    if (number === undefined) problems.throwIfAny();
    const issue = await this.github.request<IssueResponse>("GET", `${this.controlBase}/issues/${number!}`);
    const legacyId = submissionId(number!);
    const markedId = problems.capture(() => submissionIdFromIssueBody(issue.body));
    const legacyReservation = isLegacyIssueReservationBody(issue.body);
    const reservedId = markedId ?? (legacyReservation ? legacyId : undefined);
    if (reservedId === undefined) {
      problems.throwIfAny();
      return { kind: "ignore" };
    }
    // Registered and deleted records live on closed issues — exactly the ones
    // a maintainer must still reach — so only author commands need an open one.
    if (issue.state !== "open" && !admin) problems.add("commands are accepted only on open issues");
    if ("pull_request" in issue) problems.add("commands are not accepted on pull requests");
    const commentId = problems.capture(() => positiveInteger(comment.id, "comment id"));
    const issueNodeId = problems.capture(() => nodeId(issue.node_id));
    const eventCreatedAt = problems.capture(() => normalizeTimestamp(String(comment.created_at ?? "")));
    problems.throwIfAny();
    if (await this.resultExists(number!, commentId!, eventCreatedAt!)) return { kind: "ignore" };
    const id = commandSubmissionId(body, legacyId);
    if (id !== reservedId) {
      throw new ValidationError(`${id} does not match the submission id reserved by this issue`);
    }
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
    const state = loaded.files.record.state;
    if (adminVerb !== undefined) {
      if (actor !== undefined) {
        const problem = maintainerProblem(actor, this.admins);
        if (problem !== undefined) problems.add(problem);
      }
      const problem = adminStateProblem(adminVerb, id, state, loaded.files.record.source !== undefined);
      if (problem !== undefined) problems.add(problem);
    } else {
      if (state !== "init" && state !== "draft") {
        problems.add(`${id} is ${state} and cannot be changed`);
      }
      if (actor !== undefined && !loaded.files.ownerList.owners.some((owner) => owner.githubId === actor.githubId)) {
        problems.add(`${actor.handle} is not an owner of ${id}`);
      }
    }
    problems.throwIfAny();

    // Arguments are parsed only after the issue binding, owner and state gates.
    let { command } = parseRoutedCommand(body, legacyId);
    if (command.action === "owners") {
      const owners = await this.resolveOwnerPairs(command.owners);
      // A maintainer replaces the list outright — recovering an orphaned
      // record is the point — so only the author form keeps the commenter.
      if (!admin && !owners.some((owner) => owner.githubId === actor!.githubId)) {
        throw new ValidationError("the replacement owner list must retain the commenter");
      }
      command = admin ? { action: "owners", owners, admin: true } : { action: "owners", owners };
    }
    if (command.action === "revalidate") {
      // The source is the record's own, re-read through the same validator
      // the author form applies to a typed triple; the comment carries none.
      command = { action: "revalidate", admin: true, source: validateSource(loaded.files.record.source) };
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
      ...(validatesManifest(command.action) && legacyReservation
        ? { legacyManifestWithoutIssue: true as const }
        : {}),
    };
    if (command.action === "submit") {
      return {
        kind: "validate",
        request,
        preview: submitPreview(id, command, commentId!),
      };
    }
    if (command.action === "revalidate") {
      return {
        kind: "validate",
        request,
        preview: revalidatePreview(id, state, command.source!, commentId!),
      };
    }
    const preview =
      command.action === "delete"
        ? deletePreview(id, state, dependents ?? [], commentId!, admin)
        : command.action === "register"
          ? registerPreview(id, state, commentId!)
          : command.action === "reset-draft"
            ? resetDraftPreview(id, state, commentId!)
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

  private async markerExists(
    issueNumber: number,
    markers: readonly string[],
    since?: string,
  ): Promise<boolean> {
    const query = since === undefined ? "" : `?since=${encodeURIComponent(since)}`;
    const comments = await this.github.paginate<CommentResponse>(
      `${this.controlBase}/issues/${issueNumber}/comments${query}`,
    );
    return comments.some(
      (comment) =>
        comment.user?.id === GITHUB_ACTIONS_BOT_ID &&
        comment.user.login === GITHUB_ACTIONS_BOT_LOGIN &&
        comment.user.type === "Bot" &&
        markers.every((marker) => comment.body?.includes(marker) === true),
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

function submitPreview(id: string, command: Extract<ParsedCommand, { action: "submit" }>, commentId: number): string {
  return (
    `Submit preview for **${id}**:\n\n` +
    `- Repository: \`${command.repository}\`\n` +
    `- Commit: \`${command.commit}\`\n` +
    `- Folder: \`${command.folder}\`\n\n` +
    previewMarker(commentId)
  );
}

function deletePreview(
  id: string,
  state: string,
  dependents: string[],
  commentId: number,
  byMaintainer = false,
): string {
  const dependentText =
    dependents.length === 0
      ? "No known live dependents were found."
      : `Known dependents that will be stranded: ${dependents.map((value) => `\`${value}\``).join(", ")}.`;
  const who = byMaintainer ? " by maintainer action" : "";
  return (
    `Delete preview for **${id}** (currently \`${state}\`)${who}. Deletion is permanent and the id will ` +
    `never be reused. ${dependentText}\n\n${previewMarker(commentId)}`
  );
}

function revalidatePreview(id: string, state: string, source: SourceLocation, commentId: number): string {
  return (
    `Revalidation preview for **${id}** (currently \`${state}\`), by maintainer action. The recorded ` +
    `source is rebuilt from scratch and its build output republished; the state does not change.\n\n` +
    `- Repository: \`${source.repository}\`\n` +
    `- Commit: \`${source.commit}\`\n` +
    `- Folder: \`${source.folder}\`\n\n` +
    previewMarker(commentId)
  );
}

function resetDraftPreview(id: string, state: string, commentId: number): string {
  return (
    `Reset-to-draft preview for **${id}** (currently \`${state}\`), by maintainer action. The record ` +
    `becomes a draft again — mutable, and no longer citable until it is re-registered.\n\n` +
    previewMarker(commentId)
  );
}

function registerPreview(id: string, state: string, commentId: number): string {
  return (
    `Registration preview for **${id}** (currently \`${state}\`). Registration is permanent and ` +
    `makes the record immutable.\n\n${previewMarker(commentId)}`
  );
}
