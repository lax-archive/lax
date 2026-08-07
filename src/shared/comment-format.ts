// How the control plane renders untrusted text into an issue comment. Issue
// comments are short outcome records now — a failing build's transcript
// travels to the author through the validation report artifact, not through
// markdown — so what remains here is the sanitizing every remaining comment
// still needs, plus the transcript shaping the pipeline uses for the findings
// it writes into that report.
//
// Everything here treats its input as hostile: control characters are removed
// and inline text keeps the mention-defusing zero-width space, because a
// finding's message is whatever the submission made Lean print.

/** Control characters, keeping nothing: inline text is a single line. */
const INLINE_CONTROL = /[\u0000-\u001f\u007f]/gu;
/** Control characters except LF and TAB, which a transcript needs. */
const BLOCK_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

/**
 * One line of untrusted text, safe to interpolate into markdown prose:
 * no control characters, no mentions, no inline HTML.
 */
export function safeInline(value: string, limit: number): string {
  return value
    .replace(INLINE_CONTROL, " ")
    .replace(/@/gu, "@\u200b")
    .replace(/[<>]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
}

/**
 * Untrusted multi-line text with its line structure intact: LF endings, no
 * control characters beyond tab and newline, and no more than `limit`
 * characters — the last ones, per `tail`. This is what a validation finding
 * carries from the pipeline through the report to the author.
 */
export function safeTranscript(value: string, limit: number): string {
  return tail(
    value
      .replace(/\r\n?/gu, "\n")
      .replace(BLOCK_CONTROL, " ")
      .replace(/\n{3,}/gu, "\n\n")
      .trim(),
    limit,
  );
}

/**
 * Keep the *end* of an over-long transcript: `lake build` announces every
 * module it builds and only then says what went wrong, so the head is the
 * part with no information in it.
 */
export function tail(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const kept = value.slice(value.length - limit);
  const newline = kept.indexOf("\n");
  const fromLineStart = newline === -1 ? kept : kept.slice(newline + 1);
  return `[…earlier output omitted…]\n${fromLineStart.length > 0 ? fromLineStart : kept}`;
}
