import { setTimeout as delay } from "node:timers/promises";
import {
  CONTROL_REPOSITORY,
  GITHUB_ACTIONS_BOT_ID,
  GITHUB_ACTIONS_BOT_LOGIN,
  githubOauthBase,
} from "../shared/constants.js";
import { GitHubClient, GitHubError, repositoryPath } from "../shared/github.js";
import {
  parseWorkflowComment,
  readCommandContext,
  type CommandOutcome,
  type ParsedWorkflowComment,
} from "../shared/workflow-comments.js";
import { renderComment } from "./render.js";
import { fetchValidationReport, type RemoteValidationReport } from "./run-artifacts.js";
import * as ui from "./ui.js";

interface IssueComment {
  id: number;
  body: string | null;
  user: { id: number; login: string; type: string } | null;
}

interface IssueReaction {
  content: string;
  user: { id: number; login: string; type: string } | null;
}

interface WorkflowRun {
  status: string;
  conclusion: string | null;
}

export interface WorkflowStep {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface WorkflowJob {
  name: string;
  status: string;
  conclusion: string | null;
  steps?: WorkflowStep[];
}

interface WorkflowJobs {
  jobs: WorkflowJob[];
}

/**
 * Which of the caller's rows the run is in, and what it is doing there.
 *
 * The row names are the author's two facts about a submission — *the archive is
 * rebuilding it*, *the archive is writing the record* — not the workflow's job
 * graph.
 * `queued` is everything before the archive has started checking: the run does
 * not exist yet, or the routing job is still deciding whether the command was
 * even addressed to it.
 */
export interface WorkflowStage {
  row: "queued" | "validate" | "publish" | "reporting";
  detail?: string;
  /** The row's work is over; the caller may settle it. */
  completed?: boolean;
}

interface CommentMatch {
  preview?: string;
  result?: string;
  runId?: string;
  runUrl?: string;
  outcome?: CommandOutcome;
}

/** What the workflow answered. The caller decides how to say it. */
export interface FollowResult {
  outcome: "success" | "failure";
  /** The result comment's body, unrendered — a failure needs its own words. */
  comment?: string;
  runId?: string;
  runUrl?: string;
}

export interface FollowOptions {
  /** Restrict comment polling to the event that started this operation and later. */
  since?: string;
  /**
   * Every change in what the run is doing. This is the only channel for
   * progress: follow prints nothing itself beyond `--verbose` internals, so the
   * caller's step list stays the one place the author's screen is composed.
   */
  onStage?: (stage: WorkflowStage) => void;
  /**
   * The control plane's echo of the request, already rendered as plain text.
   * `lax submit` has no use for it — it printed the source it sent one row
   * earlier — but `lax delete` and `lax register` do: their previews carry the
   * record's current state and its stranded dependents, which the CLI does not
   * know.
   */
  onPreview?: (text: string) => void;
  /** `lax owners` completes with a bot reaction rather than a comment. */
  acceptSuccessReaction?: boolean;
  /**
   * Submit only: the Validate job's own report, as soon as that job concludes.
   * Throwing from here ends the command, which is exactly what a failed
   * validation should do — the report is the verdict, and the record comment
   * that follows says the same thing with less in it.
   */
  onValidationReport?: (report: RemoteValidationReport) => void | Promise<void>;
}

/**
 * The workflow itself answered — the run finished, it just never posted a
 * result. Distinguished from a transport failure because reattaching (`lax
 * submit --resume`) cannot change this outcome, only re-observe it.
 */
export class WorkflowOutcomeError extends Error {}

/**
 * The workflow answered, and the answer is no: a refused command, a failed
 * validation, a publication that did not complete. The report is already on
 * the author's screen, so this only carries the exit status.
 */
export class CommandFailedError extends Error {}

/** Actions jobs, as the author's two stages rather than as a CI job graph. */
const JOB_ROWS = new Map<string, WorkflowStage["row"]>([
  ["route", "queued"],
  ["validate", "validate"],
  ["publish-submit", "publish"],
  ["publish", "publish"],
  ["report-validation-failure", "reporting"],
  ["report-workflow-failure", "reporting"],
]);

/**
 * What each job is doing, in the author's terms. GitHub's own step names
 * describe the CI machinery — "Restore toolchain and warm mathlib workspace",
 * "Mint lax-database token" — which is noise to someone waiting on a
 * submission, so each is matched to the one thing it means for them. Matched by
 * prefix, longest-lived name first: the names are the workflow's to change, and
 * a renamed step should cost a missing detail, never a wrong one.
 */
const VALIDATE_STEPS: Array<[string, string]> = [
  ["static gate", "checking the layout"],
  ["restore", "preparing a clean machine"],
  ["provision", "preparing a clean machine"],
  ["validate", "compiling and checking"],
  ["save", "saving the toolchain cache"],
  ["preserve", "collecting the report"],
];

/**
 * The publish jobs, same idea. Publishing is not one act: the archive checks
 * the result over again without any credentials, mints the two narrow tokens it
 * needs, and only then commits the record and asks the site to rebuild.
 */
const PUBLISH_STEPS: Array<[string, string]> = [
  ["parse", "re-checking the result"],
  ["mint", "getting write access"],
  ["promote", "committing and rebuilding the site"],
  ["revalidate", "committing and rebuilding the site"],
];

const base = repositoryPath(CONTROL_REPOSITORY);

export async function followInitialization(
  client: GitHubClient,
  issueNumber: number,
  options: FollowOptions = {},
): Promise<FollowResult> {
  return follow(
    client,
    issueNumber,
    (parsed) => {
      const preview = parsed.initializationPreviewIssue === issueNumber;
      const result = parsed.initializationIssue === issueNumber;
      return preview || result ? { preview, result } : undefined;
    },
    options,
  );
}

export async function followCommand(
  client: GitHubClient,
  issueNumber: number,
  triggeringCommentId: number,
  options: FollowOptions = {},
): Promise<FollowResult> {
  return follow(
    client,
    issueNumber,
    (parsed, commentId) => {
      const preview = parsed.previewCommentId === triggeringCommentId;
      const result = parsed.resultCommentId === triggeringCommentId;
      const sourceRun = commentId === triggeringCommentId && parsed.runId !== undefined;
      return preview || result || sourceRun ? { preview, result } : undefined;
    },
    options,
    triggeringCommentId,
    options.acceptSuccessReaction === true ? triggeringCommentId : undefined,
  );
}

/** The stage a run is in, from its own status and its jobs. */
export function workflowStage(run: WorkflowRun, jobs: WorkflowJob[]): WorkflowStage {
  if (run.status === "completed") {
    return { row: "publish", completed: true };
  }
  const job =
    jobs.find((candidate) => candidate.status === "in_progress") ??
    jobs.find((candidate) => candidate.status !== "completed");
  if (job === undefined) return { row: "queued" };
  const row = JOB_ROWS.get(terminalText(job.name).toLowerCase()) ?? "queued";
  const table =
    row === "validate" ? VALIDATE_STEPS : row === "publish" ? PUBLISH_STEPS : undefined;
  const detail = table === undefined ? undefined : stepDetail(job.steps ?? [], table);
  return detail === undefined ? { row } : { row, detail };
}

function stepDetail(
  steps: readonly WorkflowStep[],
  table: ReadonlyArray<readonly [string, string]>,
): string | undefined {
  const running = steps.find((step) => step.status === "in_progress");
  if (running === undefined) return undefined;
  const name = terminalText(running.name).toLowerCase();
  return table.find(([prefix]) => name.startsWith(prefix))?.[1];
}

async function follow(
  client: GitHubClient,
  issueNumber: number,
  matches: (
    parsed: ParsedWorkflowComment,
    commentId: number,
  ) => { preview: boolean; result: boolean } | undefined,
  options: FollowOptions,
  sourceCommentId?: number,
  successReactionCommentId?: number,
): Promise<FollowResult> {
  const interval = positiveEnv("LAX_POLL_INTERVAL_MS", 3_000);
  const timeout = positiveEnv("LAX_WORKFLOW_TIMEOUT_MS", 6 * 60 * 60 * 1_000);
  const deadline = Date.now() + timeout;
  let announcedPreview = false;
  let announcedRun: string | undefined;
  let runId: string | undefined;
  let runUrl: string | undefined;
  let completedWithoutResult = 0;
  let actionsStatusAvailable = true;
  let validationRead = false;
  let stage = "";
  const commentPath = `${base}/issues/${issueNumber}/comments` +
    (options.since === undefined ? "" : `?since=${encodeURIComponent(options.since)}`);

  const report = (next: WorkflowStage): void => {
    const fingerprint = `${next.row} ${next.detail ?? ""} ${next.completed === true}`;
    if (fingerprint === stage) return;
    stage = fingerprint;
    options.onStage?.(next);
  };
  report({ row: "queued" });

  while (Date.now() <= deadline) {
    const [comments, successReaction] = await Promise.all([
      client.paginate<IssueComment>(commentPath),
      successReactionCommentId === undefined
        ? Promise.resolve(false)
        : hasSuccessReaction(client, successReactionCommentId),
    ]);
    const matched = matchComments(comments, matches, sourceCommentId);
    if (matched.runId !== undefined) {
      runId = matched.runId;
      runUrl = matched.runUrl ?? `${githubOauthBase()}/${CONTROL_REPOSITORY}/actions/runs/${runId}`;
    }

    if (runId !== undefined && runUrl !== undefined && runId !== announcedRun) {
      // Exactly what a bug report needs, and nothing an author can act on.
      ui.verbose(`workflow run #${runId}: ${runUrl}`);
      announcedRun = runId;
    }
    if (matched.preview !== undefined && !announcedPreview) {
      announcedPreview = true;
      options.onPreview?.(renderComment(matched.preview));
    }
    if (matched.result !== undefined) {
      if (matched.outcome === undefined) {
        throw new WorkflowOutcomeError(
          `the archive result on lax-${issueNumber} did not include an authenticated outcome`,
        );
      }
      return {
        outcome: matched.outcome,
        comment: matched.result,
        ...(runId === undefined ? {} : { runId }),
        ...(runUrl === undefined ? {} : { runUrl }),
      };
    }
    if (successReaction) {
      return {
        outcome: "success",
        ...(runId === undefined ? {} : { runId }),
        ...(runUrl === undefined ? {} : { runUrl }),
      };
    }

    if (runId !== undefined && actionsStatusAvailable) {
      let next: WorkflowStage | undefined;
      let jobs: WorkflowJob[] = [];
      try {
        const status = await readWorkflowProgress(client, runId);
        next = status.stage;
        jobs = status.jobs;
      } catch (error) {
        if (error instanceof GitHubError && error.status === 403) {
          actionsStatusAvailable = false;
          ui.verbose("GitHub is not reporting run status for this token");
        }
      }
      // The verdict on a submission is the report, not the comment that
      // announces it: as soon as the validate job is done its findings are
      // downloadable, and a failed validation ends the command right here.
      if (options.onValidationReport !== undefined && !validationRead && concluded(jobs, "validate")) {
        validationRead = true;
        const validation = await fetchValidationReport(client, issueNumber, runId);
        // No report at all: the validate job died before writing one, which
        // only the workflow can describe. Its comment is still coming.
        if (validation !== undefined) await options.onValidationReport(validation);
      }
      if (next !== undefined) {
        report(next);
        completedWithoutResult = next.completed === true ? completedWithoutResult + 1 : 0;
        if (completedWithoutResult >= 2) {
          const destination = runUrl ?? "the GitHub Actions page";
          throw new WorkflowOutcomeError(
            `the archive finished working on this command without recording a result; inspect ${destination}`,
          );
        }
      }
    }

    await delay(interval);
  }
  throw new Error(`the archive did not answer about lax-${issueNumber} in time`);
}

function matchComments(
  comments: IssueComment[],
  matches: (
    parsed: ParsedWorkflowComment,
    commentId: number,
  ) => { preview: boolean; result: boolean } | undefined,
  sourceCommentId?: number,
): CommentMatch {
  const matched: CommentMatch = {};
  for (const comment of comments) {
    if (comment.body === null) continue;
    const trustedSource = comment.id === sourceCommentId;
    const trustedBot =
      comment.user?.id === GITHUB_ACTIONS_BOT_ID &&
      comment.user.login === GITHUB_ACTIONS_BOT_LOGIN &&
      comment.user.type === "Bot";
    if (!trustedSource && !trustedBot) continue;
    const workflowOwnedBody = trustedBot
      ? comment.body
      : readCommandContext(comment.body, comment.id);
    if (workflowOwnedBody === undefined) continue;
    const parsed = parseWorkflowComment(workflowOwnedBody);
    const kind = matches(parsed, comment.id);
    if (kind === undefined) continue;
    if (kind.preview) matched.preview = workflowOwnedBody;
    // Only a standalone Actions-bot comment can complete a command. The
    // triggering user still owns and can edit the source comment.
    if (kind.result && trustedBot) {
      matched.result = comment.body;
      matched.outcome = parsed.outcome;
    }
    matched.runId = parsed.runId ?? matched.runId;
    matched.runUrl = parsed.runUrl ?? matched.runUrl;
  }
  return matched;
}

async function hasSuccessReaction(client: GitHubClient, commentId: number): Promise<boolean> {
  const reactions = await client.paginate<IssueReaction>(`${base}/issues/comments/${commentId}/reactions`);
  return reactions.some(
    (reaction) =>
      reaction.content === "+1" &&
      reaction.user?.id === GITHUB_ACTIONS_BOT_ID &&
      reaction.user.login === GITHUB_ACTIONS_BOT_LOGIN &&
      reaction.user.type === "Bot",
  );
}

async function readWorkflowProgress(
  client: GitHubClient,
  runId: string,
): Promise<{ stage: WorkflowStage; jobs: WorkflowJob[] }> {
  const [run, response] = await Promise.all([
    client.request<WorkflowRun>("GET", `${base}/actions/runs/${runId}`),
    client.request<WorkflowJobs>(
      "GET",
      `${base}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
    ),
  ]);
  if (typeof run.status !== "string" || (run.conclusion !== null && typeof run.conclusion !== "string")) {
    throw new Error("GitHub returned a malformed workflow run");
  }
  if (!Array.isArray(response.jobs)) throw new Error("GitHub returned a malformed workflow job list");
  return { stage: workflowStage(run, response.jobs), jobs: response.jobs };
}

/** Whether the named job has finished, under the author-facing job names. */
function concluded(jobs: WorkflowJob[], name: string): boolean {
  return jobs.some(
    (job) => terminalText(job.name).toLowerCase() === name && job.status === "completed",
  );
}

function terminalText(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 200);
}

function positiveEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
