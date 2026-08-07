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
import { LoadingLine } from "./loading.js";
import { labelled, renderComment } from "./render.js";

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

export interface WorkflowProgress {
  label: string;
  completed: boolean;
  conclusion?: string;
}

interface CommentMatch {
  preview?: string;
  result?: string;
  runId?: string;
  runUrl?: string;
  outcome?: CommandOutcome;
}

export interface FollowOptions {
  /** Command name for every line this prints, e.g. `lax submit`. */
  label: string;
  /**
   * Print the control plane's echo of the request. `lax submit` already
   * printed the exact triple it sent, so it suppresses the echo; `lax delete`
   * and `lax register` do not — their previews carry the record's current
   * state and its stranded dependents, which the CLI does not know.
   */
  showPreview?: boolean;
  /** `lax owners` completes with a bot reaction rather than a comment. */
  acceptSuccessReaction?: boolean;
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

/** Actions job names, as the author's stages rather than as CI internals. */
const STAGES = new Map<string, string>([
  ["precheck", "checking the command"],
  ["route", "checking the command"],
  ["validate", "validating: compile, kernel replay, inspection"],
  ["validation result", "reporting the validation result"],
  ["publish-submit", "publishing to lax-database"],
  ["publish", "publishing to lax-database"],
  ["website", "requesting the website rebuild"],
  ["report-workflow-failure", "reporting the failure"],
]);

const base = repositoryPath(CONTROL_REPOSITORY);

export async function followInitialization(
  client: GitHubClient,
  issueNumber: number,
  label = "lax init",
): Promise<void> {
  await follow(
    client,
    issueNumber,
    (parsed) => {
      const preview = parsed.initializationPreviewIssue === issueNumber;
      const result = parsed.initializationIssue === issueNumber;
      return preview || result ? { preview, result } : undefined;
    },
    { label },
  );
}

export async function followCommand(
  client: GitHubClient,
  issueNumber: number,
  triggeringCommentId: number,
  options: FollowOptions,
): Promise<void> {
  await follow(
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

/**
 * What the run is doing, in the author's terms. GitHub's own job and step
 * names describe the CI machinery — "Restore toolchain and warm mathlib
 * workspace", "Mint lax-database token" — which is noise to someone waiting
 * on a submission, so only the job is consulted and only through STAGES.
 */
export function workflowProgress(run: WorkflowRun, jobs: WorkflowJob[]): WorkflowProgress {
  if (run.status === "completed") {
    const conclusion = run.conclusion ?? "completed";
    return { label: `finished (${terminalText(conclusion)})`, completed: true, conclusion };
  }
  const job =
    jobs.find((candidate) => candidate.status === "in_progress") ??
    jobs.find((candidate) => candidate.status !== "completed");
  if (job === undefined) return { label: humanStatus(run.status), completed: false };
  const stage = STAGES.get(terminalText(job.name).toLowerCase());
  return {
    label: stage ?? (job.status === "in_progress" ? "working" : humanStatus(job.status)),
    completed: false,
  };
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
): Promise<void> {
  const interval = positiveEnv("LAX_POLL_INTERVAL_MS", 3_000);
  const timeout = positiveEnv("LAX_WORKFLOW_TIMEOUT_MS", 6 * 60 * 60 * 1_000);
  const started = Date.now();
  const deadline = started + timeout;
  const loading = new LoadingLine(process.stderr);
  const { label } = options;
  let announcedPreview = false;
  let announcedRun: string | undefined;
  let runId: string | undefined;
  let runUrl: string | undefined;
  let completedWithoutResult = 0;
  let actionsStatusAvailable = true;
  let stage = "waiting for the workflow to start";

  const show = (): void => loading.update(`${label} · ${stage}`, elapsed(Date.now() - started));
  show();
  try {
    while (Date.now() <= deadline) {
      const [comments, successReaction] = await Promise.all([
        client.paginate<IssueComment>(`${base}/issues/${issueNumber}/comments`),
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
        loading.clear();
        console.log(`${label}: workflow run #${runId}: ${runUrl}`);
        announcedRun = runId;
      }
      if (matched.preview !== undefined && !announcedPreview) {
        announcedPreview = true;
        if (options.showPreview === true) {
          loading.clear();
          console.log(labelled(label, renderComment(matched.preview)));
        }
      }
      if (matched.result !== undefined) {
        loading.clear();
        console.log(labelled(label, renderComment(matched.result)));
        // A result comment without an outcome marker predates them; the
        // author has the text either way, so only a stated failure fails.
        if (matched.outcome === "failure") {
          throw new CommandFailedError("FAILED — see the report above");
        }
        return;
      }
      if (successReaction) {
        loading.clear();
        console.log(`${label}: owner list updated.`);
        return;
      }

      if (runId !== undefined && actionsStatusAvailable) {
        let progress: WorkflowProgress | undefined;
        try {
          progress = await readWorkflowProgress(client, runId);
        } catch (error) {
          if (error instanceof GitHubError && error.status === 403) {
            actionsStatusAvailable = false;
            stage = "waiting for the result (GitHub is not reporting run status)";
          } else {
            stage = "waiting for the result (run status is temporarily unavailable)";
          }
        }
        if (progress !== undefined) {
          stage = progress.label;
          completedWithoutResult = progress.completed ? completedWithoutResult + 1 : 0;
          if (completedWithoutResult >= 2) {
            const destination = runUrl === undefined ? "the GitHub Actions page" : runUrl;
            throw new WorkflowOutcomeError(
              `workflow #${runId} finished with ${progress.conclusion ?? "an unknown result"} ` +
                `without posting a result; inspect ${destination}`,
            );
          }
        }
      }

      show();
      await delay(interval);
    }
  } finally {
    loading.clear();
  }
  throw new Error(`timed out waiting for the workflow result on lax-${issueNumber}`);
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
    const parsed = parseWorkflowComment(comment.body);
    const kind = matches(parsed, comment.id);
    if (kind === undefined) continue;
    if (kind.preview) matched.preview = readCommandContext(comment.body, comment.id) ?? comment.body;
    if (kind.result) {
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

async function readWorkflowProgress(client: GitHubClient, runId: string): Promise<WorkflowProgress> {
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
  return workflowProgress(run, response.jobs);
}

function elapsed(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function humanStatus(value: string): string {
  return terminalText(value.replaceAll("_", " "));
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
