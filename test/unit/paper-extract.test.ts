import { describe, expect, it } from "vitest";
import type { PaperMarkTableEntry } from "../../src/submission-validation/contracts.js";
import type {
  ExtractedDestination,
  ExtractedPdf,
} from "../../src/submission-validation/paper/extract-destinations.js";
import { matchDestinations } from "../../src/submission-validation/paper/extract.js";

const TABLE: PaperMarkTableEntry[] = [
  { n: 1, id: "Lax261.Treewidth", file: "main.tex", line: 3 },
  { n: 2, id: "Lax261Proofs.Q", file: "section.tex", line: 8 },
];

function destination(
  n: number,
  kind: "b" | "e",
  overrides: Partial<Omit<ExtractedDestination, "n" | "kind" | "name">> = {},
): ExtractedDestination {
  const mode = overrides.mode ?? "v";
  return { name: `lax.${n}.${kind}.${mode}`, n, kind, mode, page: 1, x: 72, y: 700, ...overrides };
}

function pdf(destinations: ExtractedDestination[], overrides: Partial<ExtractedPdf> = {}): ExtractedPdf {
  return { pages: 2, pageSizes: [[612, 792], [612, 792]], destinations, unknown: [], ...overrides };
}

describe("paper destination matching", () => {
  it("pairs one begin and one end per mark, in mark-number order, carrying mode and coordinates", () => {
    const result = matchDestinations(
      TABLE,
      pdf([
        // handed in out of order: the mark number, not the PDF, orders marks
        destination(2, "e", { mode: "h", page: 2, x: 300.5, y: 120.25 }),
        destination(1, "e", { page: 1, x: 72, y: 500 }),
        destination(2, "b", { mode: "h", page: 2, x: 150, y: 640 }),
        destination(1, "b", { page: 1, x: 72, y: 700 }),
      ]),
    );
    expect(result.problems).toEqual([]);
    expect(result.marks).toEqual([
      {
        n: 1,
        id: "Lax261.Treewidth",
        begin: { page: 1, x: 72, y: 700, mode: "v" },
        end: { page: 1, x: 72, y: 500, mode: "v" },
      },
      {
        n: 2,
        id: "Lax261Proofs.Q",
        begin: { page: 2, x: 150, y: 640, mode: "h" },
        end: { page: 2, x: 300.5, y: 120.25, mode: "h" },
      },
    ]);
  });

  it("reports a mark with a missing half as one finding naming the id and its marker line", () => {
    const missingBegin = matchDestinations(TABLE, pdf([destination(1, "e"), destination(2, "b"), destination(2, "e")]));
    expect(missingBegin.marks.map((mark) => mark.n)).toEqual([2]);
    expect(missingBegin.problems).toHaveLength(1);
    expect(missingBegin.problems[0]).toContain("main.tex:3: the marker for Lax261.Treewidth left no begin destination");
    expect(missingBegin.problems[0]).toContain("verbatim");

    const missingEnd = matchDestinations(TABLE, pdf([destination(1, "b"), destination(1, "e"), destination(2, "b")]));
    expect(missingEnd.problems).toHaveLength(1);
    expect(missingEnd.problems[0]).toContain("section.tex:8: the marker for Lax261Proofs.Q left no end destination");

    // both halves gone together is still one finding
    const missingBoth = matchDestinations(TABLE, pdf([destination(1, "b"), destination(1, "e")]));
    expect(missingBoth.problems).toHaveLength(1);
    expect(missingBoth.problems[0]).toContain("left no begin and end destination");
  });

  it("reports a destination the PDF carries twice", () => {
    const result = matchDestinations(
      TABLE,
      pdf([destination(1, "b"), destination(1, "b"), destination(1, "e"), destination(2, "b"), destination(2, "e")]),
    );
    expect(result.problems).toEqual(["the PDF carries destination lax.1.b.v twice"]);
  });

  it("reports a mark number the rewriter never emitted", () => {
    const result = matchDestinations(
      TABLE,
      pdf([
        destination(1, "b"), destination(1, "e"),
        destination(2, "b"), destination(2, "e"),
        destination(7, "b"), destination(7, "e"),
      ]),
    );
    expect(result.marks).toHaveLength(2);
    expect(result.problems).toEqual(["the PDF carries destinations for a mark number lax never emitted: 7"]);
  });

  it("reports every lax destination the reader could not parse", () => {
    const result = matchDestinations(
      TABLE,
      pdf([destination(1, "b"), destination(1, "e"), destination(2, "b"), destination(2, "e")], {
        unknown: ["lax.weird", "lax.1.b"],
      }),
    );
    expect(result.problems).toEqual([
      "the PDF carries a destination lax cannot read: lax.weird",
      "the PDF carries a destination lax cannot read: lax.1.b",
    ]);
  });

  it("reports a destination pointing past the last page", () => {
    const result = matchDestinations(
      TABLE,
      pdf([
        destination(1, "b"), destination(1, "e", { page: 3 }),
        destination(2, "b"), destination(2, "e"),
      ]),
    );
    expect(result.problems).toEqual(["destination lax.1.e.v points at page 3 of 2"]);
  });

  it("never lets coordinates order marks: an end above its begin is fine", () => {
    // two markers closing back to back in vertical mode sit at the same
    // point, and a column break can put the end higher on the same page
    const result = matchDestinations(
      TABLE,
      pdf([
        destination(1, "b", { page: 1, y: 100 }),
        destination(1, "e", { page: 1, y: 700 }),
        destination(2, "b", { page: 2, x: 400, y: 300 }),
        destination(2, "e", { page: 2, x: 400, y: 300 }),
      ]),
    );
    expect(result.problems).toEqual([]);
    expect(result.marks[0]!.begin.y).toBe(100);
    expect(result.marks[0]!.end.y).toBe(700);
  });

  it("matches an empty table against a PDF without lax destinations", () => {
    expect(matchDestinations([], pdf([]))).toEqual({ marks: [], problems: [] });
  });
});
