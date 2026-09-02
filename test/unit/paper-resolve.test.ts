import { describe, expect, it } from "vitest";
import type { LocatedMark } from "../../src/submission-validation/paper/extract.js";
import { resolvePaperMarks, type MarkResolutionContext } from "../../src/submission-validation/paper/resolve.js";

const CONTEXT: MarkResolutionContext = {
  submissionId: "lax-261",
  conceptPackage: "Lax261",
  own: { concepts: ["Lax261.Treewidth"], proofs: ["Lax261Proofs.Q"] },
  required: new Map([
    ["Lax42", { concepts: ["Lax42.Graph"], proofs: [] }],
    ["Lax42Proofs", { concepts: [], proofs: ["Lax42Proofs.Main"] }],
  ]),
};

function located(id: string, n = 1): LocatedMark {
  return {
    n,
    id,
    begin: { page: 1, x: 72, y: 700, mode: "v" },
    end: { page: 1, x: 72, y: 600 + n, mode: "h" },
  };
}

describe("paper mark resolution", () => {
  it("resolves the submission's own concepts and proofs", () => {
    const result = resolvePaperMarks([located("Lax261.Treewidth", 1), located("Lax261Proofs.Q", 2)], CONTEXT);
    expect(result.problems).toEqual([]);
    expect(result.marks).toEqual([
      {
        id: "Lax261.Treewidth",
        kind: "concept",
        begin: { page: 1, x: 72, y: 700, mode: "v" },
        end: { page: 1, x: 72, y: 601, mode: "h" },
      },
      {
        id: "Lax261Proofs.Q",
        kind: "proof",
        begin: { page: 1, x: 72, y: 700, mode: "v" },
        end: { page: 1, x: 72, y: 602, mode: "h" },
      },
    ]);
  });

  it("resolves concepts and proofs of directly required packages", () => {
    const result = resolvePaperMarks([located("Lax42.Graph", 1), located("Lax42Proofs.Main", 2)], CONTEXT);
    expect(result.problems).toEqual([]);
    expect(result.marks.map((mark) => [mark.id, mark.kind])).toEqual([
      ["Lax42.Graph", "concept"],
      ["Lax42Proofs.Main", "proof"],
    ]);
  });

  it("refuses a package the submission does not require directly", () => {
    const result = resolvePaperMarks([located("Lax7.Anything"), located("Lax42Proofs.Main", 2)], CONTEXT);
    expect(result.marks.map((mark) => mark.id)).toEqual(["Lax42Proofs.Main"]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("mark Lax7.Anything: Lax7 is not a package this submission requires directly");
    expect(result.problems[0]).toContain("citation, not a mark");
  });

  it("refuses an id a known package has no card for", () => {
    const foreign = resolvePaperMarks([located("Lax42.Nope")], CONTEXT);
    expect(foreign.marks).toEqual([]);
    expect(foreign.problems).toEqual(["mark Lax42.Nope: package Lax42 has no concept with that id"]);

    const ownProof = resolvePaperMarks([located("Lax261Proofs.Nope")], CONTEXT);
    expect(ownProof.problems).toEqual([
      "mark Lax261Proofs.Nope: this submission has no proof with that id (only proofs with a frontmatter have a card)",
    ]);

    // a proof package offers no concepts: a concept id under it is unknown
    const wrongKind = resolvePaperMarks([located("Lax42.Main")], CONTEXT);
    expect(wrongKind.problems).toEqual(["mark Lax42.Main: package Lax42 has no concept with that id"]);
  });

  it("names the concept when a statement id is marked", () => {
    const own = resolvePaperMarks([located("Lax261.Treewidth.monotone")], CONTEXT);
    expect(own.marks).toEqual([]);
    expect(own.problems).toEqual([
      "mark Lax261.Treewidth.monotone: statements are not markable; the concept is the unit — mark Lax261.Treewidth instead",
    ]);

    const foreign = resolvePaperMarks([located("Lax42.Graph.deep.claim")], CONTEXT);
    expect(foreign.problems).toEqual([
      "mark Lax42.Graph.deep.claim: statements are not markable; the concept is the unit — mark Lax42.Graph instead",
    ]);
  });

  it("resolves the same id every time it is marked", () => {
    const result = resolvePaperMarks(
      [located("Lax261.Treewidth", 1), located("Lax42.Graph", 2), located("Lax261.Treewidth", 3)],
      CONTEXT,
    );
    expect(result.problems).toEqual([]);
    expect(result.marks.map((mark) => mark.id)).toEqual(["Lax261.Treewidth", "Lax42.Graph", "Lax261.Treewidth"]);
    expect(result.marks[0]!.end.y).toBe(601);
    expect(result.marks[2]!.end.y).toBe(603);
  });

  it("resolves nothing against an empty context without complaint", () => {
    expect(
      resolvePaperMarks([], {
        submissionId: "lax-0",
        conceptPackage: "Lax0",
        own: { concepts: [], proofs: [] },
        required: new Map(),
      }),
    ).toEqual({ marks: [], problems: [] });
  });

  it("resolves the submission itself and directly required submissions as submission marks", () => {
    const result = resolvePaperMarks([located("lax-261", 1), located("lax-42", 2)], CONTEXT);
    expect(result.problems).toEqual([]);
    expect(result.marks).toEqual([
      {
        id: "lax-261",
        kind: "submission",
        begin: { page: 1, x: 72, y: 700, mode: "v" },
        end: { page: 1, x: 72, y: 601, mode: "h" },
      },
      {
        id: "lax-42",
        kind: "submission",
        begin: { page: 1, x: 72, y: 700, mode: "v" },
        end: { page: 1, x: 72, y: 602, mode: "h" },
      },
    ]);
  });

  it("resolves the offline placeholder as the scaffold's own submission", () => {
    const result = resolvePaperMarks([located("lax-0")], {
      submissionId: "lax-0",
      conceptPackage: "Lax0",
      own: { concepts: [], proofs: [] },
      required: new Map(),
    });
    expect(result.problems).toEqual([]);
    expect(result.marks.map((mark) => [mark.id, mark.kind])).toEqual([["lax-0", "submission"]]);
  });

  it("refuses a submission the paper's packages do not require directly", () => {
    const result = resolvePaperMarks([located("lax-7"), located("lax-42", 2)], CONTEXT);
    expect(result.marks.map((mark) => mark.id)).toEqual(["lax-42"]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain(
      "mark lax-7: lax-7 is not this submission or one whose package this submission requires directly",
    );
    expect(result.problems[0]).toContain("citation, not a mark");
  });
});
