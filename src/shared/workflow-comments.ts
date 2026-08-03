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

function commandContextStart(commentId: number): string {
  return `<!-- lax-command-context:${commentId}:start -->`;
}

function commandContextEnd(commentId: number): string {
  return `<!-- lax-command-context:${commentId}:end -->`;
}

export function appendWorkflowRun(body: string, run: WorkflowRunRef): string {
  return `${body}\n\nWorkflow run: [#${run.id}](${run.url})\n${workflowRunMarker(run.id)}`;
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
}

/** Parse the stable, hidden correlation markers emitted by the control plane. */
export function parseWorkflowComment(body: string): ParsedWorkflowComment {
  const initialization = /<!-- lax-initialization-issue:([1-9][0-9]*) -->/u.exec(body);
  const initializationPreview = /<!-- lax-initialization-preview-issue:([1-9][0-9]*) -->/u.exec(body);
  const preview = /<!-- lax-preview-comment-id:([1-9][0-9]*) -->/u.exec(body);
  const result = /<!-- lax-result-comment-id:([1-9][0-9]*) -->/u.exec(body);
  const run = /<!-- lax-workflow-run-id:([0-9]+) -->/u.exec(body);
  const runLink = /Workflow run:\s*\[#([0-9]+)\]\((https:\/\/[^\s)]+)\)/u.exec(body);
  return {
    ...(initialization === null ? {} : { initializationIssue: Number(initialization[1]) }),
    ...(initializationPreview === null
      ? {}
      : { initializationPreviewIssue: Number(initializationPreview[1]) }),
    ...(preview === null ? {} : { previewCommentId: Number(preview[1]) }),
    ...(result === null ? {} : { resultCommentId: Number(result[1]) }),
    ...(run === null ? {} : { runId: run[1] }),
    ...(runLink === null ? {} : { runUrl: runLink[2] }),
  };
}

export function visibleComment(body: string): string {
  return body
    .split("\n")
    .filter((line) => !/^<!-- lax-[a-z-]+:[^>]+ -->$/u.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
