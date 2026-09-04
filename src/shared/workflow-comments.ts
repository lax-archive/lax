export interface WorkflowRunRef {
  id: string;
  url: string;
}

export function resultMarker(commentId: number): string {
  return `<!-- lax-result-comment-id:${commentId} -->`;
}

export function previewMarker(commentId: number): string {
  return `<!-- lax-preview-comment-id:${commentId} -->`;
}

export function initializationMarker(issueNumber: number): string {
  return `<!-- lax-initialization-issue:${issueNumber} -->`;
}

export function initializationPreviewMarker(issueNumber: number): string {
  return `<!-- lax-initialization-preview-issue:${issueNumber} -->`;
}

export function workflowRunMarker(runId: string): string {
  return `<!-- lax-workflow-run-id:${runId} -->`;
}

/**
 * Whether a result comment reports a completed command or a refused one.
 * Prose says which in English; this says it to `lax submit`, which has to
 * choose an exit status and cannot read English.
 */
export type CommandOutcome = "success" | "failure";

export function outcomeMarker(outcome: CommandOutcome): string {
  return `<!-- lax-outcome:${outcome} -->`;
}

function commandContextStart(commentId: number): string {
  return `<!-- lax-command-context:${commentId}:start -->`;
}

function commandContextEnd(commentId: number): string {
  return `<!-- lax-command-context:${commentId}:end -->`;
}

export function appendWorkflowRun(
  body: string,
  run: WorkflowRunRef,
  outcome?: CommandOutcome,
): string {
  return (
    `${body}\n\nWorkflow run: [#${run.id}](${run.url})\n${workflowRunMarker(run.id)}` +
    (outcome === undefined ? "" : `\n${outcomeMarker(outcome)}`)
  );
}

/** Append or replace the workflow-owned context on an originating command comment. */
export function upsertCommandContext(body: string, commentId: number, context: string): string {
  const start = commandContextStart(commentId);
  const end = commandContextEnd(commentId);
  const startAt = body.indexOf(start);
  let withoutContext = body;
  if (startAt !== -1) {
    const endAt = body.indexOf(end, startAt + start.length);
    if (endAt !== -1) {
      withoutContext = `${body.slice(0, startAt)}${body.slice(endAt + end.length)}`;
    }
  }
  return `${withoutContext.trimEnd()}\n\n${start}\n${context.trim()}\n${end}`;
}

export function readCommandContext(body: string, commentId: number): string | undefined {
  const start = commandContextStart(commentId);
  const end = commandContextEnd(commentId);
  const startAt = body.indexOf(start);
  if (startAt === -1) return undefined;
  const contentAt = startAt + start.length;
  const endAt = body.indexOf(end, contentAt);
  return endAt === -1 ? undefined : body.slice(contentAt, endAt).trim();
}

export interface ParsedWorkflowComment {
  initializationIssue?: number;
  initializationPreviewIssue?: number;
  previewCommentId?: number;
  resultCommentId?: number;
  runId?: string;
  runUrl?: string;
  outcome?: CommandOutcome;
}

/** Parse the stable, hidden correlation markers emitted by the control plane. */
export function parseWorkflowComment(body: string): ParsedWorkflowComment {
  // Workflow-owned markers are appended after visible text. Read the final
  // occurrence so quoted or echoed text cannot shadow the authoritative one.
  const initialization = lastMatch(body, /<!-- lax-initialization-issue:([1-9][0-9]*) -->/gu);
  const initializationPreview = lastMatch(
    body,
    /<!-- lax-initialization-preview-issue:([1-9][0-9]*) -->/gu,
  );
  const preview = lastMatch(body, /<!-- lax-preview-comment-id:([1-9][0-9]*) -->/gu);
  const result = lastMatch(body, /<!-- lax-result-comment-id:([1-9][0-9]*) -->/gu);
  const run = lastMatch(body, /<!-- lax-workflow-run-id:([0-9]+) -->/gu);
  const runLink = lastMatch(
    body,
    /Workflow run:\s*\[#([0-9]+)\]\((https:\/\/[^\s)]+)\)/gu,
  );
  const outcome = lastMatch(body, /<!-- lax-outcome:(success|failure) -->/gu);
  return {
    ...(outcome === undefined ? {} : { outcome: outcome[1] as CommandOutcome }),
    ...(initialization === undefined ? {} : { initializationIssue: Number(initialization[1]) }),
    ...(initializationPreview === undefined
      ? {}
      : { initializationPreviewIssue: Number(initializationPreview[1]) }),
    ...(preview === undefined ? {} : { previewCommentId: Number(preview[1]) }),
    ...(result === undefined ? {} : { resultCommentId: Number(result[1]) }),
    ...(run === undefined ? {} : { runId: run[1] }),
    ...(runLink === undefined ? {} : { runUrl: runLink[2] }),
  };
}

function lastMatch(body: string, pattern: RegExp): RegExpMatchArray | undefined {
  return [...body.matchAll(pattern)].at(-1);
}

export function visibleComment(body: string): string {
  return body
    .split("\n")
    .filter((line) => !/^<!-- lax-[a-z-]+:[^>]+ -->$/u.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
