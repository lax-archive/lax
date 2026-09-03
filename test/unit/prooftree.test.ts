import { describe, expect, it } from "vitest";
import {
  isBackgroundOnly,
  selectProofTree,
  type NetworkProof,
} from "../../src/cli/prooftree.js";

function proof(
  id: string,
  conclusion: string,
  assumptions: string[],
): NetworkProof {
  return {
    id,
    submissionId: "lax-1",
    path: `proofs/Lax1Proofs/${id}.lean`,
    conclusion,
    assumptions,
  };
}

describe("proof-tree selection", () => {
  it("prefers a proof whose complete assumption tree is grounded", () => {
    const selection = selectProofTree(
      ["B"],
      ["A", "B", "C"],
      [
        proof("proofA", "A", []),
        proof("badB", "B", ["C"]),
        proof("goodB", "B", ["A"]),
      ],
      () => 0,
    );

    expect(selection.unresolved).toEqual([]);
    expect(selection.order.map((entry) => entry.id)).toEqual(["proofA", "goodB"]);
    expect(selection.order.every((entry) => entry.selection === "grounded")).toBe(true);
  });

  it("uses the chooser when several grounded proofs are available", () => {
    const selection = selectProofTree(
      ["A"],
      ["A"],
      [proof("first", "A", []), proof("second", "A", [])],
      (length) => length - 1,
    );

    expect(selection.order.map((entry) => entry.id)).toEqual(["second"]);
    expect(selection.unresolved).toEqual([]);
  });

  it("chooses among every proof that is grounded at the fixed point", () => {
    const selection = selectProofTree(
      ["B"],
      ["A", "B", "C"],
      [
        proof("proofA", "A", []),
        proof("viaA", "B", ["A"]),
        proof("viaC", "B", ["C"]),
        proof("proofC", "C", ["A"]),
      ],
      (length) => length - 1,
    );

    expect(selection.order.map((entry) => entry.id)).toEqual(["proofA", "proofC", "viaC"]);
    expect(selection.unresolved).toEqual([]);
  });

  it("falls back to a random proof and breaks an ungrounded cycle", () => {
    const selection = selectProofTree(
      ["A"],
      ["A", "B"],
      [proof("proofA", "A", ["B"]), proof("proofB", "B", ["A"])],
      () => 0,
    );

    expect(selection.order.map((entry) => entry.id)).toEqual(["proofB", "proofA"]);
    expect(selection.order.every((entry) => entry.selection === "random")).toBe(true);
    expect(selection.unresolved).toEqual(["A"]);
  });

  it("handles a deep proof chain without recursive traversal", () => {
    const count = 20_000;
    const statements = Array.from({ length: count }, (_, index) => `S${index.toString().padStart(5, "0")}`);
    const proofs = statements.map((statement, index) => proof(
      `proof${index.toString().padStart(5, "0")}`,
      statement,
      index === 0 ? [] : [statements[index - 1]!],
    ));

    const selection = selectProofTree([statements.at(-1)!], statements, proofs, () => 0);

    expect(selection.order).toHaveLength(count);
    expect(selection.order[0]?.conclusion).toBe(statements[0]);
    expect(selection.order.at(-1)?.conclusion).toBe(statements.at(-1));
    expect(selection.unresolved).toEqual([]);
  });

  it("rejects an out-of-range proof chooser result", () => {
    expect(() => selectProofTree(["A"], ["A"], [proof("proofA", "A", [])], () => 1))
      .toThrow("proof chooser returned 1 for 1 candidates");
  });
});

describe("proof-tree axiom classification", () => {
  it("accepts only the three background axioms", () => {
    expect(isBackgroundOnly([])).toBe(true);
    expect(isBackgroundOnly(["propext", "Classical.choice", "Quot.sound"])).toBe(true);
    expect(isBackgroundOnly(["Lax1.Open.statement"])).toBe(false);
  });
});
