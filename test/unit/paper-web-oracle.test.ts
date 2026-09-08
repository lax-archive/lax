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
  BOUNDARY_MERGE_SEARCH_FLOOR,
  compareTokens,
  foldBoundaryRegions,
  isFolioLine,
  judgeWebOracle,
  MARGIN_NUMBER_TOLERANCE,
  mergeTokenBoundaries,
  oracleTokens,
  pdfLines,
  relocateRuns,
  removeTokenRun,
  shortestScriptMatches,
  stripMarginNumbers,
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

  it("folds pdf.js's INCREMENT to the stream's capital Delta", () => {
    // A legacy math font's \Delta reaches the PDF text layer as U+2206, a
    // symbol the tokenizer drops; the stream carries U+0394, a letter.
    expect(oracleTokens("Tot(V \u2206)")).toEqual(["tot", "v", "δ"]);
    expect(oracleTokens("Tot(V\u2206)")).toEqual(oracleTokens("Tot(V\u0394)"));
    // The look-alikes NFKC already folds are letters and need no help.
    expect(oracleTokens("\u2126 \u00B5")).toEqual(["ω", "μ"]);
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
    const untouched = { tokens, removed: false, removedTokens: 0 };
    expect(removeTokenRun(tokens, ["three"])).toEqual(untouched);
    expect(removeTokenRun(tokens, [])).toEqual(untouched);
    expect(removeTokenRun(tokens, ["one", "two", "three"])).toEqual(untouched);
  });

  it("matches a run on its characters, whichever side drew the token boundaries", () => {
    // pdf.js splits `σρ` where the stream's linearizer does not; the run
    // still spans whole tokens of the sequence it is taken from.
    expect(removeTokenRun(["let", "σρ", "be", "small"], ["σ", "ρ"]))
      .toEqual({ tokens: ["let", "be", "small"], removed: true, removedTokens: 1 });
    expect(removeTokenRun(["let", "σ", "ρ", "be"], ["σρ", "be"]))
      .toEqual({ tokens: ["let"], removed: true, removedTokens: 3 });
    // Never a piece of a neighbouring token: `b c` is not inside `ab c`.
    expect(removeTokenRun(["ab", "c"], ["b", "c"])).toEqual({ tokens: ["ab", "c"], removed: false, removedTokens: 0 });
    expect(removeTokenRun(["a", "bc"], ["a", "b"])).toEqual({ tokens: ["a", "bc"], removed: false, removedTokens: 0 });
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

describe("token-boundary merging", () => {
  const merged = (pdf: string, stream: string) => mergeTokenBoundaries(oracleTokens(pdf), oracleTokens(stream));

  it("folds a divergence whose two sides spell the same characters", () => {
    // pdf.js breaks k^{1-α} and ke at the script shifts; the stream does not.
    const math = merged("we bound k1 α k e by", "we bound k1α ke by");
    expect(math.pdfTokens).toEqual(["we", "bound", "k1αke", "by"]);
    expect(math.streamTokens).toEqual(math.pdfTokens);
    expect(math).toMatchObject({ mergedRuns: 1, mergedTokens: 4, bounded: false });
    // the PDF assembly's dehyphenation glued a compound broken at a line end
    const compound = merged("graphs of bounded cliquewidth are", "graphs of bounded clique width are");
    expect(compound.pdfTokens).toEqual(["graphs", "of", "bounded", "cliquewidth", "are"]);
    expect(compound.streamTokens).toEqual(compound.pdfTokens);
    // an OT1 accent is its own item on the PDF side
    const accent = merged("in the erd os r enyi model of a random graph", "in the erdos renyi model of a random graph");
    expect(accent.pdfTokens).toEqual(["in", "the", "erdosrenyi", "model", "of", "a", "random", "graph"]);
    expect(accent.streamTokens).toEqual(accent.pdfTokens);
    expect(compareTokens(accent.pdfTokens, accent.streamTokens, 0.98)).toEqual({ similarity: 1 });
  });

  it("does not let one matched token between two hunks decide the alignment", () => {
    // Either `1` may pair with the stream's. The search happens to pair the
    // first here; a script that pairs the second (the reverse search of a
    // sub-range does) leaves `1 | ∅` and `d2 | 1d2`, neither foldable on
    // its own. Both scripts are shortest, and both must fold.
    const pdf = oracleTokens("size to acur 4cd 1 1 d2 change the size");
    const stream = oracleTokens("size to acur 4cd 1 1d2 change the size");
    const first = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 7, 6, 8, 7, 9, 8];
    const second = [0, 0, 1, 1, 2, 2, 3, 3, 5, 4, 7, 6, 8, 7, 9, 8];
    const viaFirst = foldBoundaryRegions(pdf, stream, first);
    expect(viaFirst.pdfTokens).toEqual(["size", "to", "acur", "4cd", "1", "1d2", "change", "the", "size"]);
    expect(viaFirst.streamTokens).toEqual(viaFirst.pdfTokens);
    const viaSecond = foldBoundaryRegions(pdf, stream, second);
    expect(viaSecond.pdfTokens).toEqual(["size", "to", "acur", "4cd", "11d2", "change", "the", "size"]);
    expect(viaSecond.streamTokens).toEqual(viaSecond.pdfTokens);
    expect(viaSecond).toMatchObject({ mergedRuns: 1, mergedTokens: 3 });
    // Two matched tokens anchor: the hunks stay apart and unfolded.
    const anchored = foldBoundaryRegions(["1", "d2", "1", "1", "e"], ["d2", "1", "1", "1e"], [1, 0, 2, 1, 3, 2]);
    expect(anchored.mergedRuns).toBe(0);
    expect(anchored.pdfTokens).toEqual(["1", "d2", "1", "1", "e"]);
    // A matched token beside a single hunk stays a token of its own.
    const edge = merged("we bound k1 α k e by", "we bound k1α ke by");
    expect(edge.pdfTokens).toEqual(["we", "bound", "k1αke", "by"]);
  });

  it("folds nothing whose characters differ, however slightly", () => {
    const changed = merged("the quick fox", "the slow fox");
    expect(changed).toMatchObject({ mergedRuns: 0, mergedTokens: 0, bounded: false });
    expect(changed.pdfTokens).toEqual(["the", "quick", "fox"]);
    expect(changed.streamTokens).toEqual(["the", "slow", "fox"]);
    // one extra character on one side and the hunk stays token for token
    const extra = merged("sum r n t d over", "sum ntd over");
    expect(extra.mergedRuns).toBe(0);
    expect(extra.pdfTokens).toEqual(["sum", "r", "n", "t", "d", "over"]);
    // a dropped word is a hunk with one empty side
    const dropped = merged("a sentence the print sets", "a sentence sets");
    expect(dropped.mergedRuns).toBe(0);
    expect(dropped.pdfTokens).toEqual(["a", "sentence", "the", "print", "sets"]);
  });

  it("only ever lifts the similarity", () => {
    const pdf = oracleTokens("in the erd os r enyi model k1 α k e is small and cliquewidth bounded, but a word is missing");
    const stream = oracleTokens("in the erdos renyi model k1α ke is small and clique width bounded, but a word is here missing");
    const plain = compareTokens(pdf, stream, 1).similarity;
    const folded = mergeTokenBoundaries(pdf, stream);
    const lifted = compareTokens(folded.pdfTokens, folded.streamTokens, 1).similarity;
    // `model` alone between two skewed hunks anchors nothing, but both
    // hunks fold on their own, so they fold on their own.
    expect(folded.mergedRuns).toBe(3);
    expect(folded.pdfTokens).toEqual(expect.arrayContaining(["erdosrenyi", "model", "k1αke"]));
    expect(lifted).toBeGreaterThan(plain);
    // the one real difference is still there
    expect(lifted).toBeLessThan(1);
    expect(compareTokens(folded.pdfTokens, folded.streamTokens, 1).divergence!.stream).toContain("here");
  });

  it("gives up, unchanged, on a pair less than half alike", () => {
    const pdf = Array.from({ length: 200 }, (unused, index) => `p${index}`);
    const stream = Array.from({ length: 200 }, (unused, index) => `s${index}`);
    expect(mergeTokenBoundaries(pdf, stream)).toEqual({ pdfTokens: pdf, streamTokens: stream, mergedRuns: 0, mergedTokens: 0, bounded: true });
    expect(compareTokens(pdf, stream, 0).similarity).toBeLessThan(BOUNDARY_MERGE_SEARCH_FLOOR);
    expect(mergeTokenBoundaries([], [])).toMatchObject({ mergedRuns: 0, bounded: false });
  });

  it("traces a script exactly as long as the plain distance, on random sequences", () => {
    // A deterministic generator: the pairs are the same every run.
    let seed = 0x2545f491;
    const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const alphabet = ["a", "b", "c", "d", "e"];
    for (let round = 0; round < 200; round += 1) {
      const a = Array.from({ length: Math.floor(random() * 40) }, () => alphabet[Math.floor(random() * alphabet.length)]!);
      const b = a.flatMap((token) => (random() < 0.3 ? [] : random() < 0.2 ? [token, alphabet[Math.floor(random() * 5)]!] : [token]));
      if (random() < 0.3) b.reverse();
      const total = a.length + b.length;
      const plain = compareTokens(a, b, 0).similarity;
      const distance = Math.round((1 - plain) * total);
      const matches = shortestScriptMatches(a, b, total)!;
      expect(matches).toBeDefined();
      expect(total - matches.length).toBe(distance);
      // monotone, and every pair an actual equality
      for (let index = 0; index < matches.length; index += 2) {
        expect(a[matches[index]!]).toBe(b[matches[index + 1]!]);
        if (index > 0) {
          expect(matches[index]!).toBeGreaterThan(matches[index - 2]!);
          expect(matches[index + 1]!).toBeGreaterThan(matches[index - 1]!);
        }
      }
      // and the bound: a script longer than allowed is not traced
      if (distance > 0) expect(shortestScriptMatches(a, b, distance - 1)).toBeUndefined();
    }
  });

  it("stays linear in memory and fast on a long, mostly-agreeing pair", () => {
    const size = 30_000;
    const a = Array.from({ length: size }, (unused, index) => `w${index}`);
    // every 500th token changed, every 1000th split in two
    const b = a.flatMap((token, index) =>
      index % 500 === 0 && index > 0 ? ["changed"] : index % 1000 === 250 ? [token.slice(0, 2), token.slice(2)] : [token]);
    const started = performance.now();
    const folded = mergeTokenBoundaries(a, b);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(folded.mergedRuns).toBe(30);
    expect(folded.bounded).toBe(false);
    expect(compareTokens(folded.pdfTokens, folded.streamTokens, 0.98).similarity).toBeGreaterThan(0.99);
  });
});

describe("margin line numbers", () => {
  // A LIPIcs-shaped page as pdf.js reads it: the text column runs from
  // x=90 to x=488, lineno's numbers sit at x=78 (2.65pt wide) on the line's
  // own baseline and come *after* the line's text in the item order, so the
  // plain join reads "merge-width1". Geometry is [x, y, width].
  const at = (text: string, x: number, y: number, width: number, eol: 0 | 1 = 0): ExtractedTextItem =>
    [text, eol, x, y, width];
  const lipicsPage: ExtractedTextItem[] = [
    at("Subgraph counting and merge-width", 90.71, 751.81, 287.26),
    at("1", 78.1, 751.81, 2.65),
    at("", 90.2, 728.48, 0, 1),
    at("Anonymous", 90.2, 728.48, 69.26),
    at("2", 78.1, 728.48, 2.65, 1),
    // a bare number: pdf.js gives the empty affiliation line its own item
    at("3", 78.1, 716.53, 2.65),
    at("", 114.8, 692.64, 0, 1),
    // a section heading whose number sits on the column's edge
    at("1", 90.71, 692.64, 5.2),
    at(" ", 95.91, 692.64, 8),
    at("Introduction", 103.9, 692.64, 60),
    at("4", 78.1, 692.64, 2.65, 1),
    // a number inside the text — a math item pdf.js splits out
    at("Given", 90.24, 677.38, 24),
    at(" ", 114.24, 677.38, 3),
    at("5", 117.3, 677.38, 5),
    at(" ", 122.3, 677.38, 3),
    at("vertices of bounded merge-width", 125.3, 677.38, 362.5),
    at("6", 78.1, 677.38, 2.65, 1),
    // a right-margin number, as lineno's [switch] sets on even pages
    at("and every step preserves the invariant.", 90.71, 665.42, 200),
    at("7", 498.2, 665.42, 5.3, 1),
    at("3", 290, 60, 5, 1), // the folio, inside the column: the folio rule's
  ];

  it("strips margin numbers, glued or bare, on either side, and keeps the text's own", () => {
    const assembled = assemblePdfText([lipicsPage]);
    expect(assembled.marginNumbers).toBe(6);
    expect(assembled.folioLines).toBe(1);
    expect(oracleTokens(assembled.text)).toEqual([
      "subgraph", "counting", "and", "merge", "width", "anonymous", "1", "introduction",
      "given", "5", "vertices", "of", "bounded", "merge", "width",
      "and", "every", "step", "preserves", "the", "invariant",
    ]);
  });

  it("hands a stripped item's line end to the item before it", () => {
    const stripped = stripMarginNumbers([[at("text", 90, 700, 50), at("2", 78, 700, 3, 1)], [at("next", 90, 688, 40, 1)]], () => false);
    expect(stripped.stripped).toBe(1);
    expect(stripped.lines).toEqual([[["text", 1, 90, 700, 50]], [["next", 1, 90, 688, 40]]]);
    // a bare number alone on its line leaves an empty line, not a lost break
    const bare = stripMarginNumbers([[at("text", 90, 700, 50, 1)], [at("3", 78, 688, 3, 1)], [at("next", 90, 676, 40, 1)]], () => false);
    expect(bare.lines.map((line) => line.map((item) => item[0]).join(""))).toEqual(["text", "", "next"]);
  });

  it("never strips an item without geometry, or one within the tolerance of the column", () => {
    const bare: ExtractedTextItem[] = [["Some text", 0], ["4", 1], ["More text", 1]];
    expect(assemblePdfText([bare]).marginNumbers).toBe(0);
    expect(assemblePdfText([bare]).text).toBe("Some text4\nMore text");
    const edge = [
      at("Some text of the column", 90, 700, 200, 1),
      at("9", 90 - MARGIN_NUMBER_TOLERANCE - 4, 688, 4, 1), // ends exactly at the tolerance
    ];
    expect(assemblePdfText([edge]).marginNumbers).toBe(0);
  });

  it("measures the column without the running head, whose right-set folio would widen it", () => {
    const page = (folio: string, body: string): ExtractedTextItem[] => [
      at("Anonymous", 90.71, 771.59, 55.49),
      at(" ", 146.2, 771.59, 362.42),
      at(`XX:${folio}`, 508.62, 771.59, 24.29, 1),
      at(body, 90.71, 733.28, 396.85),
      at("81", 498.2, 733.28, 8, 1),
    ];
    const assembled = assemblePdfText([page("3", "First page text."), page("5", "Second page text.")]);
    expect(assembled.headerLines).toBe(2);
    expect(assembled.marginNumbers).toBe(2);
    expect(assembled.text).toBe("First page text.\nSecond page text.");
  });

  it("keeps a table of small integers whose cells pdf.js splits into items", () => {
    // Every cell is digits-only and every cell sits inside the column.
    const page: ExtractedTextItem[] = [
      at("The coefficients, row by row:", 90, 700, 150, 1),
      at("1", 90, 688, 5), at("   ", 95, 688, 15), at("1", 110, 688, 5, 1),
      at("2", 90, 676, 5), at("   ", 95, 676, 15), at("3", 110, 676, 5, 1),
      at("and the text resumes here at the column's full width.", 90, 664, 380, 1),
    ];
    const assembled = assemblePdfText([page]);
    expect(assembled.marginNumbers).toBe(0);
    expect(oracleTokens(assembled.text)).toEqual(oracleTokens(
      "The coefficients, row by row: 1 1 2 3 and the text resumes here at the column's full width.",
    ));
  });
});

describe("relocated paragraphs", () => {
  const paragraph = (index: number): string =>
    `Paragraph number ${index} states a genuine claim about the construction and its consequences.`;
  const footnote = "1 A footnote the print sets at the page bottom and the stream at the very end.";

  it("takes a run the PDF carries off the PDF side and adds nothing to the stream side", () => {
    const pdf = oracleTokens([paragraph(1), footnote, paragraph(2)].join(" "));
    const stream = oracleTokens([paragraph(1), paragraph(2)].join(" "));
    const relocation = relocateRuns(pdf, stream, [{ text: footnote }]);
    expect(relocation.matched).toBe(1);
    expect(relocation.matchedTokens).toBe(oracleTokens(footnote).length);
    expect(relocation.unmatched).toEqual([]);
    expect(relocation.pdfTokens).toEqual(stream);
    expect(relocation.streamTokens).toEqual(stream);
  });

  it("appends a run the PDF lacks to the stream side, where it still counts", () => {
    const pdf = oracleTokens([paragraph(1), paragraph(2)].join(" "));
    const stream = oracleTokens([paragraph(1), paragraph(2)].join(" "));
    const relocation = relocateRuns(pdf, stream, [{ text: footnote }]);
    expect(relocation.matched).toBe(0);
    expect(relocation.unmatched).toEqual([{ text: footnote }]);
    expect(relocation.pdfTokens).toEqual(pdf);
    expect(relocation.streamTokens).toEqual([...stream, ...oracleTokens(footnote)]);
    expect(relocation.unmatchedTokens).toBe(oracleTokens(footnote).length);
  });

  it("ignores a relocated paragraph with no tokens", () => {
    const pdf = ["a", "b"];
    expect(relocateRuns(pdf, pdf, [{ text: "†" }, { text: "" }])).toMatchObject({ matched: 0, unmatched: [], pdfTokens: pdf, streamTokens: pdf });
  });
});

describe("the judgment", () => {
  const line = (text: string): ExtractedTextItem => [text, 1];
  // Paragraphs that open every page must differ in more than a digit, or
  // the running-head rule takes them for a head repeated across pages.
  const paragraph = (index: number): string =>
    `${["First", "Second", "Third", "Fourth"][index - 1]} paragraph states a genuine claim about the construction and its consequences.`;
  const footnote = "1 A footnote the print sets at the page bottom and the stream at the very end.";
  // Two pages, a footnote at the bottom of the first; the stream sets it
  // last, after every body paragraph.
  const pdfPages: ExtractedTextItem[][] = [
    [line(paragraph(1)), line(paragraph(2)), line(footnote), line("1")],
    [line(paragraph(3)), line(paragraph(4)), line("2")],
  ];
  const body = [paragraph(1), paragraph(2), paragraph(3), paragraph(4)].join("\n");

  it("is unmoved by a relocation the PDF carries", () => {
    const judged = judgeWebOracle({
      pdfPages,
      stream: { text: body, unreferenced: [], relocated: [{ text: footnote }] },
      floor: 0.98,
    });
    expect(judged.passes).toBe(true);
    expect(judged.verdict).toEqual({ similarity: 1 });
    expect(judged.firstDifference).toBeUndefined();
    expect(judged.relocation.matched).toBe(1);
    expect(judged.assembled.folioLines).toBe(2);
    expect(judged.pdfTokenCount).toBe(judged.pdfTokens.length + oracleTokens(footnote).length);
    // Undeclared, the same move costs the paper twice the footnote's length.
    const undeclared = judgeWebOracle({
      pdfPages,
      stream: { text: `${body}\n${footnote}`, unreferenced: [], relocated: [] },
      floor: 0.98,
    });
    expect(undeclared.passes).toBe(false);
    expect(undeclared.verdict.similarity).toBeLessThan(0.98);
  });

  it("counts a relocated paragraph the PDF lacks as divergence", () => {
    const judged = judgeWebOracle({
      pdfPages: [[line(paragraph(1)), line(paragraph(2))], [line(paragraph(3)), line(paragraph(4))]],
      stream: { text: body, unreferenced: [], relocated: [{ text: footnote }] },
      floor: 0.98,
    });
    expect(judged.passes).toBe(false);
    expect(judged.relocation.unmatched).toEqual([{ text: footnote }]);
    expect(judged.verdict.divergence).toBeDefined();
    expect(judged.firstDifference!.index).toBe(judged.pdfTokens.length);
    expect(judged.firstDifference!.stream).toContain("1 a footnote the print");
  });

  it("settles a relocated footnote the PDF tokenizes differently, charging it nowhere", () => {
    // The footnote's `σρ` is one pdf.js item and two stream tokens; matched
    // token for token it would have counted twice — once left on the PDF
    // side, once appended to the stream side.
    const skewed = "2 Here σρ denotes the composed permutation, as in the previous section.";
    const streamed = "2 Here σ ρ denotes the composed permutation, as in the previous section.";
    const judged = judgeWebOracle({
      pdfPages: [[line(paragraph(1)), line(paragraph(2)), line(skewed), line("1")], [line(paragraph(3)), line(paragraph(4)), line("2")]],
      stream: { text: body, unreferenced: [], relocated: [{ text: streamed }] },
      floor: 0.98,
    });
    expect(judged.relocation.matched).toBe(1);
    expect(judged.relocation.unmatched).toEqual([]);
    expect(judged.relocation.matchedTokens).toBe(oracleTokens(skewed).length);
    expect(judged.passes).toBe(true);
    expect(judged.verdict).toEqual({ similarity: 1 });
  });

  it("compares and reports the boundary-merged sequences", () => {
    const judged = judgeWebOracle({
      pdfPages: [[line(paragraph(1)), line("We bound k1 α k e by the cliquewidth of the"), line("Erd os r enyi graph.")]],
      stream: { text: `${paragraph(1)}\nWe bound k1α ke by the clique width of the Erdos renyi graph.`, unreferenced: [], relocated: [] },
      floor: 0.98,
    });
    // 4+2, 1+2 and 4+2 tokens became one each: nine folded away
    expect(judged.merge).toMatchObject({ mergedRuns: 3, mergedTokens: 9, bounded: false });
    const opening = oracleTokens(paragraph(1));
    expect(judged.pdfTokens).toEqual([...opening, "we", "bound", "k1αke", "by", "the", "cliquewidth", "of", "the", "erdosrenyi", "graph"]);
    expect(judged.streamTokens).toEqual(judged.pdfTokens);
    expect(judged.passes).toBe(true);
    expect(judged.firstDifference).toBeUndefined();
    // With a real difference the location indexes the merged sequence.
    const differing = judgeWebOracle({
      pdfPages: [[line(paragraph(1)), line("We bound k1 α k e by the cliquewidth of the"), line("Erd os r enyi graph.")]],
      stream: { text: `${paragraph(1)}\nWe bound k1α ke by the clique width of any Erdos renyi graph.`, unreferenced: [], relocated: [] },
      floor: 0.98,
    });
    expect(differing.firstDifference).toMatchObject({ index: opening.length + 7 });
    // The skewed name shares its hunk with the real difference and stays
    // unfolded: a hunk folds only when the whole of it is the same text.
    expect(differing.firstDifference!.pdf).toContain("cliquewidth of the erd os r enyi graph");
    expect(differing.firstDifference!.stream).toContain("cliquewidth of any erdos renyi graph");
    expect(differing.merge.mergedRuns).toBe(2);
  });

  it("does not subtract a trial typesetting of a footnote as an unreferenced capture", () => {
    // \footnote measures its text before setting it; that capture is
    // unreferenced but the surface shows the text, in the endnotes.
    const judged = judgeWebOracle({
      pdfPages,
      stream: { text: body, unreferenced: [{ text: footnote }], relocated: [{ text: footnote }] },
      floor: 0.98,
    });
    expect(judged.subtraction.omitted).toEqual([]);
    expect(judged.subtraction.removedTokens).toBe(0);
    expect(judged.passes).toBe(true);
  });

  it("still names an honest margin note and enforces the budget", () => {
    const note = "A marginal note that only print shows";
    const judged = judgeWebOracle({
      pdfPages: [[line(paragraph(1)), line(note), line(paragraph(2)), line(paragraph(3)), line(paragraph(4))]],
      stream: { text: body, unreferenced: [{ text: note }], relocated: [] },
      floor: 0.98,
    });
    expect(judged.subtraction.omitted).toEqual([{ text: note }]);
    expect(judged.subtraction.overBudget).toBe(false);
    expect(judged.passes).toBe(true);
    expect(judged.verdict).toEqual({ similarity: 1 });
  });
});
