import { validateNewSubmissionId, ValidationError } from "./validation.js";

const PREFIX = "<!-- lax-submission-id:";

/**
 * Where the marker line ends. GitHub's web editor rewrites the body it saves
 * with CRLF endings, so an author who opens the control issue in a browser and
 * presses "Update comment" turns the marker's LF into a CRLF; cutting the line
 * at a CR as well as an LF keeps that edit from detaching the submission from
 * its issue. Everything after the first ending stays out of the match, so a
 * later line can never complete a marker its own line leaves unfinished.
 */
const LINE_ENDING = /\r\n?|\n/u;

/** Exact body emitted by every issue-number-based CLI release. */
export const LEGACY_ISSUE_RESERVATION_BODY =
  "This issue is the control plane for one Lax submission. Keep it open and use `/lax` command comments through the CLI.";

/** Bind a locally generated id to the issue created on first submission. */
export function issueReservationBody(id: string): string {
  validateNewSubmissionId(id);
  return `${PREFIX}${id} -->\n\n${LEGACY_ISSUE_RESERVATION_BODY}`;
}

export function isLegacyIssueReservationBody(body: unknown): boolean {
  return body === LEGACY_ISSUE_RESERVATION_BODY;
}

/** Return undefined for an ordinary issue and reject a malformed Lax marker. */
export function submissionIdFromIssueBody(body: unknown): string | undefined {
  if (typeof body !== "string" || !body.startsWith(PREFIX)) return undefined;
  const firstLine = body.split(LINE_ENDING, 1)[0]!;
  const match = /^<!-- lax-submission-id:(lax-[^ ]+) -->$/u.exec(firstLine);
  if (match === null) {
    throw new ValidationError("submission issue has a malformed reservation marker");
  }
  return validateNewSubmissionId(match[1]!);
}
