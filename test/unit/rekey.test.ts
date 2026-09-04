import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rekeySubmission } from "../../src/cli/rekey.js";
import { runStaticValidation } from "../../src/submission-validation/phases/static.js";
import {
  cleanupTemporary,
  initializeGit,
  makeSubmission,
  manifest,
  request,
  RUNTIME,
  temporary,
} from "../support/submission-validation.js";

afterEach(cleanupTemporary);

const PAPER_BLOCK = "paper:\n  folder: paper\n  main: main.tex\n";

// latin1 on purpose: `apr\xe8s` is one byte here, as in a paper written under
// inputenc, and the rekey must hand those bytes back unchanged.
const TEX =
  "\\documentclass{article}\n\\begin{document}\n" +
  "% lax begin Lax123456.Treewidth\nA tree decomposition, apr\xe8s Robertson and Seymour.\n% lax end\n" +
  "% lax begin Lax123456Proofs.Q\nThe width is optimal.\n% lax end\n" +
  "% lax begin lax-123456\nThis submission, \\verb|Lax123456|, builds on Lax1234567.Menger.\n% lax end\n" +
  "\\end{document}\n";

// A PNG signature, the old package name in what could be a caption, and the
// control bytes any container carries: payload the substitution must not enter.
const FIGURE = Buffer.from("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR Lax123456 \x00\x01\x02", "latin1");

describe("rekeying a submission folder", () => {
  it("renumbers a declared paper's markers into a tree the static gate accepts", () => {
    const root = makeSubmission("lax-123456", temporary("lax-rekey-"), {
      "manifest.yaml": manifest("lax-123456") + PAPER_BLOCK,
      "paper/refs.bib": "@misc{rs86, title={Graph minors II}}\n",
    });
    fs.writeFileSync(path.join(root, "paper", "main.tex"), TEX, "latin1");
    fs.writeFileSync(path.join(root, "paper", "figure.png"), FIGURE);

    rekeySubmission(root, "lax-123456", "lax-654321");

    const tex = fs.readFileSync(path.join(root, "paper", "main.tex"), "latin1");
    expect(tex).toContain("% lax begin Lax654321.Treewidth");
    expect(tex).toContain("% lax begin Lax654321Proofs.Q");
    expect(tex).toContain("% lax begin lax-654321");
    // Prose naming the folder's own id is renumbered with it; a seven-digit
    // dependency that merely starts with the old id is not.
    expect(tex).toContain("\\verb|Lax654321|");
    expect(tex).toContain("Lax1234567.Menger");
    expect(tex).not.toMatch(/Lax123456(?![0-9])/u);
    expect(tex).not.toMatch(/lax-123456(?![0-9])/u);
    // Byte for byte otherwise: the latin1 `è` survives, and the figure is
    // payload, not text, however it spells the old package name.
    expect(fs.readFileSync(path.join(root, "paper", "main.tex")).includes(0xe8)).toBe(true);
    expect(fs.readFileSync(path.join(root, "paper", "figure.png")).equals(FIGURE)).toBe(true);

    initializeGit(root);
    const check = runStaticValidation(request("lax-654321"), root, RUNTIME);
    expect(check.findings.violations).toEqual([]);
    expect(check.result.paper?.marks.map((mark) => mark.id)).toEqual([
      "Lax654321.Treewidth",
      "Lax654321Proofs.Q",
      "lax-654321",
    ]);
  });

  it("renumbers the markers of an offline placeholder scaffold", () => {
    // `lax-0`/`Lax0`/`Lax0Proofs` are legal mark ids while a folder is still
    // the offline placeholder; the first submit renumbers the folder, and the
    // markers must move with it.
    const root = makeSubmission("lax-0", temporary("lax-rekey-"), {
      "manifest.yaml": manifest("lax-0") + PAPER_BLOCK,
      "paper/main.tex":
        "% lax begin Lax0.Treewidth\nA definition.\n% lax end\n" +
        "% lax begin Lax0Proofs.Q\nA proof.\n% lax end\n" +
        "% lax begin lax-0\nThe submission.\n% lax end\n",
    });

    rekeySubmission(root, "lax-0", "lax-654321");

    initializeGit(root);
    const check = runStaticValidation(request("lax-654321"), root, RUNTIME);
    expect(check.findings.violations).toEqual([]);
    expect(check.result.paper?.marks.map((mark) => mark.id)).toEqual([
      "Lax654321.Treewidth",
      "Lax654321Proofs.Q",
      "lax-654321",
    ]);
  });
});
