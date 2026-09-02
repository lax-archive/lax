// The web derivation's oracle (paper-web-plan.md, "The oracle"): the
// compiled PDF's text layer and the serialized stream's glyph text must
// agree as token sequences within a tolerance, or the web view is skipped
// with the first divergence location. This converts reflow's silent misread
// class (a dropped section, a wrong linearization) into loud, attributable
// skips. Pure — no I/O; the deriver (web.ts) feeds it.
//
// The normalizations are specified, not hand-waved:
// - hyphenation: the stream holds unbroken paragraphs; the PDF has applied
//   hyphens at line ends — lines ending in `-` join with a lowercase
//   continuation;
// - ligatures and math alphabets: NFKC decomposes U+FB00… ligature
//   codepoints (present in the stream's glyph chars and occasionally in a
//   PDF's toUnicode) and folds mathematical alphanumerics to base letters;
// - accents: NFD + mark stripping equalizes composed PDF text with the
//   stream's base letters (legacy accent glyphs decode to bases);
// - furniture, PDF side only: folio-like standalone lines and running-head
//   lines repeated across pages are stripped;
// - casing and punctuation (`\MakeUppercase`, class-specific heading dots):
//   tokens are lowercased alphanumeric runs, so casing and punctuation
//   never count as divergence;
// - unreferenced glyph-bearing paragraphs (`\marginpar` text is captured
//   but never referenced): their token runs are removed from the PDF side,
//   and the deriver reports each as its own warning.

import type { ExtractedTextItem } from "./extract-destinations.js";

/**
 * Normalize a text into comparison tokens: NFKC (ligatures, math
 * alphanumerics), lowercase, NFD with combining marks stripped, then every
 * maximal letter/digit run. Symbols and punctuation never form tokens, so
 * spacing and delimiter differences between the two substrates are inert.
 */
export function oracleTokens(text: string): string[] {
  const folded = text.normalize("NFKC").toLowerCase().normalize("NFD").replace(/\p{M}+/gu, "");
  return folded.match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** A page's text items grouped into lines: pdf.js marks line ends with
 * `hasEOL`; the last group closes at the page end. */
export function pdfLines(page: ExtractedTextItem[]): string[] {
  const lines: string[] = [];
  let current = "";
  for (const [text, eol] of page) {
    current += text;
    if (eol === 1) {
      lines.push(current);
      current = "";
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

/** Folio-like standalone line: a bare arabic or roman page number. */
export function isFolioLine(line: string): boolean {
  const collapsed = line.replace(/\s+/gu, "");
  return /^[0-9]{1,4}$/u.test(collapsed) || /^[ivxlcdm]{1,8}$/iu.test(collapsed);
}

/** The identity of a candidate running-head line: its collapsed text with
 * digits removed, so `AUTHOR 4` and `AUTHOR 5` count as the same head. */
function headKey(line: string): string {
  return line.replace(/[0-9]/gu, "").replace(/\s+/gu, " ").trim().toLowerCase();
}

export interface AssembledPdfText {
  text: string;
  /** How many folio-like lines were stripped. */
  folioLines: number;
  /** How many repeated running-head lines were stripped. */
  headerLines: number;
}

/**
 * The PDF side of the comparison: group each page's items into lines, strip
 * folio lines everywhere and running heads (a page's first non-folio line
 * whose digit-stripped text recurs as a first line on other pages), join
 * hyphen-broken lines, and concatenate.
 */
export function assemblePdfText(pages: ExtractedTextItem[][]): AssembledPdfText {
  const pageLines = pages.map((page) => pdfLines(page));
  // Running heads repeat across pages; a heading happens once.
  const firstLineCounts = new Map<string, number>();
  for (const lines of pageLines) {
    const first = lines.find((line) => !isFolioLine(line) && line.trim() !== "");
    if (first === undefined) continue;
    const key = headKey(first);
    if (key === "") continue;
    firstLineCounts.set(key, (firstLineCounts.get(key) ?? 0) + 1);
  }
  let folioLines = 0;
  let headerLines = 0;
  const kept: string[] = [];
  for (const lines of pageLines) {
    let sawFirst = false;
    for (const line of lines) {
      if (line.trim() === "") continue;
      if (isFolioLine(line)) {
        folioLines += 1;
        continue;
      }
      if (!sawFirst) {
        sawFirst = true;
        if ((firstLineCounts.get(headKey(line)) ?? 0) >= 2) {
          headerLines += 1;
          continue;
        }
      }
      kept.push(line);
    }
  }
  // Hyphenation joining, across page boundaries too: a line ending in `-`
  // whose continuation starts lowercase is one word the stream never broke.
  const joined: string[] = [];
  for (const line of kept) {
    const previous = joined[joined.length - 1];
    if (previous !== undefined && /-\s*$/u.test(previous) && /^\s*\p{Ll}/u.test(line)) {
      joined[joined.length - 1] = previous.replace(/-\s*$/u, "") + line.replace(/^\s+/u, "");
    } else {
      joined.push(line);
    }
  }
  return { text: joined.join("\n"), folioLines, headerLines };
}

/**
 * Remove the first contiguous occurrence of `run` from `tokens`. Unmatched
 * runs are left alone — the similarity floor absorbs or reports them.
 */
export function removeTokenRun(tokens: string[], run: string[]): { tokens: string[]; removed: boolean } {
  if (run.length === 0 || run.length > tokens.length) return { tokens, removed: false };
  for (let start = 0; start + run.length <= tokens.length; start += 1) {
    let matches = true;
    for (let index = 0; index < run.length; index += 1) {
      if (tokens[start + index] !== run[index]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return { tokens: [...tokens.slice(0, start), ...tokens.slice(start + run.length)], removed: true };
    }
  }
  return { tokens, removed: false };
}

export interface TokenComparison {
  /** LCS length over the larger sequence length; 1 for two empty sequences. */
  similarity: number;
  /** Where the sequences first differ, when they do: the common-prefix
   * length plus a window of both sides there. */
  divergence?: { index: number; pdf: string; stream: string };
}

/**
 * Token-sequence agreement via Myers' O(ND) diff: similarity is
 * `1 - D/(len(a)+len(b))` = `2·LCS/(len(a)+len(b))`, and the search stops
 * as soon as D proves the pair is under `floor` — the oracle never pays
 * quadratic time for a document that will be skipped anyway.
 */
export function compareTokens(pdf: string[], stream: string[], floor: number): TokenComparison {
  const total = pdf.length + stream.length;
  if (total === 0) return { similarity: 1 };
  const budget = Math.max(0, Math.floor((1 - floor) * total)) + 1;
  const distance = myersDistance(pdf, stream, budget);
  const similarity = distance === undefined ? Math.max(0, 1 - (budget + 1) / total) : 1 - distance / total;
  if (distance !== undefined && similarity >= floor) return { similarity };
  // First divergence: the end of the common prefix.
  let index = 0;
  while (index < pdf.length && index < stream.length && pdf[index] === stream[index]) index += 1;
  const window = (tokens: string[]): string => {
    const slice = tokens.slice(Math.max(0, index - 3), index + 7);
    return slice.length === 0 ? "(end of text)" : slice.join(" ");
  };
  return { similarity, divergence: { index, pdf: window(pdf), stream: window(stream) } };
}

/** Myers edit distance, bounded: undefined when it exceeds `maxDistance`. */
function myersDistance(a: string[], b: string[], maxDistance: number): number | undefined {
  const n = a.length;
  const m = b.length;
  const bound = Math.min(maxDistance, n + m);
  const offset = bound;
  const v = new Int32Array(2 * bound + 1);
  for (let d = 0; d <= bound; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return d;
    }
  }
  return undefined;
}
