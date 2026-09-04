// The web derivation's oracle, case by case (paper-web-plan.md, "The
// oracle"): every specified normalization — hyphenation joining, ligature
// and math-alphabet decomposition, accent stripping, casing/punctuation
// tolerance, PDF-side furniture stripping, unreferenced-paragraph removal —
// plus the similarity verdict and its divergence location. Each
// normalization deletes evidence, so each is tested from both sides: it
// must forgive what it exists to forgive, and it must not delete a faithful
// paper's own text.

import { describe, expect, it } from "vitest";
import type { ExtractedTextItem } from "../../src/submission-validation/paper/extract-destinations.js";
import {
  assemblePdfText,
  compareTokens,
  isFolioLine,
  oracleTokens,
  pdfLines,
  removeTokenRun,
  subtractUnreferenced,
  UNREFERENCED_BUDGET_CEILING_FRACTION,
  UNREFERENCED_BUDGET_FRACTION,
  UNREFERENCED_BUDGET_MINIMUM,
} from "../../src/submission-validation/paper/web-oracle.js";

describe("oracle tokenization", () => {
  it("tokenizes lowercased alphanumeric runs, dropping punctuation and symbols", () => {
    expect(oracleTokens("The ``quoted--text'' uses 100% of $x$."))
      .toEqual(["the", "quoted", "text", "uses", "100", "of", "x"]);
    // Typographic characters from the PDF's toUnicode behave the same.
    expect(oracleTokens("The “quoted–text” uses ligatures"))
      .toEqual(["the", "quoted", "text", "uses", "ligatures"]);
  });

  it("decomposes ligature codepoints the stream's glyphs carry", () => {
    // U+FB03 ffi, U+FB00 ff, U+FB02 fl — the stream side keeps the glyph
    // codepoints; the PDF side usually arrives decomposed already.
    expect(oracleTokens("eﬃcient waﬀles ﬂuﬀy"))
      .toEqual(["efficient", "waffles", "fluffy"]);
  });

  it("folds mathematical alphanumerics to base letters on both substrates", () => {
    // pdf.js reads script/blackboard letters as U+1D49C-block characters;
    // a unicode-math stream carries the same codepoints.
    expect(oracleTokens("\u{1D49C} maps to \u{1D538} and \u{1D6FC}"))
      .toEqual(["a", "maps", "to", "a", "and", "α"]);
  });

  it("strips accents whether composed or combining", () => {
    expect(oracleTokens("Erdős étude étude")).toEqual(["erdos", "etude", "etude"]);
  });

  it("equalizes heading casing — \\MakeUppercase never counts as divergence", () => {
    expect(oracleTokens("OVERVIEW OF THE MACHINERY.")).toEqual(oracleTokens("Overview of the Machinery"));
  });

  it("keeps digits and splits at every symbol boundary", () => {
    expect(oracleTokens("tw(G) ≤ |V(G)| − 1. (1)"))
      .toEqual(["tw", "g", "v", "g", "1", "1"]);
  });
});

describe("PDF-side assembly", () => {
  const page = (lines: string[][]): ExtractedTextItem[] =>
    lines.flatMap((items) =>
      items.map((text, index): ExtractedTextItem => [text, index === items.length - 1 ? 1 : 0]));

  it("groups items into lines at hasEOL, closing the last line at the page end", () => {
    expect(pdfLines([["Theorem 1.", 0], [" ", 0], ["0 = 0", 0], [".", 1], ["1", 0]]))
      .toEqual(["Theorem 1. 0 = 0.", "1"]);
  });

  it("recognizes folio-like standalone lines", () => {
    expect(isFolioLine("7")).toBe(true);
    expect(isFolioLine(" 42 ")).toBe(true);
    expect(isFolioLine("xiv")).toBe(true);
    expect(isFolioLine("1 A second file")).toBe(false);
    expect(isFolioLine("Theorem 1.")).toBe(false);
  });

  it("leaves a line with more than one token alone, however digit-like", () => {
    // A page number stands alone on its line. A row of a table of small
    // integers is digits too — but only after its column spacing is thrown
    // away, and deleting such rows from the PDF side while the stream
    // carries them fails a faithful paper.
    expect(isFolioLine("4  15")).toBe(false);
    expect(isFolioLine("1 1")).toBe(false);
    expect(isFolioLine("3  14  15")).toBe(false);
    expect(isFolioLine("i i")).toBe(false);
  });

  it("takes only well-formed roman numerals, not every word spelled in them", () => {
    expect(isFolioLine("iv")).toBe(true);
    expect(isFolioLine("XLII")).toBe(true);
    expect(isFolioLine("civil")).toBe(false);
    expect(isFolioLine("mild")).toBe(false);
    expect(isFolioLine("did")).toBe(false);
  });

  it("keeps a small-integer table whole while still stripping the page number", () => {
    const rows = ["1   1", "2   3", "3   7", "4  15", "5  31", "6  63", "7  127", "8  255"];
    const assembled = assemblePdfText([
      page([["The coefficients of the expansion, row by row:"], ...rows.map((row) => [row]), ["7"]]),
    ]);
    expect(assembled.folioLines).toBe(1);
    // the stream carries the same table: the two sides agree exactly
    const stream = oracleTokens(["The coefficients of the expansion, row by row:", ...rows].join(" "));
    expect(compareTokens(oracleTokens(assembled.text), stream, 0.98)).toEqual({ similarity: 1 });
  });

  it("strips folios but keeps a section heading that begins with its number", () => {
    const assembled = assemblePdfText([
      page([["1 A second file"], ["Some content on the page."], ["1"]]),
    ]);
    expect(assembled.folioLines).toBe(1);
    expect(assembled.text).toBe("1 A second file\nSome content on the page.");
  });

  it("strips running heads repeated across pages, folio digits ignored", () => {
    const assembled = assemblePdfText([
      page([["A PAPER TITLE 2"], ["First page text."], ["2"]]),
      page([["A PAPER TITLE 3"], ["Second page text."], ["3"]]),
      page([["A unique heading"], ["Third page text."], ["4"]]),
    ]);
    expect(assembled.headerLines).toBe(2);
    expect(assembled.folioLines).toBe(3);
    expect(assembled.text).toBe(
      "First page text.\nSecond page text.\nA unique heading\nThird page text.",
    );
  });

  it("joins hyphen-broken lines, across page boundaries, only before lowercase", () => {
    const assembled = assemblePdfText([
      page([["overparameterized representa-"], ["tions demand careful hyphena-"]]),
      page([["tion. A dash before a name stays: the Cauchy-"], ["Schwarz inequality."], ["2"]]),
    ]);
    expect(assembled.text).toBe(
      "overparameterized representations demand careful hyphenation. A dash before a name stays: the Cauchy-\nSchwarz inequality.",
    );
  });

  it("matches the real pdf.js item shape end to end", () => {
    // The webjob fixture's page, abbreviated: interleaved EOL-less items,
    // explicit space items, a trailing folio.
    const items: ExtractedTextItem[] = [
      ["We use the standard notion of one being equal to one as everyone does; 100%", 1],
      ["of the markers in this file are real.", 0],
      ["", 1],
      ["Theorem 1.", 0],
      [" ", 0],
      ["0 = 0", 0],
      [".", 1],
      ["1", 0],
    ];
    const assembled = assemblePdfText([items]);
    expect(oracleTokens(assembled.text)).toEqual([
      "we", "use", "the", "standard", "notion", "of", "one", "being", "equal", "to", "one",
      "as", "everyone", "does", "100", "of", "the", "markers", "in", "this", "file", "are",
      "real", "theorem", "1", "0", "0",
    ]);
  });
});

describe("unreferenced-paragraph removal", () => {
  it("removes the first contiguous occurrence of a run", () => {
    const tokens = ["the", "text", "a", "marginal", "note", "continues", "a", "marginal", "note"];
    const result = removeTokenRun(tokens, ["a", "marginal", "note"]);
    expect(result.removed).toBe(true);
    expect(result.tokens).toEqual(["the", "text", "continues", "a", "marginal", "note"]);
  });

  it("leaves the sequence alone when the run is absent or empty", () => {
    const tokens = ["one", "two"];
    expect(removeTokenRun(tokens, ["three"])).toEqual({ tokens, removed: false });
    expect(removeTokenRun(tokens, [])).toEqual({ tokens, removed: false });
    expect(removeTokenRun(tokens, ["one", "two", "three"])).toEqual({ tokens, removed: false });
  });

  const paragraph = (index: number): string =>
    `Paragraph number ${index} states a genuine claim about the construction and its consequences.`;

  it("subtracts a margin note the stream never carries, and names it", () => {
    // The proportions of a real one-page paper: seven tokens of marginalia
    // in fifty-nine, which is what the budget exists to forgive.
    const note = "A marginal note that only print shows";
    const body = [paragraph(1), paragraph(2), paragraph(3), paragraph(4)];
    const printed = [paragraph(1), note, ...body.slice(1)].join(" ");
    const streamed = body.join(" ");
    const subtraction = subtractUnreferenced(oracleTokens(printed), oracleTokens(streamed), [{ text: note }]);
    expect(subtraction.omitted).toEqual([{ text: note }]);
    expect(subtraction.removedTokens).toBe(7);
    expect(subtraction.budgetTokens).toBe(11);
    expect(subtraction.overBudget).toBe(false);
    expect(subtraction.tokens).toEqual(oracleTokens(streamed));
  });

  it("subtracts nothing for a trial typesetting the stream does carry", () => {
    // \caption measures its box before setting it, and classes measure the
    // opening letters of a paragraph the same way: the capture is
    // unreferenced, but the surface shows the text.
    const printed = [paragraph(1), paragraph(2)].join(" ");
    const subtraction = subtractUnreferenced(oracleTokens(printed), oracleTokens(printed), [
      { text: "Paragraph number 2 states" },
      { text: "Th" },
    ]);
    expect(subtraction.omitted).toEqual([]);
    expect(subtraction.removedTokens).toBe(0);
    expect(subtraction.tokens).toEqual(oracleTokens(printed));
  });

  it("refuses to forgive more than the budget: the remnant is a different document", () => {
    const paragraphs = Array.from({ length: 8 }, (unused, index) => paragraph(index));
    const pdf = oracleTokens(paragraphs.join(" "));
    const stream = oracleTokens(paragraphs[0]!);
    // Untouched, the two sides are a skip: 104 PDF tokens against 13.
    const untouched = compareTokens(pdf, stream, 0.98);
    expect(untouched.similarity).toBeLessThan(0.98);
    expect(untouched.divergence).toBeDefined();
    // Subtract all seven and the oracle compares one paragraph with itself,
    // sealing a bundle that carries an eighth of the paper.
    const subtraction = subtractUnreferenced(pdf, stream, paragraphs.slice(1).map((text) => ({ text })));
    expect(subtraction.removedTokens).toBe(91);
    expect(subtraction.budgetTokens).toBe(Math.floor(UNREFERENCED_BUDGET_CEILING_FRACTION * pdf.length));
    expect(subtraction.overBudget).toBe(true);
    expect(compareTokens(subtraction.tokens, stream, 0.98).similarity).toBe(1);
  });

  it("never forgives a quarter of a short paper, however far the floor is from it", () => {
    // The floor is what one honest margin note costs a short paper, not a
    // licence to drop a quarter of its words: thirty tokens of a
    // hundred-and-twenty-token paper sit just under the floor's thirty-two
    // and are still a different document.
    const pdf = Array.from({ length: 120 }, (unused, index) => `word${index}`);
    const dropped = pdf.slice(0, 30).join(" ");
    const stream = pdf.slice(30);
    const subtraction = subtractUnreferenced(pdf, stream, [{ text: dropped }]);
    expect(subtraction.removedTokens).toBe(30);
    expect(subtraction.removedTokens).toBeLessThan(UNREFERENCED_BUDGET_MINIMUM);
    expect(subtraction.overBudget).toBe(true);
    expect(subtraction.budgetTokens).toBe(24);
    // What the budget prevents: the subtraction leaves the two sides in
    // perfect agreement, so nothing downstream would object.
    expect(compareTokens(subtraction.tokens, stream, 0.98)).toEqual({ similarity: 1 });
  });

  it("scales the budget with the document, floored in the middle and capped at the bottom", () => {
    const long = Array.from({ length: 2_000 }, (unused, index) => `word${index}`);
    const budgetOf = (count: number): number => subtractUnreferenced(long.slice(0, count), [], []).budgetTokens;
    // Above 640 tokens the fraction governs; between 160 and 640 the floor
    // does; under 160 the ceiling does, because a fixed 32 tokens is a
    // growing share of an ever shorter paper.
    expect(budgetOf(2_000)).toBe(UNREFERENCED_BUDGET_FRACTION * 2_000);
    expect(budgetOf(300)).toBe(UNREFERENCED_BUDGET_MINIMUM);
    expect(budgetOf(60)).toBe(UNREFERENCED_BUDGET_CEILING_FRACTION * 60);
    // The one-page paper the e2e compiles measures 56 PDF tokens against a
    // 7-token \marginpar: its own fraction is two tokens, the floor lifts
    // the budget, and the ceiling still leaves the note room.
    expect(budgetOf(56)).toBeGreaterThan(7);
  });

  it("spends no budget on a run the PDF side does not carry contiguously", () => {
    // Nothing was removed, so the similarity floor still sees the whole
    // divergence — the budget bounds forgiveness, not diagnostics.
    const pdf = oracleTokens("the printed text says something else entirely");
    const absent = { text: "a capture that appears on neither substrate verbatim" };
    const subtraction = subtractUnreferenced(pdf, oracleTokens("the printed text"), [absent]);
    expect(subtraction.omitted).toEqual([absent]);
    expect(subtraction.removedTokens).toBe(0);
    expect(subtraction.overBudget).toBe(false);
    expect(subtraction.tokens).toEqual(pdf);
  });
});

describe("token comparison", () => {
  it("accepts identical sequences and empty documents", () => {
    expect(compareTokens(["a", "b", "c"], ["a", "b", "c"], 0.98)).toEqual({ similarity: 1 });
    expect(compareTokens([], [], 0.98)).toEqual({ similarity: 1 });
  });

  it("tolerates noise within the floor", () => {
    const base = Array.from({ length: 200 }, (unused, index) => `token${index}`);
    const noisy = [...base.slice(0, 100), "extra", ...base.slice(100)];
    const verdict = compareTokens(noisy, base, 0.98);
    expect(verdict.divergence).toBeUndefined();
    expect(verdict.similarity).toBeGreaterThan(0.99);
  });

  it("reports the first divergence location when the floor is broken", () => {
    const pdf = ["alpha", "beta", "print", "only", "sentence", "here", "gamma"];
    const stream = ["alpha", "beta", "gamma"];
    const verdict = compareTokens(pdf, stream, 0.98);
    expect(verdict.similarity).toBeLessThan(0.98);
    expect(verdict.divergence).toBeDefined();
    expect(verdict.divergence!.index).toBe(2);
    expect(verdict.divergence!.pdf).toContain("print only sentence");
    expect(verdict.divergence!.stream).toContain("gamma");
  });

  it("handles one empty side with the divergence at token zero", () => {
    const verdict = compareTokens(["missing", "everything"], [], 0.98);
    expect(verdict.divergence).toBeDefined();
    expect(verdict.divergence!.index).toBe(0);
    expect(verdict.divergence!.stream).toBe("(end of text)");
  });

  it("stays fast on large mostly-agreeing sequences", () => {
    const size = 30_000;
    const a = Array.from({ length: size }, (unused, index) => `w${index}`);
    const b = [...a];
    for (let index = 500; index < size; index += 500) b[index] = "changed";
    const started = performance.now();
    const verdict = compareTokens(a, b, 0.98);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(verdict.divergence).toBeUndefined();
    expect(verdict.similarity).toBeGreaterThan(0.99);
  });
});
