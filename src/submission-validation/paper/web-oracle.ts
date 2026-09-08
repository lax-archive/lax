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
// - furniture, PDF side only: folio-like standalone lines, running-head
//   lines repeated across pages, and margin line numbers (`lineno`'s, which
//   sit outside the text column and which pdf.js glues onto the neighbouring
//   word) are stripped;
// - margin text, PDF side only: a `\marginpar` note sits beside the column
//   and pdf.js splices its lines into the body lines they share a baseline
//   with, while the stream carries the note as a paragraph of its own in
//   reading order — both substrates show it, in different places. Items in
//   a narrow ink interval a clear gutter away from the text column are taken
//   off their lines and settled as runs the way relocated footnotes are:
//   removed from the stream side when it carries them, put back on the PDF
//   side when it does not, so only order evidence is given up;
// - casing and punctuation (`\MakeUppercase`, class-specific heading dots):
//   tokens are lowercased alphanumeric runs, so casing and punctuation
//   never count as divergence;
// - token boundaries: pdf.js splits a token at every wide glyph advance and
//   the stream's linearizer only at glue, so a divergence whose two sides
//   spell the same characters is folded to one token on each side;
// - look-alike codepoints: pdf.js reads a math font's capital Delta as
//   U+2206 INCREMENT (a symbol, no token) where the stream carries U+0394
//   (a letter); the one is folded to the other;
// - relocated paragraphs (footnotes: the stream carries them as endnotes,
//   the PDF at page bottoms): each is matched against the PDF side on its
//   characters, token boundaries aside, and taken off it when found; one
//   the PDF lacks is appended to the stream side, so it still counts as
//   divergence;
// - unreferenced glyph-bearing paragraphs (`\marginpar` text is captured
//   but never referenced): their token runs are removed from the PDF side
//   up to a bounded share of the document, and the deriver reports each as
//   its own warning.
//
// Every one of these normalizations deletes evidence, so each is written to
// err towards a **skip**: the oracle decides whether a derived view is
// sealed and shown beside the author's PDF, and a view that silently drops
// text is worse than no view at all. The whole verdict is one function,
// `judgeWebOracle`, so the deriver and the reflow lab's recompute run the
// same code rather than each other's restatement.

import type { ExtractedTextItem } from "./extract-destinations.js";

/**
 * Normalize a text into comparison tokens: NFKC (ligatures, math
 * alphanumerics), lowercase, NFD with combining marks stripped, then every
 * maximal letter/digit run. Symbols and punctuation never form tokens, so
 * spacing and delimiter differences between the two substrates are inert.
 */
export function oracleTokens(text: string): string[] {
  // pdf.js reads a legacy math font's capital Delta as U+2206 INCREMENT, a
  // symbol the letter/digit classification below drops, while the stream
  // carries the glyph as U+0394 GREEK CAPITAL LETTER DELTA, a letter that
  // survives it — one token on the stream side and none on the PDF's at
  // every `\Delta`. Folded before NFKC, which leaves U+2206 alone. The two
  // look-alikes NFKC does fold, U+2126 OHM SIGN (to omega) and U+00B5 MICRO
  // SIGN (to mu), are letters already and need nothing here.
  const folded = text
    .replace(/\u2206/gu, "\u0394")
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "");
  return folded.match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** A page's text items grouped into lines: pdf.js marks line ends with
 * `hasEOL`; the last group closes at the page end. */
export function pdfLineItems(page: ExtractedTextItem[]): ExtractedTextItem[][] {
  const lines: ExtractedTextItem[][] = [];
  let current: ExtractedTextItem[] = [];
  for (const item of page) {
    current.push(item);
    if (item[1] === 1) {
      lines.push(current);
      current = [];
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/** The text of a line's items, joined as pdf.js placed them. */
export function lineText(items: readonly ExtractedTextItem[]): string {
  return items.map((item) => item[0]).join("");
}

/** A page's lines as strings — `pdfLineItems` joined. */
export function pdfLines(page: ExtractedTextItem[]): string[] {
  return pdfLineItems(page).map(lineText);
}

/** A digits-only text item — the shape of a line number. */
const DIGITS_ONLY = /^[0-9]{1,4}$/u;

/**
 * How far outside the page's text column, in points, a digits-only item
 * has to sit before it is a margin line number. `lineno` puts its numbers
 * `\linenumbersep` (10pt) beyond the column edge; a section number sits on
 * the edge, and a superscript, a table cell, an equation number inside it.
 */
export const MARGIN_NUMBER_TOLERANCE = 2;

type PlacedTextItem = [string, 0 | 1, number, number, number];

function placed(item: ExtractedTextItem): item is PlacedTextItem {
  return item.length === 5 && typeof item[2] === "number" && typeof item[4] === "number";
}

/**
 * Strip margin line numbers from a page's lines. Papers compiled with
 * `lineno` (every LIPIcs submission version) carry their line numbers in
 * the text layer; pdf.js emits each as an item on the line's own baseline,
 * after the line's text, so the plain join reads `width1` and `bounded5` —
 * a divergence the stream, which drops margin decorations, never shows.
 * The rule is geometric: a digits-only item is a line number when it lies
 * wholly outside the page's text column — the horizontal extent of every
 * other non-blank, non-numeric item on the page, running heads excluded —
 * by more than the tolerance. Being outside the column puts it left of its
 * line's first text item or right of its last by construction, on the
 * baseline pdf.js grouped it with. Items without geometry are never
 * stripped: a bare `[str, eol]` page compares as it always did.
 *
 * The mistake to avoid is the folio rule's: a number deleted from the PDF
 * side while the stream still carries it manufactures a divergence. The
 * column is measured per page and from text items only, so a page whose
 * text is one centred caption still measures its own column, and a number
 * on the column's edge — a heading's, a list label's — is inside it. What
 * the rule does give up: a table wider than the column whose outermost
 * cells are bare numbers loses those cells on the PDF side, and the paper
 * pays for them in the similarity — the skip direction, never the seal.
 */
export function stripMarginNumbers(
  lines: readonly (readonly ExtractedTextItem[])[],
  isFurniture: (lineIndex: number) => boolean,
): { lines: ExtractedTextItem[][]; stripped: number } {
  const isNumber = (item: ExtractedTextItem): boolean => DIGITS_ONLY.test(item[0].trim());
  const isText = (item: ExtractedTextItem): boolean => item[0].trim() !== "" && !isNumber(item);
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  lines.forEach((line, index) => {
    if (isFurniture(index)) return;
    for (const item of line) {
      if (!isText(item) || !placed(item)) continue;
      left = Math.min(left, item[2]);
      right = Math.max(right, item[2] + item[4]);
    }
  });
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return { lines: lines.map((line) => [...line]), stripped: 0 };
  }
  const inMargin = (item: PlacedTextItem): boolean =>
    item[2] + item[4] < left - MARGIN_NUMBER_TOLERANCE || item[2] > right + MARGIN_NUMBER_TOLERANCE;
  let stripped = 0;
  const kept = lines.map((line) => {
    const taken = takeFromLine(line, (item) => placed(item) && isNumber(item) && inMargin(item));
    stripped += taken.taken.length;
    return taken.kept;
  });
  return { lines: kept, stripped };
}

/**
 * Split a line's items into the ones `take` selects and the rest. The line
 * end travels with the last item; a taken one hands it on to the item
 * before it, or to an empty item when nothing is left, so a line never
 * loses its break.
 */
function takeFromLine(
  line: readonly ExtractedTextItem[],
  take: (item: ExtractedTextItem) => boolean,
): { kept: ExtractedTextItem[]; taken: ExtractedTextItem[] } {
  const kept: ExtractedTextItem[] = [];
  const taken: ExtractedTextItem[] = [];
  for (const item of line) {
    if (!take(item)) {
      kept.push(item);
      continue;
    }
    taken.push(item);
    if (item[1] === 1) {
      const previous = kept.pop();
      const carrier: ExtractedTextItem = previous === undefined ? ["", 1] : ([...previous] as ExtractedTextItem);
      carrier[1] = 1;
      kept.push(carrier);
    }
  }
  return { kept, taken };
}

/**
 * The least clear space, in points, that has to separate a margin item
 * from the text column on *every* line of the page before it is margin
 * text. `\marginparsep` is 11pt in article and 7pt in book, `\columnsep`
 * and `\linenumbersep` 10pt; a justified line's word space stretches to
 * 5pt at 10pt before TeX calls the line underfull, and one line's wide
 * space is covered by the lines above and below it anyway.
 */
export const MARGIN_TEXT_GUTTER = 6;

/**
 * How wide, as a share of the text column, an ink interval beside it may
 * be and still be a margin. `\marginparwidth` is a fifth to a third of
 * `\textwidth` in the standard classes; the other column of a two-column
 * page is as wide as the first and is never margin.
 */
export const MARGIN_TEXT_WIDTH_FRACTION = 0.5;

/**
 * Take margin text off a page's lines. A `\marginpar` note is set beside
 * the column, and pdf.js emits each of its lines as items on the baseline
 * of the body line it shares, after that line's text — the plain join reads
 * `The text continues A marginal note that only print shows` — while the
 * stream carries the note as one paragraph in reading order, after the
 * paragraph it hangs off. Both substrates show the text; an ordered
 * comparison charges the note twice its length for the difference in place.
 *
 * The rule is geometric, like the margin-number rule, but it cannot measure
 * the column from "every other item" when any item may be the candidate.
 * Instead the page's ink is projected onto the horizontal axis: the extents
 * of its non-blank items, running heads excluded, merged wherever two are
 * closer than the gutter. The widest interval is the text column (the most
 * items, on a tie); every other interval narrower than half the column is
 * a margin, and its items leave their lines. Items in an interval as wide
 * as the column — the second column of a two-column page — stay where they
 * are. A gutter has to be clear on every line of the page, so one line's
 * stretched word space or a table's `\tabcolsep` never opens one; only a
 * space the whole page keeps does.
 *
 * The runs come back as text: the fragments of one margin interval on
 * consecutive lines are one note, joined with the body's hyphenation rule
 * (a note whose word breaks at its own line end is still one word). Two
 * notes on adjacent lines become one run and go unmatched — the skip
 * direction, and what an undeclared move costs today.
 *
 * What the rule gives up is order evidence, never presence: the caller
 * settles each run against the stream (`settleRuns`), removing it there
 * when the stream carries it and restoring it to the PDF side when the
 * stream does not, so text one substrate lacks is still counted. A body
 * item mistaken for margin text (a table wider than the column, a short
 * second column) therefore costs the paper nothing it should be measuring;
 * a note the rule misses is the divergence it always was. Items without
 * geometry are never touched.
 */
export function extractMarginText(
  lines: readonly (readonly ExtractedTextItem[])[],
  isFurniture: (lineIndex: number) => boolean,
): { lines: ExtractedTextItem[][]; runs: string[]; items: number } {
  const isInk = (item: ExtractedTextItem): item is PlacedTextItem => placed(item) && item[0].trim() !== "";
  // The page's ink intervals, merged across the gutter.
  const extents: Array<[number, number]> = [];
  lines.forEach((line, index) => {
    if (isFurniture(index)) return;
    for (const item of line) if (isInk(item)) extents.push([item[2], item[2] + item[4]]);
  });
  extents.sort((a, b) => a[0] - b[0]);
  const intervals: Array<{ left: number; right: number; items: number }> = [];
  for (const [left, right] of extents) {
    const last = intervals[intervals.length - 1];
    if (last !== undefined && left < last.right + MARGIN_TEXT_GUTTER) {
      last.right = Math.max(last.right, right);
      last.items += 1;
    } else {
      intervals.push({ left, right, items: 1 });
    }
  }
  if (intervals.length < 2) return { lines: lines.map((line) => [...line]), runs: [], items: 0 };
  const width = (interval: { left: number; right: number }): number => interval.right - interval.left;
  const column = intervals.reduce((best, interval) =>
    width(interval) > width(best) || (width(interval) === width(best) && interval.items > best.items) ? interval : best,
  );
  const margins = intervals.filter((interval) => interval !== column && width(interval) < MARGIN_TEXT_WIDTH_FRACTION * width(column));
  if (margins.length === 0) return { lines: lines.map((line) => [...line]), runs: [], items: 0 };
  const marginOf = (item: PlacedTextItem): number =>
    margins.findIndex((interval) => item[2] >= interval.left && item[2] + item[4] <= interval.right);

  // Take the items off their lines, fragment by line, and group the
  // fragments of one margin on consecutive lines into a run.
  const runs: string[] = [];
  let items = 0;
  const open = new Map<number, string[]>(); // margin index → the run's lines so far
  const close = (margin: number): void => {
    const fragments = open.get(margin);
    if (fragments === undefined) return;
    open.delete(margin);
    const run = joinBrokenLines(fragments).join("\n");
    if (run.trim() !== "") runs.push(run);
  };
  const kept = lines.map((line, index) => {
    if (isFurniture(index)) {
      for (const margin of [...open.keys()]) close(margin);
      return [...line];
    }
    // The note's own word spaces (blank items inside the margin) travel
    // with it; the blank that spans the gutter starts in the column and
    // stays on the line.
    const taken = takeFromLine(line, (item) => placed(item) && marginOf(item) >= 0);
    items += taken.taken.filter(isInk).length;
    const fragments = new Map<number, string>();
    for (const item of taken.taken) {
      const margin = marginOf(item as PlacedTextItem);
      fragments.set(margin, `${fragments.get(margin) ?? ""}${item[0]}`);
    }
    for (const margin of [...open.keys()]) if (!fragments.has(margin)) close(margin);
    for (const [margin, text] of fragments) {
      const fragment = text.trim();
      if (fragment === "") continue;
      const collected = open.get(margin) ?? [];
      collected.push(fragment);
      open.set(margin, collected);
    }
    return taken.kept;
  });
  for (const margin of [...open.keys()]) close(margin);
  return { lines: kept, runs, items };
}

/**
 * Join hyphen-broken lines: a line ending in `-` whose continuation starts
 * lowercase is one word the stream never broke. Applied across page
 * boundaries too.
 */
function joinBrokenLines(lines: readonly string[]): string[] {
  const joined: string[] = [];
  for (const line of lines) {
    const previous = joined[joined.length - 1];
    if (previous !== undefined && /-\s*$/u.test(previous) && /^\s*\p{Ll}/u.test(line)) {
      joined[joined.length - 1] = previous.replace(/-\s*$/u, "") + line.replace(/^\s+/u, "");
    } else {
      joined.push(line);
    }
  }
  return joined;
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
  /** How many margin line-number items were stripped. */
  marginNumbers: number;
  /** The margin text runs taken off the body lines (`extractMarginText`),
   * in page and line order, hyphen-joined; `judgeWebOracle` settles them
   * against the stream side. */
  marginText: string[];
  /** How many text items those runs took off the lines. */
  marginTextItems: number;
}

/**
 * The PDF side of the comparison: group each page's items into lines, strip
 * margin line numbers, folio lines everywhere and running heads (a page's
 * first non-folio line whose digit-stripped text recurs as a first line on
 * other pages), join hyphen-broken lines, and concatenate.
 */
export function assemblePdfText(pages: ExtractedTextItem[][]): AssembledPdfText {
  const pageItems = pages.map((page) => pdfLineItems(page));
  // Running heads repeat across pages; a heading happens once. The head key
  // drops digits, so a margin number glued onto a head does not hide it.
  const firstLineCounts = new Map<string, number>();
  const firstLineIndex = (lines: readonly (readonly ExtractedTextItem[])[]): number =>
    lines.findIndex((line) => {
      const text = lineText(line);
      return !isFolioLine(text) && text.trim() !== "";
    });
  for (const lines of pageItems) {
    const first = firstLineIndex(lines);
    if (first < 0) continue;
    const key = headKey(lineText(lines[first]!));
    if (key === "") continue;
    firstLineCounts.set(key, (firstLineCounts.get(key) ?? 0) + 1);
  }
  const isHead = (lines: readonly (readonly ExtractedTextItem[])[], index: number): boolean =>
    index === firstLineIndex(lines) && (firstLineCounts.get(headKey(lineText(lines[index]!))) ?? 0) >= 2;
  let folioLines = 0;
  let headerLines = 0;
  let marginNumbers = 0;
  const marginText: string[] = [];
  let marginTextItems = 0;
  const kept: string[] = [];
  for (const rawLines of pageItems) {
    // The text column is measured without the running head, whose folio
    // or right-set title would widen it past the margin numbers. Numbers
    // first: what lineno sets is dropped, not settled, because the stream
    // drops it too; the margin text rule then sees a page without them.
    const isFurniture = (index: number): boolean => isHead(rawLines, index);
    const stripped = stripMarginNumbers(rawLines, isFurniture);
    marginNumbers += stripped.stripped;
    const margins = extractMarginText(stripped.lines, isFurniture);
    marginText.push(...margins.runs);
    marginTextItems += margins.items;
    const lines = margins.lines.map(lineText);
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
  return { text: joinBrokenLines(kept).join("\n"), folioLines, headerLines, marginNumbers, marginText, marginTextItems };
}

export interface TokenRunRemoval {
  tokens: string[];
  removed: boolean;
  /** How many of `tokens` the match spanned — the run's own count only when
   * the two sides drew their token boundaries alike. */
  removedTokens: number;
}

/**
 * Remove the first occurrence of `run` from `tokens`, matching on
 * characters: the run matches a window of whole tokens whose concatenation
 * is the run's, wherever either side put its token boundaries. The two
 * substrates tokenize the same text differently all the time — pdf.js
 * breaks `σρ` where the stream's linearizer does not — and a footnote
 * that matched token for token except at one such boundary was charged
 * twice its length: once as text the PDF side kept, once as text appended
 * to the stream side. Characters are what the text is; boundaries are
 * where a text layer chose to put spaces. The window still starts and
 * ends on token boundaries of `tokens`, so a run never takes a piece of a
 * neighbouring word with it. Unmatched runs are left alone — the
 * similarity floor absorbs or reports them.
 */
export function removeTokenRun(tokens: string[], run: string[]): TokenRunRemoval {
  const target = run.join("");
  if (target.length === 0 || run.length > tokens.length) return { tokens, removed: false, removedTokens: 0 };
  for (let start = 0; start < tokens.length; start += 1) {
    let consumed = 0;
    for (let end = start; end < tokens.length; end += 1) {
      const token = tokens[end]!;
      if (!target.startsWith(token, consumed)) break;
      consumed += token.length;
      if (consumed === target.length) {
        return {
          tokens: [...tokens.slice(0, start), ...tokens.slice(end + 1)],
          removed: true,
          removedTokens: end + 1 - start,
        };
      }
    }
  }
  return { tokens, removed: false, removedTokens: 0 };
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
    removedTokens += removal.removedTokens;
  }
  return { tokens, omitted, removedTokens, budgetTokens, overBudget: removedTokens > budgetTokens };
}

export interface RelocationResult<T> {
  /** The PDF tokens with the runs the PDF carries taken off. */
  pdfTokens: string[];
  /** The stream tokens with the runs the PDF lacks appended. */
  streamTokens: string[];
  /** Runs found in the PDF and removed from it, and the tokens that took. */
  matched: number;
  matchedTokens: number;
  /** The runs the PDF does not carry contiguously, in input order: their
   * tokens stand on the stream side and count as divergence. */
  unmatched: T[];
  unmatchedTokens: number;
}

/**
 * Account for the paragraphs the stream deliberately relocates — footnotes,
 * which the serializer carries as endnotes at the very end while the PDF
 * sets them at page bottoms. An ordered comparison would charge every such
 * paragraph twice its length for the move, so each relocated run is
 * settled on its own: when the PDF carries it as a contiguous token run it
 * is removed from the PDF side and never added to the stream side (both
 * substrates show the text; only its place differs); when the PDF does not,
 * its tokens are appended to the stream side, where the comparison still
 * sees them as text the PDF lacks.
 *
 * No budget bounds this, unlike `subtractUnreferenced`, and none is needed:
 * a run leaves the PDF side only when the PDF actually contains it, so the
 * removal never hides text one substrate shows and the other does not — the
 * multiset difference between the two sides is exactly what it was, and
 * what the PDF lacks stays counted on the stream side. Only the order
 * evidence is given up, and that only for runs the stream declared moved.
 */
export function relocateRuns<T extends { text: string }>(
  pdfTokens: readonly string[],
  streamTokens: readonly string[],
  relocated: readonly T[],
): RelocationResult<T> {
  const settled = settleRuns(pdfTokens, streamTokens, relocated);
  return {
    pdfTokens: settled.carrier,
    streamTokens: settled.other,
    matched: settled.matched,
    matchedTokens: settled.matchedTokens,
    unmatched: settled.unmatched,
    unmatchedTokens: settled.unmatchedTokens,
  };
}

export interface RunSettlement<T> {
  /** The side the runs were looked for on, with the found ones removed. */
  carrier: string[];
  /** The side the runs came from, with the ones not found appended. */
  other: string[];
  matched: number;
  matchedTokens: number;
  /** The runs the carrier does not hold contiguously, in input order. */
  unmatched: T[];
  unmatchedTokens: number;
}

/**
 * Settle runs one substrate is known to hold out of order — the mechanism
 * behind `relocateRuns`, with the sides named by role. A run is looked for
 * on the `carrier` side as a contiguous token run (on characters, boundaries
 * aside); found, it is removed there and added nowhere, since the `other`
 * side already had it taken out; not found, its tokens are appended to the
 * `other` side, where the comparison still sees them as text the carrier
 * lacks. The multiset difference between the two sides is exactly what it
 * was; only the order evidence for the declared runs is given up.
 */
export function settleRuns<T extends { text: string }>(
  carrierTokens: readonly string[],
  otherTokens: readonly string[],
  runs: readonly T[],
): RunSettlement<T> {
  let carrier = [...carrierTokens];
  const other = [...otherTokens];
  let matched = 0;
  let matchedTokens = 0;
  const unmatched: T[] = [];
  let unmatchedTokens = 0;
  for (const paragraph of runs) {
    const run = oracleTokens(paragraph.text);
    if (run.length === 0) continue; // marker-only, or a footnote of pure symbols
    const removal = removeTokenRun(carrier, run);
    if (removal.removed) {
      carrier = removal.tokens;
      matched += 1;
      matchedTokens += removal.removedTokens;
    } else {
      other.push(...run);
      unmatched.push(paragraph);
      unmatchedTokens += run.length;
    }
  }
  return { carrier, other, matched, matchedTokens, unmatched, unmatchedTokens };
}

// ── token-boundary merging ─────────────────────────────────────────────────

export interface BoundaryMerge {
  /** The two sequences with every boundary-only divergence folded to one
   * identical token on each side. */
  pdfTokens: string[];
  streamTokens: string[];
  /** Divergences folded, and the tokens that took off the two sides. */
  mergedRuns: number;
  mergedTokens: number;
  /** The plain edit script was longer than the search bound, so nothing was
   * folded and the sequences are returned as they came. */
  bounded: boolean;
}

/**
 * The plain token distance under which the boundary merge is searched, as
 * a similarity. The merge needs the whole edit script, not just its
 * length, and the script search costs time in the length of the script;
 * a pair of sequences less than half alike is not one text with its
 * boundaries drawn twice, so the search stops there and the plain
 * comparison stands — the skip direction.
 */
export const BOUNDARY_MERGE_SEARCH_FLOOR = 0.5;

/**
 * How many consecutive matched tokens it takes to anchor the alignment
 * between two divergences. A shortest edit script is not unique, and where
 * one side reads `1 1 d2` and the other `1 1d2` the script may pair the
 * first `1`s or the second — a tie it breaks arbitrarily, leaving either
 * one foldable hunk or two unfoldable ones. A matched run this short
 * between two hunks does not split them: the hunks and the run are one
 * region, folded when the whole spells the same string, which is as
 * character-identical as before (a matched token is by definition on
 * both sides). The whole-region fold is taken only when some hunk in the
 * region cannot fold on its own, so the rule only ever adds folds and
 * never coarsens one; a short run beside a single hunk is left as it is —
 * it changes nothing about whether that hunk folds.
 */
export const BOUNDARY_MERGE_ANCHOR_RUN = 1;

/**
 * Fold the token-boundary differences between the two sides. The two
 * substrates agree on the characters of a text far more often than on
 * where its tokens end: pdf.js breaks a token wherever a glyph advance is
 * wide (italic corrections, script shifts, font switches — `k1 α k e` for
 * the stream's `k1α ke`), an OT1 accent is a separate item on the PDF side
 * (`erd os` for `erdos`), and the PDF assembly's own dehyphenation glues a
 * compound that broke at a line end (`cliquewidth` for `clique width`).
 * None of that is text one substrate shows and the other does not.
 *
 * So a divergence whose two sides concatenate to the same characters is
 * not a divergence: in a shortest edit script between the sequences, each
 * region between two anchoring matched runs (see the anchor constant)
 * whose two sides spell the same string is replaced by that string, one
 * identical token on each side. The comparison that follows sees no edit there, and the
 * denominator shrinks by the tokens folded away, exactly as if the text
 * had been tokenized alike on both sides to begin with.
 *
 * This forgives nothing the oracle exists to catch. Every character on
 * either side of a folded hunk is on the other side too, in the same
 * order, in the same place between the same matched neighbours; a dropped
 * word, a wrong linearization, a re-typeset paragraph all leave a hunk
 * whose sides spell different strings, and those stay divergence, token
 * for token. The fold only ever lifts a similarity, so a pair the plain
 * comparison seals is sealed still; and it is searched only while the
 * plain script is under the bound above, so time stays what the plain
 * comparison would spend at that similarity.
 */
export function mergeTokenBoundaries(pdf: string[], stream: string[]): BoundaryMerge {
  const total = pdf.length + stream.length;
  const unmerged = (bounded: boolean): BoundaryMerge => ({
    pdfTokens: pdf,
    streamTokens: stream,
    mergedRuns: 0,
    mergedTokens: 0,
    bounded,
  });
  if (total === 0) return unmerged(false);
  const matches = shortestScriptMatches(pdf, stream, Math.floor((1 - BOUNDARY_MERGE_SEARCH_FLOOR) * total));
  if (matches === undefined) return unmerged(true);
  return foldBoundaryRegions(pdf, stream, matches);
}

/**
 * The fold itself, over a script's matched pairs (`shortestScriptMatches`'s
 * flat form): regions between anchoring matched runs that spell the same
 * string on both sides become one token a side. Separate from the script
 * search so the tie-breaking of the search can be tested around.
 */
export function foldBoundaryRegions(pdf: string[], stream: string[], matches: readonly number[]): BoundaryMerge {
  const pdfOut: string[] = [];
  const streamOut: string[] = [];
  let mergedRuns = 0;
  let mergedTokens = 0;
  let pdfAt = 0;
  let streamAt = 0;
  // Whether a stretch of both sides spells the same string on both, and
  // the fold of one that does: one token each.
  const foldable = (pdfStart: number, pdfEnd: number, streamStart: number, streamEnd: number): boolean =>
    pdfEnd > pdfStart &&
    streamEnd > streamStart &&
    pdf.slice(pdfStart, pdfEnd).join("") === stream.slice(streamStart, streamEnd).join("");
  const fold = (pdfStart: number, pdfEnd: number, streamStart: number, streamEnd: number): boolean => {
    if (!foldable(pdfStart, pdfEnd, streamStart, streamEnd)) return false;
    pdfOut.push(pdf.slice(pdfStart, pdfEnd).join(""));
    streamOut.push(stream.slice(streamStart, streamEnd).join(""));
    mergedRuns += 1;
    mergedTokens += pdfEnd - pdfStart + (streamEnd - streamStart) - 2;
    return true;
  };
  const pass = (pdfStart: number, pdfEnd: number, streamStart: number, streamEnd: number): void => {
    for (let at = pdfStart; at < pdfEnd; at += 1) pdfOut.push(pdf[at]!);
    for (let at = streamStart; at < streamEnd; at += 1) streamOut.push(stream[at]!);
  };
  // The maximal matched runs, as [x, y, length] triples.
  const runs: Array<[number, number, number]> = [];
  for (let index = 0; index < matches.length; index += 2) {
    const last = runs[runs.length - 1];
    if (last !== undefined && matches[index] === last[0] + last[2] && matches[index + 1] === last[1] + last[2]) {
      last[2] += 1;
    } else {
      runs.push([matches[index]!, matches[index + 1]!, 1]);
    }
  }
  const runEnd = (index: number): [number, number] =>
    index < runs.length ? [runs[index]![0] + runs[index]![2], runs[index]![1] + runs[index]![2]] : [pdf.length, stream.length];
  const gapAfter = (index: number): boolean => {
    const [x, y] = runEnd(index);
    const next = runs[index + 1];
    return next === undefined ? x < pdf.length || y < stream.length : next[0] > x || next[1] > y;
  };
  for (let index = 0; index <= runs.length; ) {
    const run = runs[index];
    if (run !== undefined && run[0] === pdfAt && run[1] === streamAt) {
      // No hunk before this run: it is matched text, whatever its length.
      pass(run[0], run[0] + run[2], run[1], run[1] + run[2]);
      [pdfAt, streamAt] = runEnd(index);
      index += 1;
      continue;
    }
    // A hunk opens a region; a short run followed by another hunk joins it.
    // The region folds hunk by hunk when every hunk in it folds on its own,
    // the short runs passing through as the matched text they are; whole
    // when it cannot but the whole spells the same string — the tie-broken
    // alignment inside it is then immaterial; and hunk by hunk otherwise,
    // so a foldable hunk is never held back by a real divergence a token
    // away from it. Hunk by hunk is never coarser than it has to be, and
    // the whole-region fold is only ever an addition to it.
    let close = index;
    while (close < runs.length && runs[close]![2] <= BOUNDARY_MERGE_ANCHOR_RUN && gapAfter(close)) close += 1;
    const anchor = runs[close];
    const [pdfEnd, streamEnd] = anchor === undefined ? [pdf.length, stream.length] : [anchor[0], anchor[1]];
    let everyHunk = true;
    {
      let [px, py] = [pdfAt, streamAt];
      for (let inner = index; inner < close && everyHunk; inner += 1) {
        everyHunk = foldable(px, runs[inner]![0], py, runs[inner]![1]);
        [px, py] = runEnd(inner);
      }
      everyHunk &&= foldable(px, pdfEnd, py, streamEnd);
    }
    if (everyHunk || !fold(pdfAt, pdfEnd, streamAt, streamEnd)) {
      let [px, py] = [pdfAt, streamAt];
      for (let inner = index; inner < close; inner += 1) {
        const run = runs[inner]!;
        if (!fold(px, run[0], py, run[1])) pass(px, run[0], py, run[1]);
        pass(run[0], run[0] + run[2], run[1], run[1] + run[2]);
        [px, py] = runEnd(inner);
      }
      if (!fold(px, pdfEnd, py, streamEnd)) pass(px, pdfEnd, py, streamEnd);
    }
    if (anchor === undefined) break;
    pass(anchor[0], anchor[0] + anchor[2], anchor[1], anchor[1] + anchor[2]);
    [pdfAt, streamAt] = runEnd(close);
    index = close + 1;
  }
  return { pdfTokens: pdfOut, streamTokens: streamOut, mergedRuns, mergedTokens, bounded: false };
}

/**
 * The matched pairs of a shortest edit script between `a` and `b`, as a
 * flat `[aIndex, bIndex, aIndex, bIndex, …]` in increasing order — Myers'
 * linear-space refinement (divide at the middle snake), so the memory is
 * O(len(a)+len(b)) whatever the script's length, which the O(ND) trace of
 * the plain algorithm is not. `undefined` when the script would be longer
 * than `maxDistance`: the search is bounded at its top level, where the
 * middle snake of a script of length D is found at cost ⌈D/2⌉.
 */
export function shortestScriptMatches(a: string[], b: string[], maxDistance: number): number[] | undefined {
  const matches: number[] = [];
  const stack: Array<[number, number, number, number, number]> = [[0, a.length, 0, b.length, maxDistance]];
  // The ranges are handled left to right: a range's left half is pushed
  // last so it is popped first, and its middle snake's own matches are
  // queued as a range that is all common prefix.
  while (stack.length > 0) {
    const [, a1, , b1, bound] = stack.at(-1)!;
    let [a0, , b0] = stack.pop()!;
    while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) {
      matches.push(a0, b0);
      a0 += 1;
      b0 += 1;
    }
    let suffix = 0;
    while (a0 < a1 - suffix && b0 < b1 - suffix && a[a1 - 1 - suffix] === b[b1 - 1 - suffix]) suffix += 1;
    if (a0 < a1 - suffix && b0 < b1 - suffix) {
      const snake = middleSnake(a, a0, a1 - suffix, b, b0, b1 - suffix, bound);
      if (snake === undefined) return undefined;
      const [x0, y0, x1, y1, distance] = snake;
      // Order of work: left range, the snake (a fully-matching range), the
      // right range, then this range's common suffix — pushed in reverse.
      stack.push([a1 - suffix, a1, b1 - suffix, b1, 0]);
      stack.push([x1, a1 - suffix, y1, b1 - suffix, distance]);
      stack.push([x0, x1, y0, y1, 0]);
      stack.push([a0, x0, b0, y0, distance]);
      continue;
    }
    for (let index = 0; index < suffix; index += 1) matches.push(a1 - suffix + index, b1 - suffix + index);
  }
  return a.length + b.length - matches.length > maxDistance ? undefined : matches;
}

/**
 * Myers' middle snake over `a[a0, a1)` and `b[b0, b1)`, both non-empty and
 * sharing neither a first nor a last token: forward and reverse searches
 * meet on a diagonal, and the snake where they meet plus the script's
 * length come back as `[x0, y0, x1, y1, distance]` in `a`/`b` indices.
 * `undefined` as soon as no script within `maxDistance` can still be
 * found, so a script over the bound is never traced. With the ends stripped the script has at
 * least two edits, so both halves of the split are strictly smaller.
 */
function middleSnake(
  a: string[],
  a0: number,
  a1: number,
  b: string[],
  b0: number,
  b1: number,
  maxDistance: number,
): [number, number, number, number, number] | undefined {
  const n = a1 - a0;
  const m = b1 - b0;
  const delta = n - m;
  const odd = (delta & 1) === 1;
  const limit = Math.ceil((n + m) / 2);
  const offset = limit + 1;
  const forward = new Int32Array(2 * limit + 3);
  const reverse = new Int32Array(2 * limit + 3);
  forward[offset + 1] = 0;
  reverse[offset + 1] = 0;
  for (let d = 0; d <= limit; d += 1) {
    // The shortest script this round can still find has 2d-1 edits.
    if (2 * d - 1 > maxDistance) return undefined;
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && forward[offset + k - 1]! < forward[offset + k + 1]!)
          ? forward[offset + k + 1]!
          : forward[offset + k - 1]! + 1;
      let y = x - k;
      const xs = x;
      const ys = y;
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
        x += 1;
        y += 1;
      }
      forward[offset + k] = x;
      // The reverse diagonal through the same points, in reversed coordinates.
      const c = delta - k;
      if (odd && c >= -(d - 1) && c <= d - 1 && x >= n - reverse[offset + c]!) {
        return [a0 + xs, b0 + ys, a0 + x, b0 + y, 2 * d - 1];
      }
    }
    for (let c = -d; c <= d; c += 2) {
      let x =
        c === -d || (c !== d && reverse[offset + c - 1]! < reverse[offset + c + 1]!)
          ? reverse[offset + c + 1]!
          : reverse[offset + c - 1]! + 1;
      let y = x - c;
      const xs = x;
      const ys = y;
      while (x < n && y < m && a[a1 - 1 - x] === b[b1 - 1 - y]) {
        x += 1;
        y += 1;
      }
      reverse[offset + c] = x;
      const k = delta - c;
      if (!odd && k >= -d && k <= d && forward[offset + k]! >= n - x) {
        return 2 * d > maxDistance ? undefined : [a1 - x, b1 - y, a1 - xs, b1 - ys, 2 * d];
      }
    }
  }
  // Unreachable: the searches always meet within ⌈(n+m)/2⌉ steps.
  return undefined;
}

export interface TokenDivergence {
  index: number;
  pdf: string;
  stream: string;
}

export interface TokenComparison {
  /** LCS length over the larger sequence length; 1 for two empty sequences. */
  similarity: number;
  /** Where the sequences first differ, when they do: the common-prefix
   * length plus a window of both sides there. */
  divergence?: TokenDivergence;
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


// ── the verdict ────────────────────────────────────────────────────────────

/** The stream side as the encode child reports it (web.ts parses it). */
export interface OracleStream<T extends { text: string }> {
  /** The linearized glyph text of the referenced, in-place content. */
  text: string;
  /** Captured paragraphs the page stream never references. */
  unreferenced: readonly T[];
  /** Referenced paragraphs the stream carries out of page order. */
  relocated: readonly T[];
}

export interface WebOracleInput<T extends { text: string }> {
  /** The PDF's text layer, page by page, as `extractPdfText` returns it. */
  pdfPages: ExtractedTextItem[][];
  stream: OracleStream<T>;
  /** The similarity under which the derivation is skipped. */
  floor: number;
}

export interface WebOracleJudgment<T extends { text: string }> {
  /** The assembled PDF text and the furniture counts behind it. */
  assembled: AssembledPdfText;
  /** The PDF's tokens as extracted, before any relocation or subtraction. */
  pdfTokenCount: number;
  /** The two sequences the verdict compared — after relocation,
   * subtraction and the boundary merge. */
  pdfTokens: string[];
  streamTokens: string[];
  relocation: RelocationResult<T>;
  /** The PDF's margin text runs (`assembled.marginText`) settled against
   * the stream side: `matched` were found there and taken off it,
   * `unmatched` went back onto the PDF side. */
  margin: RunSettlement<{ text: string }>;
  subtraction: UnreferencedSubtraction<T>;
  /** The boundary merge that produced the compared sequences. */
  merge: BoundaryMerge;
  /** The comparison at `floor`. */
  verdict: TokenComparison;
  /** Sealable: within the floor and within the unreferenced budget. */
  passes: boolean;
  /** Where the compared sequences first differ, whether or not the verdict
   * passes; absent when they are identical. */
  firstDifference?: TokenDivergence;
}

/**
 * The whole oracle, from the PDF's pages and the stream report to the
 * verdict: assemble and tokenize the PDF side, tokenize the stream side,
 * settle the relocated paragraphs, subtract the unreferenced captures under
 * their budget, then compare at the floor. The deriver seals or skips on
 * `passes`; the reflow lab recomputes the same judgment from the kept
 * artifacts. Pure: everything it needs is in its argument.
 */
export function judgeWebOracle<T extends { text: string }>(input: WebOracleInput<T>): WebOracleJudgment<T> {
  const assembled = assemblePdfText(input.pdfPages);
  const extracted = oracleTokens(assembled.text);
  const inPlace = oracleTokens(input.stream.text);
  // Relocation first: an unreferenced capture that is a trial typesetting
  // of a footnote (measured before it is set) is text the surface shows
  // — in the endnotes — and must not be subtracted from the PDF side, so
  // the subtraction's "does the stream carry it" check sees every
  // relocated paragraph, matched or not, beside the in-place text.
  const relocation = relocateRuns(extracted, inPlace, input.stream.relocated);
  // The mirror image for the PDF's margin text: the assembly took each
  // `\marginpar` note off the body lines pdf.js spliced it into; the
  // stream carries the note as a paragraph in reading order, so it comes
  // off the stream side where found. A note the stream does not carry goes
  // back onto the PDF side *before* the subtraction, where an unreferenced
  // capture of it — a serializer that dropped the note — is still found,
  // forgiven within the budget, and named.
  const margin = settleRuns(
    relocation.streamTokens,
    relocation.pdfTokens,
    assembled.marginText.map((text) => ({ text })),
  );
  const carried = [...inPlace, ...input.stream.relocated.flatMap((paragraph) => oracleTokens(paragraph.text))];
  const subtraction = subtractUnreferenced(margin.other, carried, input.stream.unreferenced);
  // Last, once both sides hold what they will be compared on: the
  // boundary-only divergences fold away, and the sequences reported and
  // dumped are the folded ones, so a diff of them shows the residue.
  const merge = mergeTokenBoundaries(subtraction.tokens, margin.carrier);
  const pdfTokens = merge.pdfTokens;
  const streamTokens = merge.streamTokens;
  const verdict = compareTokens(pdfTokens, streamTokens, input.floor);
  // At floor 1 any difference at all is reported, at the common prefix's end.
  const first = compareTokens(pdfTokens, streamTokens, 1);
  return {
    assembled,
    // the margin runs are the PDF's tokens too, taken off before tokenizing
    pdfTokenCount: extracted.length + assembled.marginText.reduce((sum, text) => sum + oracleTokens(text).length, 0),
    pdfTokens,
    streamTokens,
    relocation,
    margin,
    subtraction,
    merge,
    verdict,
    passes: verdict.divergence === undefined && !subtraction.overBudget,
    ...(first.divergence === undefined ? {} : { firstDifference: first.divergence }),
  };
}
