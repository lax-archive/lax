import { samePreconditions, type LoadedSubmission } from "./archive.js";
import { fileDigest, jsonFile, type ArchiveChanges } from "./archive-schema.js";
import { CONTROL_REPOSITORY } from "./constants.js";
import type { PublisherArchive, PublisherControl } from "./publisher.js";
import { AUTHOR_MUTABLE_STATES, recordGateProblems } from "./record-gates.js";
import type { ArchiveRecord, PublishRequest, SourceLocation, SubmissionReceipt } from "./types.js";
import { ValidationError } from "./validation.js";
import { appendWorkflowRun, outcomeMarker, resultMarker, type WorkflowRunRef } from "./workflow-comments.js";

/** Control flow for a valid request that must not overwrite a later published request. */
export class SupersededSubmission extends Error {
  constructor(readonly commentId: number) {
    super(`a newer submission (command comment ${commentId}) is already published`);
  }
}

function compareOrder(a: Pick<SubmissionReceipt, "eventCreatedAt" | "commentId">,
  b: Pick<SubmissionReceipt, "eventCreatedAt" | "commentId">): number {
  return a.eventCreatedAt.localeCompare(b.eventCreatedAt) || a.commentId - b.commentId;
}

function validReceipt(current: LoadedSubmission): SubmissionReceipt | undefined {
  const { lastSubmission: receipt, ...output } = current.files.buildOutput;
  if (current.files.record.state !== "draft" || receipt === undefined ||
    receipt.record !== current.preconditions.record ||
    receipt.buildOutput !== fileDigest(jsonFile(output))) return undefined;
  return receipt;
}

/** Constructed only by trusted publishers, never copied from validation artifacts. */
export function submittedChanges(
  request: PublishRequest,
  current: LoadedSubmission,
  source: SourceLocation,
  buildOutputText: string,
): ArchiveChanges {
  const record: ArchiveRecord = {
    specVersion: "1", id: request.id, state: "draft",
    createdAt: current.files.record.createdAt, source,
  };
  const output = JSON.parse(buildOutputText) as Record<string, unknown>;
  const receipt: SubmissionReceipt = {
    commentId: request.commentId!, eventCreatedAt: request.eventCreatedAt,
    record: fileDigest(jsonFile(record)), buildOutput: fileDigest(jsonFile(output)),
    previous: {
      archiveSha: current.snapshot.sha,
      record: current.preconditions.record, buildOutput: current.preconditions.buildOutput,
    },
  };
  return { "record.json": jsonFile(record), "build-output.json": jsonFile({ ...output, lastSubmission: receipt }) };
}

/**
 * Permit rebasing only through intact receipts for ordinary submissions. The
 * receipt chain points to immutable CAS predecessors, so it cannot hide a
 * registration, reset, revalidation, or unrelated/manual payload edit. Owners
 * are checked at the current snapshot, as before. The returned baseline is
 * the exact payload the route job read, also used to verify metadata evidence.
 */
export async function submissionBaseline(
  archive: PublisherArchive,
  request: PublishRequest,
  current: LoadedSubmission,
  admins: ReadonlySet<number>,
): Promise<LoadedSubmission> {
  const ordinary = request.action === "submit";
  const problems = recordGateProblems(request, current, {
    authorStates: AUTHOR_MUTABLE_STATES,
    relevantPreconditions: ordinary ? [] : ["record", "buildOutput"], admins,
  });
  if (!ordinary) {
    if (problems.length > 0) throw new ValidationError(problems.join("\n- "));
    return current;
  }
  const stale = () => new ValidationError([
    ...problems, `${request.id} changed after validation; submit a new command comment`,
  ].join("\n- "));
  const headReceipt = validReceipt(current);
  if (problems.length === 0 && headReceipt !== undefined &&
    (headReceipt.commentId === request.commentId || compareOrder(headReceipt, {
      eventCreatedAt: request.eventCreatedAt, commentId: request.commentId!,
    }) >= 0)) throw new SupersededSubmission(headReceipt.commentId);

  let cursor = current;
  const seen = new Set<string>();
  while (request.preconditions === undefined ||
    !samePreconditions(cursor.preconditions, request.preconditions, ["record", "buildOutput"])) {
    if (problems.length > 0 || seen.has(cursor.snapshot.sha)) throw stale();
    seen.add(cursor.snapshot.sha);
    const receipt = validReceipt(cursor);
    if (receipt === undefined) throw stale();
    const previous = await archive.load(request.id, {
      branch: current.snapshot.branch, sha: receipt.previous.archiveSha,
    });
    if (previous === undefined ||
      previous.preconditions.record !== receipt.previous.record ||
      previous.preconditions.buildOutput !== receipt.previous.buildOutput ||
      !AUTHOR_MUTABLE_STATES.includes(previous.files.record.state) ||
      previous.files.record.createdAt !== current.files.record.createdAt ||
      JSON.stringify(previous.files.buildOutput.issue) !== JSON.stringify(current.files.buildOutput.issue)) throw stale();
    const parentReceipt = validReceipt(previous);
    if (parentReceipt !== undefined && compareOrder(parentReceipt, receipt) >= 0) throw stale();
    cursor = previous;
  }
  if (problems.length > 0) throw new ValidationError(problems.join("\n- "));
  return cursor;
}

/** A successful skip is correlated to the older command and needs no website/title write. */
export async function finishSupersededSubmission(
  control: PublisherControl, request: PublishRequest, newer: SupersededSubmission,
  run?: WorkflowRunRef,
): Promise<{ kind: "no-op" }> {
  const url = `https://github.com/${CONTROL_REPOSITORY}/issues/${request.issue.number}#issuecomment-${newer.commentId}`;
  const body = (newer.commentId === request.commentId
    ? `**${request.id}**: this command was already published. No database change was repeated.`
    : `**${request.id}**: this submission was superseded by an already-published ` +
      `[newer command](${url}). The newer revision was kept; this command made no database change.`) +
    `\n\n${resultMarker(request.commentId!)}`;
  await control.postIssueComment(request.issue.number,
    run === undefined ? `${body}\n${outcomeMarker("success")}` : appendWorkflowRun(body, run, "success"),
  );
  await control.completeCommand(request.commentId!);
  return { kind: "no-op" };
}
