// Job-level cost tracking for a validation job.
//
// The TypeScript profiler only ever sees the pipeline: by the time
// `run.js` starts, the job has already paid for checkout, dependency
// installation, compilation, and pulling the validation runtime — on a hosted
// runner that overhead is a real share of end-to-end submit time, and it is
// the number the one-job-or-many layout question turns on.
//
// Rather than instrument every step with timestamp markers, this reads the
// step timings GitHub already recorded for the currently running job and folds
// them into the same profile the pipeline writes. It needs only `actions: read`
// on the run's own repository, and it is diagnostics: any failure here is
// swallowed, because a job must never fail over its own accounting.

import { GitHubClient } from "../shared/github.js";
import { formatProfile, type Span } from "../shared/profile.js";
import {
  appendProfileStepSummary,
  recordValidationProfile,
} from "../submission-validation/outputs.js";

interface WorkflowStep {
  name: string;
  status: string;
  conclusion: string | null;
  number: number;
  started_at: string | null;
  completed_at: string | null;
}

interface WorkflowJob {
  id: number;
  name: string;
  runner_name: string | null;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  steps?: WorkflowStep[];
}

const MAX_JOBS = 100;

export async function collectJobProfile(
  github: Pick<GitHubClient, "request">,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Span | undefined> {
  const repository = environment.GITHUB_REPOSITORY;
  const runId = environment.GITHUB_RUN_ID;
  if (repository === undefined || runId === undefined) return undefined;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) || !/^[0-9]+$/u.test(runId)) {
    return undefined;
  }
  const attempt = /^[0-9]+$/u.test(environment.GITHUB_RUN_ATTEMPT ?? "")
    ? environment.GITHUB_RUN_ATTEMPT!
    : "1";
  const listing = await github.request<{ jobs?: WorkflowJob[] }>(
    "GET",
    `/repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=${MAX_JOBS}`,
  );
  const job = selectJob(listing.jobs ?? [], environment);
  if (job === undefined) return undefined;
  return jobSpan(job);
}

/**
 * The Actions context names the job's *key*, not its display name, and a
 * workflow can run several jobs at once. The runner name identifies exactly
 * one running job; the key is the fallback for the single-job case.
 */
function selectJob(jobs: WorkflowJob[], environment: NodeJS.ProcessEnv): WorkflowJob | undefined {
  const runner = environment.RUNNER_NAME;
  if (runner !== undefined && runner !== "") {
    const running = jobs.filter((job) => job.runner_name === runner && job.status === "in_progress");
    if (running.length === 1) return running[0];
  }
  const named = jobs.filter((job) => job.name === environment.GITHUB_JOB);
  if (named.length === 1) return named[0];
  const inProgress = jobs.filter((job) => job.status === "in_progress");
  return inProgress.length === 1 ? inProgress[0] : undefined;
}

function jobSpan(job: WorkflowJob): Span {
  const started = epoch(job.started_at);
  const children: Span[] = [];
  let latest = started ?? 0;
  for (const step of job.steps ?? []) {
    const from = epoch(step.started_at);
    const to = epoch(step.completed_at);
    if (from === undefined) continue;
    // The step running this collector has not completed yet; report what it
    // has taken so far rather than dropping it.
    const end = to ?? Date.now();
    if (end > latest) latest = end;
    children.push({ name: stepName(step), ms: Math.max(0, end - from), children: [] });
  }
  return {
    name: `job ${job.name}`,
    ms: started === undefined ? children.reduce((sum, child) => sum + child.ms, 0) : latest - started,
    children,
  };
}

function stepName(step: WorkflowStep): string {
  const name = step.name.replace(/[\r\n]+/gu, " ").slice(0, 80);
  return step.conclusion === "skipped" ? `${name} (skipped)` : name;
}

function epoch(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Entry point for the workflow step. Appends the job's own step timings to the
 * validation profile and the run's step summary. Never throws.
 */
export async function recordJobProfile(): Promise<void> {
  try {
    const token = process.env.GITHUB_TOKEN;
    if (token === undefined || token === "") return;
    const span = await collectJobProfile(new GitHubClient(token));
    if (span === undefined) return;
    const outputDir = process.env.LAX_VALIDATION_OUTPUT;
    const stage = process.env.LAX_VALIDATION_STAGE ?? "job";
    if (outputDir !== undefined && outputDir !== "") {
      recordValidationProfile(outputDir, `job:${stage}`, span);
    }
    appendProfileStepSummary(`job overhead — ${stage}`, span);
    console.log(formatProfile(span));
  } catch (error) {
    console.warn(`job profile unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  await recordJobProfile();
}
