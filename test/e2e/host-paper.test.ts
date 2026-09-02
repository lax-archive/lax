// The paper layer on the host pipeline, end to end: a real latexmk compiles
// the rewritten fixture with the injected marker package, pdf.js reads the
// destinations back, and the marks resolve against the Lean inspection. Skips
// when this machine has no latexmk (CI installs a small TeX Live for it).

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { probeLatexmk } from "../../src/submission-validation/host/paper.js";
import {
  buildOnHost,
  freshLaxHome,
  gitInitCommit,
  linkSharedDirs,
  makePaperSubmission,
  messages,
  rules,
  tmpDir,
} from "../support/host.js";

const latexmk = probeLatexmk();
const withTex = latexmk?.supported === true;
if (!withTex) console.warn("host-paper: latexmk >= 4.77 not found, skipping the paper e2e");

beforeAll(() => {
  freshLaxHome();
});

describe.skipIf(!withTex)("host pipeline with a paper (real latexmk, fake mathlib)", () => {
  it("compiles the paper beside the Lean chain, locates every mark, and is reproducible", async () => {
    const root = makePaperSubmission("lax-7");
    const report = await buildOnHost(root, { id: "lax-7" });
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    // no latexmk-missing note either: the phase really ran
    expect(report.warnings).toEqual([]);
    const paper = report.buildOutput!.paper!;
    expect(paper).toMatchObject({ folder: "paper", main: "main.tex", engine: "pdflatex" });
    // no injected web deriver — `lax build`'s default derives no web view
    expect(paper.web).toBeUndefined();
    expect(report.paperWebPath).toBeUndefined();
    expect(paper.pdf.pages).toBeGreaterThanOrEqual(1);
    expect(paper.pageSizes).toHaveLength(paper.pdf.pages);
    expect(paper.pageSizes[0]![0]).toBeGreaterThan(500);
    // the local build hands the PDF over, bound by the recorded digest
    expect(report.paperPdfPath).toBeDefined();
    const bytes = fs.readFileSync(report.paperPdfPath!);
    expect(bytes.length).toBe(paper.pdf.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(paper.pdf.digest);
    expect(paper.pdf.registryBlob).toBeUndefined();
    // the original sources ride in the capture under paper/, unrewritten
    const captured = report.capture!.files.filter((file) => file.path.startsWith("paper/")).map((file) => file.path);
    expect(captured).toEqual(["paper/main.tex", "paper/section.tex"]);
    const mainEntry = report.capture!.files.find((file) => file.path === "paper/main.tex")!;
    const authored = fs.readFileSync(path.join(root, "paper", "main.tex"));
    expect(mainEntry.bytes).toBe(authored.length);
    expect(mainEntry.sha256).toBe(createHash("sha256").update(authored).digest("hex"));
    // document order: inline concept, block concept, nested proof, second file
    expect(paper.marks.map((mark) => [mark.id, mark.kind])).toEqual([
      ["Lax7.One", "concept"],
      ["Lax7.Zero", "concept"],
      ["Lax7Proofs.zero_eq", "proof"],
      ["Lax7Proofs.one_eq", "proof"],
    ]);
    const [inline, block, nested] = paper.marks;
    // the inline phrase is typeset mid-line: horizontal mode, one baseline
    expect(inline!.begin.mode).toBe("h");
    expect(inline!.end.mode).toBe("h");
    expect(inline!.begin.page).toBe(1);
    expect(inline!.begin.y).toBeCloseTo(inline!.end.y, 1);
    expect(inline!.end.x).toBeGreaterThan(inline!.begin.x);
    // the theorem block is entered between paragraphs: vertical mode, the
    // begin above the end
    expect(block!.begin.mode).toBe("v");
    expect(block!.end.mode).toBe("v");
    expect(block!.begin.y).toBeGreaterThan(block!.end.y);
    // the nested proof closes just before its parent: same point, in order
    expect(nested!.end.page).toBe(block!.end.page);
    expect(nested!.end.y).toBeGreaterThanOrEqual(block!.end.y);
    for (const mark of paper.marks) {
      expect(mark.begin.page).toBeGreaterThanOrEqual(1);
      expect(mark.end.page).toBeLessThanOrEqual(paper.pdf.pages);
      expect(Number.isFinite(mark.begin.x) && Number.isFinite(mark.end.y)).toBe(true);
    }
    // a second build of the same commit yields the same bytes
    const again = await buildOnHost(root, { id: "lax-7" });
    expect(again.violations).toEqual([]);
    expect(again.buildOutput!.paper!.pdf.digest).toBe(paper.pdf.digest);
    expect(again.buildOutput!.paper!.marks).toEqual(paper.marks);
  });

  it("fails a marker that leaves no destination and an id with no card, with Lean still judged", async () => {
    const root = makePaperSubmission("lax-8", {
      extraTex:
        "\\begin{verbatim}\n% lax begin Lax8.Zero\ntrapped\n% lax end\n\\end{verbatim}\n\n" +
        "% lax begin Lax8.Zero.zeroEq\na statement, which has no card\n% lax end\n\n" +
        "% lax begin Lax99.Missing\na package this submission does not require\n% lax end\n",
    });
    const report = await buildOnHost(root, { id: "lax-8" });
    expect(report.ok).toBe(false);
    // the verbatim trap is caught by the count check alone, as one finding
    expect(rules(report)).toEqual(new Set(["marks"]));
    const text = messages(report);
    expect(text).toContain("main.tex:");
    expect(text).toContain("Lax8.Zero");
    expect(text).toContain("verbatim");
    expect(report.buildOutput).toBeUndefined();
    // the ids are only judged once the PDF is right; remove the trap
    const main = path.join(root, "paper", "main.tex");
    fs.writeFileSync(main, fs.readFileSync(main, "utf8").replace(/\\begin\{verbatim\}[\s\S]*?\\end\{verbatim\}\n/u, ""));
    const again = await buildOnHost(root, { id: "lax-8" });
    expect(again.ok).toBe(false);
    expect(rules(again)).toEqual(new Set(["mark-id"]));
    const ids = messages(again);
    expect(ids).toContain("statements are not markable");
    expect(ids).toContain("mark Lax8.Zero instead");
    expect(ids).toContain("Lax99 is not a package this submission requires directly");
  });

  it("refuses a paper that does not compile, with the transcript tail", async () => {
    const root = makePaperSubmission("lax-9", { extraTex: "\\undefinedmacro\n" });
    const report = await buildOnHost(root, { id: "lax-9" });
    expect(report.ok).toBe(false);
    expect(rules(report)).toEqual(new Set(["compile"]));
    const text = messages(report);
    expect(text).toContain("did not compile");
    expect(text).toContain("Undefined control sequence");
  });

  it("builds through the lax CLI, writing paper.pdf beside build-output.json", async () => {
    const clientHome = linkSharedDirs(tmpDir("lax-cli-home-"));
    const database = path.join(clientHome, "lax-database");
    fs.mkdirSync(database, { recursive: true });
    fs.writeFileSync(path.join(database, "README.md"), "fake database\n");
    gitInitCommit(database);
    const root = makePaperSubmission("lax-10");
    gitInitCommit(root);
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const result = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
        path.join(repoRoot, "src", "cli", "main.ts"),
        "build",
        root,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, LAX_HOME: clientHome, NO_COLOR: "1" },
        timeout: 590_000,
      },
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("✓ Compiled the paper");
    expect(result.stdout).toMatch(/Compiled the paper\s+\S*\s*1 page · 4 marks/u);
    expect(result.stdout).toContain("✓ Inspected the statements");
    expect(result.status).toBe(0);
    const output = JSON.parse(fs.readFileSync(path.join(root, "build-output.json"), "utf8")) as {
      paper: { pdf: { digest: string } };
    };
    const pdf = fs.readFileSync(path.join(root, "paper.pdf"));
    expect(createHash("sha256").update(pdf).digest("hex")).toBe(output.paper.pdf.digest);
    // and the tree is still clean apart from the two generated files
    expect(fs.existsSync(path.join(root, "paper", "main.pdf"))).toBe(false);
    expect(fs.existsSync(path.join(root, "paper", "main.aux"))).toBe(false);
  });
});

describe("host pipeline with a paper but no latexmk", () => {
  it("skips the compile with a note, omits `paper`, and still validates the Lean", async () => {
    // A shim that fails its --version probe stands in for a machine without
    // TeX; everything else stays on the real PATH.
    const shims = tmpDir("lax-noshim-");
    fs.writeFileSync(path.join(shims, "latexmk"), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
    const clientHome = linkSharedDirs(tmpDir("lax-cli-home-"));
    const database = path.join(clientHome, "lax-database");
    fs.mkdirSync(database, { recursive: true });
    fs.writeFileSync(path.join(database, "README.md"), "fake database\n");
    gitInitCommit(database);
    const root = makePaperSubmission("lax-11");
    // a stale PDF from an earlier build must not survive a build that made none
    fs.writeFileSync(path.join(root, "paper.pdf"), "stale");
    gitInitCommit(root);
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const result = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
        path.join(repoRoot, "src", "cli", "main.ts"),
        "build",
        root,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, PATH: `${shims}:${process.env.PATH ?? ""}`, LAX_HOME: clientHome, NO_COLOR: "1" },
        timeout: 590_000,
      },
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("! Paper not compiled here");
    expect(result.stdout).toContain("skipped: latexmk is not installed");
    expect(result.stdout).toContain("✓ Inspected the statements");
    expect(result.stdout).toContain("latexmk-missing");
    expect(result.status).toBe(0);
    const output = JSON.parse(fs.readFileSync(path.join(root, "build-output.json"), "utf8")) as Record<string, unknown>;
    expect(output.paper).toBeUndefined();
    expect(fs.existsSync(path.join(root, "paper.pdf"))).toBe(false);
  });
});
