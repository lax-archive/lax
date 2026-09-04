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
//   but never referenced): their token runs are removed from the PDF side
//   up to a bounded share of the document, and the deriver reports each as
//   its own warning.
//
// Every one of these normalizations deletes evidence, so each is written to
// err towards a **skip**: the oracle decides whether a derived view is
// sealed and shown beside the author's PDF, and a view that silently drops
// text is worse than no view at all.

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

/** A well-formed roman numeral, upper or lower case, i to mmmmcmxcix — the
 * front matter's folios and nothing else. Letter sets are not enough: `mix`
 * is a numeral, `civil` and `mild` only look like one. */
const ROMAN_NUMERAL = /^m{0,4}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/iu;

/**
 * Folio-like standalone line: a page number *alone* on its line. The line
 * must be one whitespace-free token, because the two mistakes are not
 * symmetric. A folio left in place costs the PDF side one extra token per
 * page, which the similarity floor absorbs. A line wrongly taken for a
 * folio is deleted from the PDF side while the stream still carries it, and
 * that manufactures exactly the divergence the oracle exists to catch — a
 * table of small integers, whose rows read as four digits once the spaces
 * between the columns are collapsed away, would fail a faithful paper.
 */
export function isFolioLine(line: string): boolean {
  const token = line.trim();
  if (token === "" || /\s/u.test(token)) return false;
  return /^[0-9]{1,4}$/u.test(token) || ROMAN_NUMERAL.test(token);
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

/**
 * The share of the PDF's tokens the oracle will forgive as captured but
 * never referenced, the floor under it in absolute tokens, and the ceiling
 * over that floor. `\marginpar` notes are marginalia — a phrase, a sentence,
 * a handful per paper — so five percent is already far above what a paper
 * full of them spends, while the absolute floor keeps a short paper's single
 * note from tipping the whole derivation over on its own arithmetic (the
 * fraction of a 60-token paper is two tokens; one honest margin note is
 * seven).
 *
 * A fixed number of tokens is a different share of every document, though,
 * so the floor needs a ceiling of its own: thirty-two tokens is a twentieth
 * of a real paper, a quarter of a one-page note and half of a stub, and
 * without the ceiling the bound stops being a share of the document at
 * exactly the lengths where a share is cheapest to lose. A fifth is the most
 * the oracle will forgive at any length — well clear of the twelve percent
 * an honest margin note costs a one-page paper, and nowhere near a document
 * a reader would call the same one.
 */
export const UNREFERENCED_BUDGET_FRACTION = 0.05;
export const UNREFERENCED_BUDGET_MINIMUM = 32;
export const UNREFERENCED_BUDGET_CEILING_FRACTION = 0.2;

export interface UnreferencedSubtraction<T> {
  /** The PDF tokens with the forgiven omissions removed. */
  tokens: string[];
  /** The captures the page stream genuinely does not carry, in input order:
   * each is its own warning at the call site. */
  omitted: T[];
  /** Tokens actually taken off the PDF side. */
  removedTokens: number;
  /** The most this document's size allowed. */
  budgetTokens: number;
  /** `removedTokens` over `budgetTokens`: the caller must skip. */
  overBudget: boolean;
}

/**
 * Subtract the captured-but-unreferenced paragraphs from the PDF side —
 * bounded, because the bound is what separates a lossy derivation from a
 * different document.
 *
 * A capture the page stream never references but whose text it carries
 * anyway is a trial typesetting — LaTeX's `\caption` measures every caption
 * in a box first, and classes and theorem packages measure the opening
 * letters of a paragraph the same way ("th", "We") — not an omission: the
 * surface shows that text, and subtracting it would manufacture the
 * divergence the oracle exists to catch. Substring, not token run: the
 * opening letters are a fragment of a word, never a whole token.
 *
 * What is left is text the print PDF shows and the reflow surface will not:
 * `\marginpar` and friends. Removing it lets the rest of the document be
 * compared, which is right for marginalia and wrong past that — subtract
 * enough and the oracle compares a remnant with itself and passes anything.
 * So the removals share one budget over the whole document. Past it the
 * derivation is not a lossy view of the paper, it is a different document,
 * and the caller skips: no bundle is sealed, the PDF stands untouched, and
 * the author's report names every dropped paragraph plus the overrun. The
 * trade-off is deliberate — a paper whose reflow view really does lose more
 * than a twentieth of its words (a fifth, where the paper is too short for a
 * twentieth to hold one margin note) loses the web view rather than showing
 * readers a text the PDF beside it does not contain.
 *
 * A run the PDF side does not carry contiguously spends no budget: nothing
 * was removed, so the similarity floor still sees the whole divergence.
 */
export function subtractUnreferenced<T extends { text: string }>(
  pdfTokens: readonly string[],
  streamTokens: readonly string[],
  unreferenced: readonly T[],
): UnreferencedSubtraction<T> {
  // A share of the document, floored so a short paper's one honest margin
  // note is not measured against a fraction that rounds to nothing, and
  // capped so that floor never becomes a licence to drop a fifth of a short
  // paper: under 160 tokens the ceiling binds, over 640 the fraction does,
  // and the floor holds the middle.
  const budgetTokens = Math.min(
    Math.max(UNREFERENCED_BUDGET_MINIMUM, Math.floor(UNREFERENCED_BUDGET_FRACTION * pdfTokens.length)),
    Math.floor(UNREFERENCED_BUDGET_CEILING_FRACTION * pdfTokens.length),
  );
  const streamJoined = ` ${streamTokens.join(" ")} `;
  let tokens = [...pdfTokens];
  const omitted: T[] = [];
  let removedTokens = 0;
  for (const paragraph of unreferenced) {
    const run = oracleTokens(paragraph.text);
    if (run.length === 0) continue; // marker-only capture (the hoist's leftover)
    if (streamJoined.includes(` ${run.join(" ")}`)) continue;
    omitted.push(paragraph);
    const removal = removeTokenRun(tokens, run);
    if (!removal.removed) continue;
    tokens = removal.tokens;
    removedTokens += run.length;
  }
  return { tokens, omitted, removedTokens, budgetTokens, overBudget: removedTokens > budgetTokens };
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
