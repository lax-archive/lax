// The web derivation's oracle, case by case (paper-web-plan.md, "The
// oracle"): every specified normalization — hyphenation joining, ligature
// and math-alphabet decomposition, accent stripping, casing/punctuation
// tolerance, PDF-side furniture stripping, unreferenced-paragraph removal —
// plus the similarity verdict and its divergence location.

import { describe, expect, it } from "vitest";
import type { ExtractedTextItem } from "../../src/submission-validation/paper/extract-destinations.js";
import {
  assemblePdfText,
  compareTokens,
  isFolioLine,
  oracleTokens,
  pdfLines,
  removeTokenRun,
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
