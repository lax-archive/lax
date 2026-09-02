// The marker rewriter of the paper layer (paper-plan.md, "Rewrite"): pure
// text transformation, no I/O. Authors mark passages of their `.tex` with
// bare comment lines,
//
//     % lax begin Lax261.Treewidth
//     ...
//     % lax end
//
// which their own build ignores. Here every marker comment — from the
// unescaped `%` to the end of the line — becomes `\laxmark{b}{<n>}%` or
// `\laxmark{e}{<n>}%`: the trailing `%` eats the rest of the line and the
// newline exactly as the original comment did, so the token stream TeX sees
// is unchanged apart from one robust, zero-size whatsit that the injected
// `laxmark.sty` turns into a PDF named destination carrying only the number.
// Ids never enter the PDF; the mark table maps numbers back to them.

import { PLACEHOLDER_SUBMISSION_ID, SUBMISSION_ID_PATTERN } from "../../shared/constants.js";
import {
  LEAN_NAME_PATTERN,
  submissionIdForPackage,
  type PaperMarkKind,
  type PaperMarkTableEntry,
} from "../contracts.js";

/** A `.tex` text to rewrite, keyed by its path relative to `paper.folder`. */
export interface TexFile {
  path: string;
  text: string;
}

export interface RewriteResult {
  /** The rewritten texts, in the order the files were handed in. */
  rewritten: TexFile[];
  /** Mark numbers in file-then-line order; ids are checked for shape only. */
  marks: PaperMarkTableEntry[];
  /** Grammar, nesting, and id-shape violations, each naming `file:line`. */
  problems: string[];
}

/**
 * Rewrite every marker of the given files, numbering marks in the order the
 * files are handed in (main first, then the rest sorted — the caller's job)
 * and by line within a file. CRLF is normalized first. A file's markers must
 * balance within that file: an `\input`-ed file cannot close what its parent
 * opened, because TeX never sees the two as one text.
 */
export function rewriteMarkers(files: readonly TexFile[]): RewriteResult {
  const rewritten: TexFile[] = [];
  const marks: PaperMarkTableEntry[] = [];
  const problems: string[] = [];
  for (const file of files) {
    const lines = file.text.replace(/\r\n?/gu, "\n").split("\n");
    const stack: Array<{ n: number; id: string; line: number }> = [];
    const out = lines.map((line, index) => {
      const where = `${file.path}:${index + 1}`;
      const at = firstCommentIndex(line);
      if (at < 0) return line;
      const marker = parseMarker(line.slice(at + 1));
      if (marker === undefined) return line;
      if (marker.error !== undefined) {
        problems.push(`${where}: ${marker.error}`);
        return line;
      }
      if (marker.keyword === "begin") {
        const shape = markIdProblem(marker.id!);
        if (shape !== undefined) {
          problems.push(`${where}: ${shape}`);
          return line;
        }
        const n = marks.length + 1;
        marks.push({ n, id: marker.id!, file: file.path, line: index + 1 });
        stack.push({ n, id: marker.id!, line: index + 1 });
        return `${line.slice(0, at)}\\laxmark{b}{${n}}%`;
      }
      const open = stack.pop();
      if (open === undefined) {
        problems.push(`${where}: \`lax end\` with no open marker`);
        return line;
      }
      if (marker.id !== undefined && marker.id !== open.id) {
        problems.push(
          `${where}: \`lax end ${marker.id}\` does not match the innermost open marker ` +
            `${open.id} (${file.path}:${open.line})`,
        );
      }
      return `${line.slice(0, at)}\\laxmark{e}{${open.n}}%`;
    });
    for (const open of stack) {
      problems.push(`${file.path}:${open.line}: marker ${open.id} is never closed in this file`);
    }
    rewritten.push({ path: file.path, text: out.join("\n") });
  }
  return { rewritten, marks, problems };
}

/**
 * Index of the first unescaped `%` — one preceded by an even number of
 * backslashes — or -1. `\%` is a literal percent sign; `\\%` is a line break
 * followed by a comment.
 */
export function firstCommentIndex(line: string): number {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== "%") continue;
    let backslashes = 0;
    for (let back = index - 1; back >= 0 && line[back] === "\\"; back -= 1) backslashes += 1;
    if (backslashes % 2 === 0) return index;
  }
  return -1;
}

export interface ParsedMarker {
  keyword: "begin" | "end";
  id?: string;
  error?: string;
}

/**
 * Parse a comment body (the text after `%`). `undefined` when the comment is
 * not addressed to lax at all. A comment that starts with `lax` but is not a
 * well-formed marker is an error rather than a comment: a typo in a keyword
 * must not silently drop a passage.
 */
export function parseMarker(body: string): ParsedMarker | undefined {
  const head = /^[ \t]*lax(?![\p{L}\p{N}_])/u.exec(body);
  if (head === null) return undefined;
  const rest = body.slice(head[0].length);
  const keyword = /^[ \t]+(begin|end)(?![\p{L}\p{N}_])/u.exec(rest);
  if (keyword === null) {
    return { keyword: "begin", error: "a `% lax` comment must be `% lax begin <id>` or `% lax end`" };
  }
  const afterKeyword = rest.slice(keyword[0].length);
  const token = /^[ \t]+(\S+)/u.exec(afterKeyword);
  const id = token?.[1];
  if (keyword[1] === "begin") {
    if (id === undefined) return { keyword: "begin", error: "`lax begin` needs an id" };
    return { keyword: "begin", id };
  }
  return id === undefined ? { keyword: "end" } : { keyword: "end", id };
}

const MARK_ID_SHAPES =
  "a mark id is a concept id like Lax261.Treewidth, a proof id like Lax261Proofs.Q, or a submission id like lax-261";

/**
 * Whether an id can name a card at all, decided from its spelling: a
 * submission id (`lax-261`), or a Lax package component followed by at
 * least one more — `Lax261.Treewidth` (a concept) or `Lax261Proofs.Q` (a
 * proof). A package root, a mathlib declaration, or anything that is
 * neither a submission id nor a Lean name has no card. The offline
 * placeholders `lax-0`/`Lax0`/`Lax0Proofs` are legal spellings: they are
 * the submission's own id and packages until it is renumbered.
 */
export function markIdProblem(id: string): string | undefined {
  if (isSubmissionMarkId(id)) return undefined;
  if (!LEAN_NAME_PATTERN.test(id)) return `\`${id}\` is neither a Lean name nor a submission id; ${MARK_ID_SHAPES}`;
  const dot = id.indexOf(".");
  if (dot < 0) {
    const submission = submissionIdForPackage(id) ?? (/^Lax0(?:Proofs)?$/u.test(id) ? PLACEHOLDER_SUBMISSION_ID : undefined);
    return submission === undefined
      ? `\`${id}\` is a package name, not a concept or proof id; mark Lax261.Treewidth, not Lax261`
      : `\`${id}\` is a package name, not a concept or proof id; mark ${id}.Treewidth for a concept, or ${submission} for the whole submission`;
  }
  const packageName = id.slice(0, dot);
  if (submissionIdForPackage(packageName) === undefined && !/^Lax0(?:Proofs)?$/u.test(packageName)) {
    return `\`${id}\` does not belong to a Lax package; ${MARK_ID_SHAPES}`;
  }
  return undefined;
}

/** Whether an id is spelled as a submission id (`lax-261`, or the offline
 * placeholder `lax-0`). */
export function isSubmissionMarkId(id: string): boolean {
  return SUBMISSION_ID_PATTERN.test(id) || id === PLACEHOLDER_SUBMISSION_ID;
}

/** The card kind an id's spelling announces. */
export function markIdKind(id: string): PaperMarkKind {
  if (isSubmissionMarkId(id)) return "submission";
  const packageName = id.slice(0, id.indexOf("."));
  return packageName.endsWith("Proofs") ? "proof" : "concept";
}

/** The package component of a concept or proof mark id (`Lax261` of
 * `Lax261.Treewidth`). Not for submission ids, which name no package. */
export function markIdPackage(id: string): string {
  return id.slice(0, id.indexOf("."));
}

/** `.tex` files in rewrite order: the entry file first, the rest sorted by
 * their POSIX path so numbering is independent of directory listing order. */
export function texRewriteOrder(main: string, files: readonly string[]): string[] {
  const tex = files.filter((file) => file.endsWith(".tex") && file !== main).sort();
  return [main, ...tex];
}
