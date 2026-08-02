import { setTimeout as delay } from "node:timers/promises";
import { CONTROL_REPOSITORY } from "../shared/constants.js";
import { GitHubClient, GitHubError, repositoryPath } from "../shared/github.js";
import {
  parseWorkflowComment,
  visibleComment,
  type ParsedWorkflowComment,
} from "../shared/workflow-comments.js";
import { LoadingLine } from "./loading.js";

interface IssueComment {
  id: number;
  body: string | null;
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
}

const base = repositoryPath(CONTROL_REPOSITORY);

export async function followInitialization(client: GitHubClient, issueNumber: number): Promise<void> {
  await follow(client, issueNumber, (parsed) => {
    const preview = parsed.initializationPreviewIssue === issueNumber;
    const result = parsed.initializationIssue === issueNumber;
    return preview || result ? { preview, result } : undefined;
  });
}

export async function followCommand(
  client: GitHubClient,
  issueNumber: number,
  triggeringCommentId: number,
): Promise<void> {
  await follow(client, issueNumber, (parsed) => {
    const preview = parsed.previewCommentId === triggeringCommentId;
    const result = parsed.resultCommentId === triggeringCommentId;
    return preview || result ? { preview, result } : undefined;
  });
}

/** Select the most useful current job and step from the Actions response. */
export function workflowProgress(run: WorkflowRun, jobs: WorkflowJob[]): WorkflowProgress {
  if (run.status === "completed") {
    const conclusion = run.conclusion ?? "completed";
    return {
      label: `GitHub Actions · ${terminalText(conclusion)}`,
      completed: true,
      conclusion,
    };
  }

  const job =
    jobs.find((candidate) => candidate.status === "in_progress") ??
    jobs.find((candidate) => candidate.status !== "completed");
  if (job === undefined) {
    return { label: `GitHub Actions · ${humanStatus(run.status)}`, completed: false };
  }

  const step = job.steps?.find((candidate) => candidate.status === "in_progress");
  const detail = step?.name ?? (job.status === "in_progress" ? undefined : humanStatus(job.status));
  return {
    label: ["GitHub Actions", terminalText(job.name), detail === undefined ? undefined : terminalText(detail)]
      .filter((part): part is string => part !== undefined && part !== "")
      .join(" · "),
    completed: false,
  };
}

async function follow(
  client: GitHubClient,
  issueNumber: number,
  matches: (
    parsed: ParsedWorkflowComment,
  ) => { preview: boolean; result: boolean } | undefined,
): Promise<void> {
  const interval = positiveEnv("LAX_POLL_INTERVAL_MS", 3_000);
  const timeout = positiveEnv("LAX_WORKFLOW_TIMEOUT_MS", 6 * 60 * 60 * 1_000);
  const deadline = Date.now() + timeout;
  const loading = new LoadingLine(process.stderr);
  let announcedPreview = false;
  let announcedRun: string | undefined;
  let runId: string | undefined;
  let runUrl: string | undefined;
  let completedWithoutResult = 0;
  let actionsStatusAvailable = true;

  loading.update("GitHub Actions · waiting for workflow");
  try {
    while (Date.now() <= deadline) {
      const comments = await client.paginate<IssueComment>(`${base}/issues/${issueNumber}/comments`);
      const matched = matchComments(comments, matches);
      runId = matched.runId ?? runId;
      runUrl = matched.runUrl ?? runUrl;

      if (runId !== undefined && runUrl !== undefined && runId !== announcedRun) {
        loading.clear();
        console.log(`Following workflow run #${runId}: ${runUrl}`);
        announcedRun = runId;
      }
      if (matched.preview !== undefined && !announcedPreview) {
        loading.clear();
        console.log(visibleComment(matched.preview));
        announcedPreview = true;
      }
      if (matched.result !== undefined) {
        loading.clear();
        if (runId !== undefined && runUrl !== undefined) {
          console.log(`Workflow run #${runId}: ${runUrl}`);
        }
        console.log(visibleComment(matched.result));
        return;
      }

      if (runId !== undefined && actionsStatusAvailable) {
        let progress: WorkflowProgress | undefined;
        try {
          progress = await readWorkflowProgress(client, runId);
        } catch (error) {
          if (error instanceof GitHubError && error.status === 403) {
            actionsStatusAvailable = false;
            loading.update("GitHub Actions · status unavailable; waiting for result");
          } else {
            loading.update("GitHub Actions · status temporarily unavailable; waiting for result");
          }
        }
        if (progress !== undefined) {
          loading.update(progress.label);
          completedWithoutResult = progress.completed ? completedWithoutResult + 1 : 0;
          if (completedWithoutResult >= 2) {
            const destination = runUrl === undefined ? "the GitHub Actions page" : runUrl;
            throw new Error(
              `workflow #${runId} finished with ${progress.conclusion ?? "an unknown result"} ` +
                `without posting a result; inspect ${destination}`,
            );
          }
        }
      }

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
  ) => { preview: boolean; result: boolean } | undefined,
): CommentMatch {
  const matched: CommentMatch = {};
  for (const comment of comments) {
    if (comment.body === null) continue;
    const parsed = parseWorkflowComment(comment.body);
    const kind = matches(parsed);
    if (kind === undefined) continue;
    if (kind.preview) matched.preview = comment.body;
    if (kind.result) matched.result = comment.body;
    matched.runId = parsed.runId ?? matched.runId;
    matched.runUrl = parsed.runUrl ?? matched.runUrl;
  }
  return matched;
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
