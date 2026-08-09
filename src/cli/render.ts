// The control plane speaks markdown, because its primary reader is the GitHub
// issue. The CLI's reader is a terminal, and dumping a comment body into one
// prints correlation markers, bold asterisks, and a workflow-run link the CLI
// already printed itself. This module is the translation: comment in, plain
// terminal text out.
//
// The content is untrusted — a compile transcript is whatever the submission
// made Lean print — so nothing here can reach the terminal as an escape
// sequence: control characters and the invisible formatting characters that
// hide or reverse text are removed before anything is written.

import { visibleComment } from "../shared/workflow-comments.js";

/** Control characters (ESC included) and tab, which would misalign blocks. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/gu;
/** Invisible or direction-changing characters: no text may hide behind them. */
const INVISIBLE = /[\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/gu;
/** The same as CONTROL, keeping LF: a compile transcript is its lines. */
const BLOCK_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/gu;

/**
 * Untrusted multi-line text on its way to the terminal: no escape sequences,
 * nothing invisible, line structure intact, bounded. The validation report the
 * CLI downloads carries exactly the text the comment path used to carry, so it
 * gets exactly the same treatment.
 */
export function sanitizeTerminalText(value: string, limit: number): string {
  const text = value
    .replace(/\r\n?/gu, "\n")
    .replace(BLOCK_CONTROL, " ")
    .replace(INVISIBLE, "");
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/**
 * Render one control-plane comment as terminal text: hidden markers and the
 * workflow-run link removed, emphasis and code spans unwrapped, fenced blocks
 * (the compile transcripts) kept verbatim and indented.
 */
export function renderComment(body: string): string {
  const output: string[] = [];
  let fence: string | undefined;
  for (const line of visibleComment(body).split("\n")) {
    const safe = sanitize(line);
    const fenceAt = /^ {0,3}(`{3,}|~{3,})\s*(\S*)\s*$/u.exec(safe);
    if (fence !== undefined) {
      if (fenceAt !== null && fenceAt[1]!.startsWith(fence[0]!) && fenceAt[1]!.length >= fence.length) {
        fence = undefined;
      } else {
        output.push(`    ${safe}`);
      }
      continue;
    }
    if (fenceAt !== null) {
      fence = fenceAt[1]!;
      continue;
    }
    // The run is announced once by the CLI, with a URL a terminal can open.
    if (/^\s*Workflow run:/u.test(safe)) continue;
    output.push(inline(safe));
  }
  return collapseBlanks(output).join("\n");
}

/** Strip markdown that only makes sense rendered. */
function inline(line: string): string {
  return line
    .replace(/^(\s*)[-*] /u, "$1- ")
    .replace(/\*\*(.+?)\*\*/gu, "$1")
    .replace(/^(\s*)_(.+)_(\s*)$/u, "$1$2$3")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gu, "$1 ($2)")
    .trimEnd();
}

function sanitize(line: string): string {
  return line.replace(CONTROL, " ").replace(INVISIBLE, "").trimEnd();
}

function collapseBlanks(lines: string[]): string[] {
  const output: string[] = [];
  for (const line of lines) {
    if (line.trim() === "" && (output.length === 0 || output[output.length - 1] === "")) continue;
    output.push(line.trim() === "" ? "" : line);
  }
  while (output.length > 0 && output[output.length - 1] === "") output.pop();
  return output;
}
