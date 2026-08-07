// How the control plane renders untrusted validation output into an issue
// comment. A failing build's real diagnostic is a Lean transcript: multi-line,
// full of the characters markdown reacts to, and worth thousands of bytes. The
// old archive server handed the author that transcript's tail verbatim; these
// helpers do the same through GitHub, so `lax submit` can print a compiler
// error instead of a one-line summary of one.
//
// Everything here treats its input as hostile: control characters are removed,
// fenced blocks are opened with a fence longer than any backtick run inside
// them (so nothing can escape into markdown), and inline text keeps the
// mention-defusing zero-width space. Budgets are per finding and overall — a
// GitHub comment holds 65,536 characters and the caller adds prose around us.

import type { ValidationFinding } from "../submission-validation/contracts.js";

/** Total characters the findings section of one comment may occupy. */
const SECTION_BUDGET = 40_000;
/** Characters one finding's message may occupy. */
const MESSAGE_BUDGET = 12_000;
/**
 * Findings listed before the rest are summarized as a count. Static
 * validation reports one per bad manifest field, so this is generous; the
 * character budget above is the real bound.
 */
const MAX_FINDINGS = 50;

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
 * Untrusted multi-line text as a fenced block. Line structure and the
 * characters Lean prints are preserved — inside a fence GitHub renders text
 * literally and does not linkify mentions — but only because the fence itself
 * cannot be broken from within: it is always one backtick longer than the
 * longest run in the content.
 */
export function codeBlock(value: string, limit: number): string {
  const body = safeTranscript(value, limit);
  let longest = 0;
  for (const run of body.match(/`+/gu) ?? []) longest = Math.max(longest, run.length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${body}\n${fence}`;
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

/**
 * Render validation findings for an issue comment. Single-line findings stay
 * bullets; anything multi-line (compile transcripts, kernel replay output,
 * inspector failures) keeps its shape in a fenced block.
 */
export function findingsMarkdown(findings: readonly ValidationFinding[], fallback: string): string {
  if (findings.length === 0) return `- ${fallback}`;
  const sections: string[] = [];
  let budget = SECTION_BUDGET;
  let rendered = 0;
  for (const finding of findings.slice(0, MAX_FINDINGS)) {
    const section = findingMarkdown(finding, Math.min(MESSAGE_BUDGET, budget));
    if (section.length > budget && rendered > 0) break;
    sections.push(section);
    budget -= section.length;
    rendered += 1;
  }
  const omitted = findings.length - rendered;
  if (omitted > 0) {
    sections.push(
      `_${omitted} further finding${omitted === 1 ? "" : "s"} omitted; ` +
        "the workflow run has the complete report._",
    );
  }
  return sections.join("\n\n");
}

function findingMarkdown(finding: ValidationFinding, budget: number): string {
  const phase = safeInline(String(finding.phase ?? "validation"), 40) || "validation";
  const rule = safeInline(String(finding.rule ?? "unspecified"), 60) || "unspecified";
  const raw = String(finding.message ?? "unspecified failure");
  const heading = `**${phase}** (\`${rule}\`)`;
  return /[\r\n]/u.test(raw.trim())
    ? `${heading}\n\n${codeBlock(raw, budget)}`
    : `- ${heading}: ${safeInline(raw, Math.min(budget, 1_000))}`;
}
