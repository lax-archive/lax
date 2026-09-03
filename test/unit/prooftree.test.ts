import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateProofTree, selectProofTree, type NetworkProof } from "../../src/cli/prooftree.js";

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
  it("directs missing-database recovery to lax sync", async () => {
    const previousHome = process.env.LAX_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "lax-prooftree-home-"));
    process.env.LAX_HOME = home;

    try {
      await expect(generateProofTree("lax-1")).rejects.toThrow("run `lax sync`");
    } finally {
      if (previousHome === undefined) delete process.env.LAX_HOME;
      else process.env.LAX_HOME = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

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
});
