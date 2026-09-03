import { validateNewSubmissionId, ValidationError } from "./validation.js";

const PREFIX = "<!-- lax-submission-id:";
export const LEGACY_ISSUE_RESERVATION_BODY =
  "This issue is the control plane for one Lax submission. Keep it open and use `/lax` command comments through the CLI.";

export function issueReservationBody(id: string): string {
  validateNewSubmissionId(id);
  return (
    `${PREFIX}${id} -->\n\n` +
    LEGACY_ISSUE_RESERVATION_BODY
  );
}

export function isLegacyIssueReservationBody(body: unknown): boolean {
  return body === LEGACY_ISSUE_RESERVATION_BODY;
}

/** Return undefined for an ordinary issue and reject a malformed Lax reservation marker. */
export function submissionIdFromIssueBody(body: unknown): string | undefined {
  if (typeof body !== "string" || !body.startsWith(PREFIX)) return undefined;
  const firstLine = body.split("\n", 1)[0]!;
  const match = /^<!-- lax-submission-id:(lax-[^ ]+) -->$/u.exec(firstLine);
  if (match === null) {
    throw new ValidationError("submission issue has a malformed reservation marker");
  }
  return validateNewSubmissionId(match[1]!);
}
