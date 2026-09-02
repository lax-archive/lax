import { describe, expect, it } from "vitest";
import {
  firstCommentIndex,
  isSubmissionMarkId,
  markIdKind,
  markIdPackage,
  markIdProblem,
  parseMarker,
  rewriteMarkers,
  texRewriteOrder,
} from "../../src/submission-validation/paper/rewrite.js";

function rewriteOne(text: string) {
  const result = rewriteMarkers([{ path: "main.tex", text }]);
  return { ...result, text: result.rewritten[0]!.text };
}

describe("paper marker grammar", () => {
  it("rewrites an own-line marker pair into numbered laxmarks", () => {
    const { text, marks, problems } = rewriteOne(
      "\\section{A}\n% lax begin Lax261.Treewidth\nThe definition.\n% lax end\n",
    );
    expect(problems).toEqual([]);
    expect(text).toBe("\\section{A}\n\\laxmark{b}{1}%\nThe definition.\n\\laxmark{e}{1}%\n");
    expect(marks).toEqual([{ n: 1, id: "Lax261.Treewidth", file: "main.tex", line: 2 }]);
  });

  it("keeps the text before an inline marker and replaces from the % on", () => {
    const { text, problems } = rewriteOne(
      "A sentence. % lax begin Lax261.A\nMore.% lax end Lax261.A\n",
    );
    expect(problems).toEqual([]);
    // the trailing `%` eats the newline exactly as the comment did
    expect(text).toBe("A sentence. \\laxmark{b}{1}%\nMore.\\laxmark{e}{1}%\n");
  });

  it("keeps indentation and accepts `lax end` with or without an id", () => {
    const { text, problems } = rewriteOne(
      "    % lax begin Lax261.A\n\t% lax end Lax261.A\n% lax begin Lax261.B\n% lax end\n",
    );
    expect(problems).toEqual([]);
    expect(text).toBe("    \\laxmark{b}{1}%\n\t\\laxmark{e}{1}%\n\\laxmark{b}{2}%\n\\laxmark{e}{2}%\n");
  });

  it("ignores extra text after the marker", () => {
    const { marks, text, problems } = rewriteOne(
      "% lax begin Lax261.A  -- the treewidth definition\n% lax end Lax261.A (closes it)\n",
    );
    expect(problems).toEqual([]);
    expect(marks.map((mark) => mark.id)).toEqual(["Lax261.A"]);
    expect(text).toBe("\\laxmark{b}{1}%\n\\laxmark{e}{1}%\n");
  });

  it("treats \\% as a literal percent sign and \\\\% as a comment", () => {
    expect(firstCommentIndex("50\\% of all % lax")).toBe(12);
    expect(firstCommentIndex("a \\% b")).toBe(-1);
    expect(firstCommentIndex("line\\\\% comment")).toBe(6);
    expect(firstCommentIndex("no comment here")).toBe(-1);

    const literal = rewriteOne("100\\% lax begin Lax261.A\n");
    expect(literal.marks).toEqual([]);
    expect(literal.problems).toEqual([]);
    expect(literal.text).toBe("100\\% lax begin Lax261.A\n");

    const escaped = rewriteOne("break\\\\% lax begin Lax261.A\n% lax end\n");
    expect(escaped.problems).toEqual([]);
    expect(escaped.text).toBe("break\\\\\\laxmark{b}{1}%\n\\laxmark{e}{1}%\n");
  });

  it("leaves ordinary comments and non-lax words alone", () => {
    const { text, marks, problems } = rewriteOne(
      "% a plain comment\n%% lax begin Lax261.A\n% laxative begin Lax261.A\n% relax begin Lax261.A\n",
    );
    expect(marks).toEqual([]);
    expect(problems).toEqual([]);
    expect(text).toBe(
      "% a plain comment\n%% lax begin Lax261.A\n% laxative begin Lax261.A\n% relax begin Lax261.A\n",
    );
  });

  it("refuses a `% lax` comment with an unknown keyword rather than dropping it", () => {
    const { problems, marks } = rewriteOne("% lax start Lax261.A\n% lax\n% lax begin\n");
    expect(marks).toEqual([]);
    expect(problems).toEqual([
      "main.tex:1: a `% lax` comment must be `% lax begin <id>` or `% lax end`",
      "main.tex:2: a `% lax` comment must be `% lax begin <id>` or `% lax end`",
      "main.tex:3: `lax begin` needs an id",
    ]);
  });

  it("parses comment bodies", () => {
    expect(parseMarker(" lax begin Lax261.A")).toEqual({ keyword: "begin", id: "Lax261.A" });
    expect(parseMarker("lax end")).toEqual({ keyword: "end" });
    expect(parseMarker("\tlax end Lax261.A trailing")).toEqual({ keyword: "end", id: "Lax261.A" });
    expect(parseMarker(" laxx begin A")).toBeUndefined();
    expect(parseMarker(" nothing")).toBeUndefined();
    expect(parseMarker(" lax beginning A")?.error).toContain("must be");
  });
});

describe("paper marker nesting", () => {
  it("closes the innermost open marker first", () => {
    const { text, marks, problems } = rewriteOne(
      "% lax begin Lax261.Outer\n% lax begin Lax261.Inner\nx\n% lax end\n% lax end\n",
    );
    expect(problems).toEqual([]);
    expect(marks.map((mark) => [mark.n, mark.id])).toEqual([[1, "Lax261.Outer"], [2, "Lax261.Inner"]]);
    expect(text).toBe("\\laxmark{b}{1}%\n\\laxmark{b}{2}%\nx\n\\laxmark{e}{2}%\n\\laxmark{e}{1}%\n");
  });

  it("reports an end whose id is not the innermost open marker, but still closes it", () => {
    const { text, problems } = rewriteOne(
      "% lax begin Lax261.Outer\n% lax begin Lax261.Inner\n% lax end Lax261.Outer\n% lax end\n",
    );
    expect(problems).toEqual([
      "main.tex:3: `lax end Lax261.Outer` does not match the innermost open marker Lax261.Inner (main.tex:2)",
    ]);
    expect(text).toBe("\\laxmark{b}{1}%\n\\laxmark{b}{2}%\n\\laxmark{e}{2}%\n\\laxmark{e}{1}%\n");
  });

  it("reports an end with nothing open", () => {
    const { text, problems } = rewriteOne("text\n% lax end\n");
    expect(problems).toEqual(["main.tex:2: `lax end` with no open marker"]);
    expect(text).toBe("text\n% lax end\n");
  });

  it("reports every marker still open at the end of the file", () => {
    const { problems } = rewriteOne("% lax begin Lax261.A\n% lax begin Lax261.B\n");
    expect(problems).toEqual([
      "main.tex:1: marker Lax261.A is never closed in this file",
      "main.tex:2: marker Lax261.B is never closed in this file",
    ]);
  });

  it("balances per file: an input file cannot close its parent's marker", () => {
    const { problems } = rewriteMarkers([
      { path: "main.tex", text: "% lax begin Lax261.A\n\\input{section}\n" },
      { path: "section.tex", text: "text\n% lax end\n" },
    ]);
    expect(problems).toEqual([
      "main.tex:1: marker Lax261.A is never closed in this file",
      "section.tex:2: `lax end` with no open marker",
    ]);
  });

  it("does not open a marker whose id has the wrong shape", () => {
    const { marks, problems } = rewriteOne("% lax begin Lax261\n% lax end\n");
    expect(marks).toEqual([]);
    expect(problems).toEqual([
      "main.tex:1: `Lax261` is a package name, not a concept or proof id; mark Lax261.Treewidth for a concept, or lax-261 for the whole submission",
      "main.tex:2: `lax end` with no open marker",
    ]);
  });
});

describe("paper marker numbering", () => {
  it("normalizes CRLF before rewriting", () => {
    const { text, marks, problems } = rewriteOne("a\r\n% lax begin Lax261.A\r\nb\r% lax end\r\n");
    expect(problems).toEqual([]);
    expect(text).toBe("a\n\\laxmark{b}{1}%\nb\n\\laxmark{e}{1}%\n");
    expect(marks[0]).toMatchObject({ line: 2 });
  });

  it("numbers marks across files in the order the files are handed in", () => {
    const { rewritten, marks, problems } = rewriteMarkers([
      { path: "main.tex", text: "% lax begin Lax261.A\n% lax end\n" },
      { path: "b/second.tex", text: "% lax begin Lax261Proofs.P\n% lax end\n% lax begin Lax261.C\n% lax end\n" },
      { path: "a/third.tex", text: "% lax begin Lax42.D\n% lax end\n" },
    ]);
    expect(problems).toEqual([]);
    expect(marks).toEqual([
      { n: 1, id: "Lax261.A", file: "main.tex", line: 1 },
      { n: 2, id: "Lax261Proofs.P", file: "b/second.tex", line: 1 },
      { n: 3, id: "Lax261.C", file: "b/second.tex", line: 3 },
      { n: 4, id: "Lax42.D", file: "a/third.tex", line: 1 },
    ]);
    expect(rewritten.map((file) => file.path)).toEqual(["main.tex", "b/second.tex", "a/third.tex"]);
    expect(rewritten[2]!.text).toBe("\\laxmark{b}{4}%\n\\laxmark{e}{4}%\n");
  });

  it("orders the entry file first and the remaining .tex files by path", () => {
    expect(
      texRewriteOrder("main.tex", ["z.tex", "refs.bib", "main.tex", "a/b.tex", "fig.png", "a.tex", "notes.tex.bak"]),
    ).toEqual(["main.tex", "a.tex", "a/b.tex", "z.tex"]);
    expect(texRewriteOrder("src/paper.tex", ["src/paper.tex", "src/intro.tex"])).toEqual([
      "src/paper.tex",
      "src/intro.tex",
    ]);
  });
});

describe("mark ids", () => {
  it("accepts concept, proof, and statement-shaped ids of Lax packages", () => {
    expect(markIdProblem("Lax261.Treewidth")).toBeUndefined();
    expect(markIdProblem("Lax261Proofs.Q")).toBeUndefined();
    // statement-like ids are fine syntactically; the resolver rejects them
    expect(markIdProblem("Lax261.Treewidth.claim")).toBeUndefined();
    // the offline placeholder packages are legal spellings
    expect(markIdProblem("Lax0.Treewidth")).toBeUndefined();
    expect(markIdProblem("Lax0Proofs.Q")).toBeUndefined();
  });

  it("accepts submission ids, including the offline placeholder", () => {
    expect(markIdProblem("lax-261")).toBeUndefined();
    expect(markIdProblem("lax-0")).toBeUndefined();
    expect(isSubmissionMarkId("lax-261")).toBe(true);
    expect(isSubmissionMarkId("Lax261")).toBe(false);
    expect(markIdProblem("lax-01")).toContain("is neither a Lean name nor a submission id");
    expect(markIdProblem("lax-")).toContain("is neither a Lean name nor a submission id");
    expect(markIdProblem("LAX-261")).toContain("is neither a Lean name nor a submission id");
  });

  it("rejects non-names, package roots, and non-Lax packages", () => {
    expect(markIdProblem("not a name")).toContain("is neither a Lean name nor a submission id");
    expect(markIdProblem("Lax261.")).toContain("is neither a Lean name nor a submission id");
    expect(markIdProblem("Lax261")).toContain("is a package name, not a concept or proof id");
    // a package root points at the submission id that names the whole record
    expect(markIdProblem("Lax261")).toContain("mark Lax261.Treewidth for a concept, or lax-261 for the whole submission");
    expect(markIdProblem("Lax261Proofs")).toContain("or lax-261 for the whole submission");
    expect(markIdProblem("Lax0")).toContain("or lax-0 for the whole submission");
    expect(markIdProblem("Mathlib")).toContain("mark Lax261.Treewidth, not Lax261");
    expect(markIdProblem("Mathlib.Order.Basic")).toContain("does not belong to a Lax package");
    expect(markIdProblem("Lax01.A")).toContain("does not belong to a Lax package");
    expect(markIdProblem("lax261.A")).toContain("does not belong to a Lax package");
  });

  it("reads the kind and package off the id", () => {
    expect(markIdKind("Lax261.Treewidth")).toBe("concept");
    expect(markIdKind("Lax261Proofs.Q")).toBe("proof");
    expect(markIdKind("Lax0Proofs.Q.R")).toBe("proof");
    expect(markIdKind("lax-261")).toBe("submission");
    expect(markIdKind("lax-0")).toBe("submission");
    expect(markIdPackage("Lax261.Treewidth")).toBe("Lax261");
    expect(markIdPackage("Lax261Proofs.Q.R")).toBe("Lax261Proofs");
  });
});
