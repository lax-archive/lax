import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureInventory,
  captureInventoryPath,
  generateProofTree,
  isBackgroundOnly,
  readCaptureInventory,
  selectProofTree,
  verifyCapture,
  writeCaptureInventory,
  type NetworkProof,
  type ProofTreeSelection,
} from "../../src/cli/prooftree.js";
import type { PublishedCapture } from "../../src/submission-validation/contracts.js";

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

/**
 * The statements a proof network can reach from the leaves upward, computed by
 * naive saturation rather than by the worklist selectProofTree uses, so that
 * the property test below judges the selection against an independent answer.
 */
function recursivelyGrounded(proofs: NetworkProof[]): Set<string> {
  const grounded = new Set<string>();
  for (;;) {
    const before = grounded.size;
    for (const candidate of proofs) {
      if (candidate.assumptions.every((assumption) => grounded.has(assumption))) {
        grounded.add(candidate.conclusion);
      }
    }
    if (grounded.size === before) return grounded;
  }
}

/**
 * A statement's proof may only be composed once every assumption it stands on
 * has one, so a selection is usable exactly when each grounded entry follows
 * all of its assumptions in the emitted order.
 */
function assertLeavesUpward(selection: ProofTreeSelection): void {
  const emitted = new Set<string>();
  for (const entry of selection.order) {
    if (entry.selection === "grounded") {
      for (const assumption of entry.assumptions) {
        expect(emitted.has(assumption), `${entry.id} precedes its assumption ${assumption}`).toBe(true);
      }
    }
    emitted.add(entry.conclusion);
  }
}

/** A seeded generator, so an adversarial archive is replayable from its seed. */
function pseudoRandom(seed: number): () => number {
  let state = (seed * 2654435761) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function randomNetwork(seed: number): { statements: string[]; proofs: NetworkProof[] } {
  const next = pseudoRandom(seed);
  const statements = Array.from({ length: 8 }, (_, index) => `S${index}`);
  const proofs: NetworkProof[] = [];
  for (const statement of statements) {
    const count = 1 + Math.floor(next() * 3);
    for (let index = 0; index < count; index += 1) {
      const assumptions = Array.from(
        { length: Math.floor(next() * 3) },
        () => statements[Math.floor(next() * statements.length)]!,
      );
      // The id prefix is drawn independently of the assumptions so that the
      // lexicographic tie-break cannot be what keeps the selection acyclic.
      const prefix = "abcdefgh"[Math.floor(next() * 8)]!;
      proofs.push(proof(`${prefix}-${statement}-${index}`, statement, assumptions));
    }
  }
  return { statements, proofs };
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
    );

    expect(selection.unresolved).toEqual([]);
    expect(selection.order.map((entry) => entry.id)).toEqual(["proofA", "goodB"]);
    expect(selection.order.every((entry) => entry.selection === "grounded")).toBe(true);
  });

  it("breaks a tie between two grounded proofs by proof id", () => {
    const selection = selectProofTree(
      ["A"],
      ["A"],
      [proof("second", "A", []), proof("first", "A", [])],
    );

    expect(selection.order.map((entry) => entry.id)).toEqual(["first"]);
    expect(selection.unresolved).toEqual([]);
  });

  it("chooses among every proof that is grounded at the fixed point", () => {
    // `zViaA` grounds B before Aux is grounded at all, so `aViaAux` only
    // becomes an eligible witness once the pass has run to completion.
    const selection = selectProofTree(
      ["B"],
      ["A", "Aux", "B"],
      [
        proof("groundA", "A", []),
        proof("proofAux", "Aux", ["A"]),
        proof("aViaAux", "B", ["Aux"]),
        proof("zViaA", "B", ["A"]),
      ],
    );

    expect(selection.order.map((entry) => entry.id)).toEqual(["groundA", "proofAux", "aViaAux"]);
    expect(selection.unresolved).toEqual([]);
  });

  it("never witnesses a statement with a proof that stands on the statement itself", () => {
    // Both proofs of A are grounded once B is: A holds on its own, and B holds
    // through A. Witnessing A by `aViaB` and B by `bViaA` would make each stand
    // on the other, and the traversal would report the root as an open leaf.
    const selection = selectProofTree(
      ["B"],
      ["A", "B"],
      [
        proof("aViaB", "A", ["B"]),
        proof("bViaA", "B", ["A"]),
        proof("zGroundedA", "A", []),
      ],
    );

    expect(selection.unresolved).toEqual([]);
    expect(selection.order.map((entry) => entry.id)).toEqual(["zGroundedA", "bViaA"]);
    expect(selection.order.every((entry) => entry.selection === "grounded")).toBe(true);
  });

  it("resolves every grounded statement of an adversarial proof network", () => {
    for (let seed = 1; seed <= 250; seed += 1) {
      const { statements, proofs } = randomNetwork(seed);
      const grounded = recursivelyGrounded(proofs);
      const selection = selectProofTree(statements, statements, proofs);

      expect(
        selection.unresolved.filter((statement) => grounded.has(statement)),
        `seed ${seed} left grounded statements unresolved`,
      ).toEqual([]);
      assertLeavesUpward(selection);
      for (const entry of selection.order) {
        expect(entry.selection === "grounded", `seed ${seed} misreported ${entry.id}`)
          .toBe(grounded.has(entry.conclusion));
      }
    }
  });

  it("selects the same proofs however the database directory was ordered", () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const { statements, proofs } = randomNetwork(seed);
      const shuffle = pseudoRandom(seed + 1_000);
      const shuffled = [...proofs]
        .map((entry) => ({ entry, key: shuffle() }))
        .sort((left, right) => left.key - right.key)
        .map(({ entry }) => entry);

      expect(JSON.stringify(selectProofTree(statements, statements, shuffled)))
        .toBe(JSON.stringify(selectProofTree(statements, statements, proofs)));
    }
  });

  it("falls back to an ungrounded proof and breaks an ungrounded cycle", () => {
    const selection = selectProofTree(
      ["A"],
      ["A", "B"],
      [proof("proofA", "A", ["B"]), proof("proofB", "B", ["A"])],
    );

    expect(selection.order.map((entry) => entry.id)).toEqual(["proofB", "proofA"]);
    expect(selection.order.every((entry) => entry.selection === "fallback")).toBe(true);
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

    const selection = selectProofTree([statements.at(-1)!], statements, proofs);

    expect(selection.order).toHaveLength(count);
    expect(selection.order[0]?.conclusion).toBe(statements[0]);
    expect(selection.order.at(-1)?.conclusion).toBe(statements.at(-1));
    expect(selection.unresolved).toEqual([]);
  });
});

describe("proof-tree axiom classification", () => {
  it("accepts only the three background axioms", () => {
    expect(isBackgroundOnly([])).toBe(true);
    expect(isBackgroundOnly(["propext", "Classical.choice", "Quot.sound"])).toBe(true);
    expect(isBackgroundOnly(["Lax1.Open.statement"])).toBe(false);
  });
});

// Reuse of an extracted spec-2 capture verifies content, not shape (codex
// review 2026-10-03, finding 3): the inventory this CLI writes beside the
// tree at download, from the digest-verified tar, is what a later run holds
// every file to. Spec 1 keeps its recorded inventory.
describe("the proof-tree capture cache", () => {
  const capture = (fileCount: number): PublishedCapture => ({
    formatVersion: 1,
    digest: "a".repeat(64),
    sourceCommit: "1".repeat(40),
    bytes: 10_240,
    fileCount,
    registryBlob: `ghcr.io/lax-archive/lax-captures@sha256:${"a".repeat(64)}`,
  });

  function tree(): { root: string; inventoryPath: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lax-prooftree-cache-"));
    fs.mkdirSync(path.join(root, "concepts", "lib", "Lax1"), { recursive: true });
    fs.writeFileSync(path.join(root, "concepts", "lib", "Lax1.olean"), "olean-root");
    fs.writeFileSync(path.join(root, "concepts", "lib", "Lax1", "Basic.olean"), "olean-basic");
    const inventoryPath = captureInventoryPath(root);
    writeCaptureInventory(inventoryPath, captureInventory(root));
    return { root, inventoryPath };
  }

  it("verifies a reused spec-2 tree against the inventory written at download, file by file", () => {
    const { root, inventoryPath } = tree();
    const inventory = readCaptureInventory(inventoryPath)!;
    expect([...inventory.keys()].sort()).toEqual(["concepts/lib/Lax1.olean", "concepts/lib/Lax1/Basic.olean"]);
    expect(() => verifyCapture(root, capture(2), inventory)).not.toThrow();
    // a corrupted olean, same size, same count: refused
    fs.writeFileSync(path.join(root, "concepts", "lib", "Lax1", "Basic.olean"), "olean-BASIC");
    expect(() => verifyCapture(root, capture(2), inventory)).toThrow("failed verification: concepts/lib/Lax1/Basic.olean");
    // a replaced file under another name, same count: refused
    fs.rmSync(path.join(root, "concepts", "lib", "Lax1", "Basic.olean"));
    fs.writeFileSync(path.join(root, "concepts", "lib", "Lax1", "Other.olean"), "olean-basic");
    expect(() => verifyCapture(root, capture(2), inventory)).toThrow("unexpected file concepts/lib/Lax1/Other.olean");
    // the count alone — what a fresh extraction of a digest-verified tar is
    // held to — sees nothing wrong with either, which is why reuse needs more
    expect(() => verifyCapture(root, capture(2), undefined)).not.toThrow();
    expect(() => verifyCapture(root, capture(3), undefined)).toThrow("declared number of files");
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(inventoryPath, { force: true });
  });

  it("treats a missing or malformed inventory as no cache", () => {
    const { root, inventoryPath } = tree();
    fs.writeFileSync(inventoryPath, "{not json");
    expect(readCaptureInventory(inventoryPath)).toBeUndefined();
    fs.writeFileSync(inventoryPath, JSON.stringify({ inventoryVersion: 1, files: [{ path: "x", bytes: 1, sha256: "zz" }] }));
    expect(readCaptureInventory(inventoryPath)).toBeUndefined();
    fs.rmSync(inventoryPath);
    expect(readCaptureInventory(inventoryPath)).toBeUndefined();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
