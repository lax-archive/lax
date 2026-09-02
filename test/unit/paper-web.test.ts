// The web derivation's seams and mechanics without any TeX (paper-web-plan.md
// stage 2): the deterministic bundle tar, the marker sanity count, the
// prerequisite probe, the join passthrough into `paper.web`, and the paper
// phase's threading of an injected WebDeriver — including the `paper.web:
// false` opt-out and the warnings-only (never blocking) contract. The real
// derivation is covered by test/e2e/paper-web.test.ts.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ArchiveSnapshot } from "../../src/submission-validation/archive/snapshot.js";
import { DEFAULT_LIMITS } from "../../src/submission-validation/config.js";
import type {
  InspectionResult,
  ResolutionResult,
  StaticPaper,
  StaticResult,
} from "../../src/submission-validation/contracts.js";
import { joinPaperMarks } from "../../src/submission-validation/paper/join.js";
import { runPaperPhase, type CompiledPaper } from "../../src/submission-validation/paper/phase.js";
import {
  markerCountProblems,
  probeReflowtex,
  webCompileEnvironment,
  webLatexmkArguments,
  writeDeterministicTar,
  type WebDeriver,
} from "../../src/submission-validation/paper/web.js";
import { tmpDir } from "../support/host.js";

// ── a real minimal PDF, so the phase's pdf.js extraction genuinely runs ────

function minimalPdf(text: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R " +
      "/Resources << /Font << /F1 5 0 R >> >> >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

function markerlessPaper(web?: boolean): { paper: StaticPaper; submissionRoot: string } {
  const submissionRoot = tmpDir("lax-web-unit-");
  fs.mkdirSync(path.join(submissionRoot, "paper"), { recursive: true });
  return {
    submissionRoot,
    paper: {
      manifest: { folder: "paper", main: "main.tex", engine: "pdflatex", ...(web === undefined ? {} : { web }) },
      files: ["main.tex"],
      texFiles: ["main.tex"],
      rewritten: new Map([["main.tex", "\\documentclass{article}\\begin{document}x\\end{document}\n"]]),
      marks: [],
    },
  };
}

/** A compiler that never runs TeX: it writes a real minimal PDF. */
const fakeCompile = async (cwd: string): Promise<{ code: number; output: string }> => {
  fs.writeFileSync(path.join(cwd, "main.pdf"), minimalPdf("Hello web world"));
  return { code: 0, output: "" };
};

describe("paper phase web threading", () => {
  it("hands the deriver the compiled PDF and threads its bundle and warnings", async () => {
    const { paper, submissionRoot } = markerlessPaper();
    const jobDir = tmpDir("lax-web-job-");
    const seen: string[] = [];
    const deriver: WebDeriver = async (input) => {
      seen.push(input.pdfPath);
      expect(fs.existsSync(input.pdfPath)).toBe(true);
      expect(input.limits.paperWebOracleSimilarity).toBe(DEFAULT_LIMITS.paperWebOracleSimilarity);
      return {
        web: {
          bundlePath: path.join(input.jobDir, "paper", "web", "paper-web.tar"),
          digest: "d".repeat(64),
          bytes: 1234,
          format: { tool: "reflowtex", rev: "e".repeat(40), schema: "f".repeat(64) },
        },
        warnings: [{ rule: "web-unreferenced-paragraph", message: "the reflow view omits a captured paragraph" }],
      };
    };
    const result = await runPaperPhase({
      paper,
      submissionRoot,
      jobDir,
      sourceDateEpoch: 0,
      limits: DEFAULT_LIMITS,
      compile: fakeCompile,
      deriveWeb: deriver,
    });
    expect(result.findings.violations).toEqual([]);
    expect(seen).toEqual([path.join(jobDir, "paper", "src", "main.pdf")]);
    expect(result.compiled?.web).toEqual({
      bundlePath: path.join(jobDir, "paper", "web", "paper-web.tar"),
      digest: "d".repeat(64),
      bytes: 1234,
      format: { tool: "reflowtex", rev: "e".repeat(40), schema: "f".repeat(64) },
    });
    expect(result.findings.warnings).toEqual([
      { phase: "paper", rule: "web-unreferenced-paragraph", message: "the reflow view omits a captured paragraph" },
    ]);
  });

  it("does not attempt the derivation under `paper.web: false`, with no warning", async () => {
    const { paper, submissionRoot } = markerlessPaper(false);
    let called = 0;
    const result = await runPaperPhase({
      paper,
      submissionRoot,
      jobDir: tmpDir("lax-web-job-"),
      sourceDateEpoch: 0,
      limits: DEFAULT_LIMITS,
      compile: fakeCompile,
      deriveWeb: async () => {
        called += 1;
        return { warnings: [] };
      },
    });
    expect(called).toBe(0);
    expect(result.compiled).toBeDefined();
    expect(result.compiled!.web).toBeUndefined();
    expect(result.findings.warnings).toEqual([]);
  });

  it("derives nothing when no deriver is injected — the local default", async () => {
    const { paper, submissionRoot } = markerlessPaper();
    const result = await runPaperPhase({
      paper,
      submissionRoot,
      jobDir: tmpDir("lax-web-job-"),
      sourceDateEpoch: 0,
      limits: DEFAULT_LIMITS,
      compile: fakeCompile,
    });
    expect(result.compiled).toBeDefined();
    expect(result.compiled!.web).toBeUndefined();
    expect(result.findings.warnings).toEqual([]);
  });

  it("turns a throwing deriver into a warning and keeps the PDF result", async () => {
    const { paper, submissionRoot } = markerlessPaper(true);
    const result = await runPaperPhase({
      paper,
      submissionRoot,
      jobDir: tmpDir("lax-web-job-"),
      sourceDateEpoch: 0,
      limits: DEFAULT_LIMITS,
      compile: fakeCompile,
      deriveWeb: async () => {
        throw new Error("the venv exploded");
      },
    });
    expect(result.findings.violations).toEqual([]);
    expect(result.compiled).toBeDefined();
    expect(result.compiled!.web).toBeUndefined();
    expect(result.findings.warnings).toEqual([
      {
        phase: "paper",
        rule: "web-derivation",
        message: "the reflow view was not derived: the venv exploded",
      },
    ]);
  });

  it("carries a skipping deriver's warnings with `web` simply omitted", async () => {
    const { paper, submissionRoot } = markerlessPaper();
    const result = await runPaperPhase({
      paper,
      submissionRoot,
      jobDir: tmpDir("lax-web-job-"),
      sourceDateEpoch: 0,
      limits: DEFAULT_LIMITS,
      compile: fakeCompile,
      deriveWeb: async () => ({
        warnings: [{ rule: "web-oracle", message: "the reflow view was not derived: divergence at token 3" }],
      }),
    });
    expect(result.compiled).toBeDefined();
    expect(result.compiled!.web).toBeUndefined();
    expect(result.findings.warnings).toEqual([
      { phase: "paper", rule: "web-oracle", message: "the reflow view was not derived: divergence at token 3" },
    ]);
  });
});

describe("join passthrough", () => {
  function joinWith(web: CompiledPaper["web"]): ReturnType<typeof joinPaperMarks> {
    const compiled: CompiledPaper = {
      pdfPath: "/nowhere/main.pdf",
      digest: "a".repeat(64),
      bytes: 1000,
      pages: 1,
      pageSizes: [[612, 792]],
      located: [],
      ...(web === undefined ? {} : { web }),
    };
    const lakefile = (packageName: string) => ({ packageName, gitRequires: [], hasConceptPathRequire: false });
    const inventory = (packageName: string) => ({
      packageName,
      packageDir: packageName,
      rootModule: packageName,
      modules: [],
      paths: new Map<string, string>(),
    });
    const staticResult: StaticResult = {
      manifest: {
        specVersion: "1",
        id: "lax-7",
        leanVersion: "v",
        mathlibVersion: "m",
        title: "t",
        authors: [],
        bibEntries: [],
        paper: { folder: "paper", main: "main.tex", engine: "pdflatex" },
      },
      concepts: { lakefile: lakefile("Lax7"), inventory: inventory("Lax7") },
      proofs: { lakefile: lakefile("Lax7Proofs"), inventory: inventory("Lax7Proofs") },
      paper: {
        manifest: { folder: "paper", main: "main.tex", engine: "pdflatex" },
        files: ["main.tex"],
        texFiles: ["main.tex"],
        rewritten: new Map(),
        marks: [],
      },
    };
    const resolution: ResolutionResult = { concepts: [], proofs: [], all: [] };
    const inspection: InspectionResult = { concepts: [], proofs: [] };
    const archive = new ArchiveSnapshot(tmpDir("lax-web-archive-"), "a".repeat(40));
    return joinPaperMarks(compiled, staticResult, resolution, archive, inspection);
  }

  it("threads a derived bundle into `paper.web` exactly as recorded", () => {
    const joined = joinWith({
      bundlePath: "/job/paper/web/paper-web.tar",
      digest: "b".repeat(64),
      bytes: 4321,
      format: { tool: "reflowtex", rev: "c".repeat(40), schema: "d".repeat(64) },
    });
    expect(joined.problems).toEqual([]);
    expect(joined.output!.web).toEqual({
      format: { tool: "reflowtex", rev: "c".repeat(40), schema: "d".repeat(64) },
      bundle: { digest: "b".repeat(64), bytes: 4321 },
    });
  });

  it("omits `web` when no derivation happened", () => {
    const joined = joinWith(undefined);
    expect(joined.problems).toEqual([]);
    expect(joined.output!.web).toBeUndefined();
    expect("web" in joined.output!).toBe(false);
  });
});

describe("marker sanity", () => {
  const table = [
    { n: 1, id: "Lax7.One", file: "main.tex", line: 3 },
    { n: 2, id: "Lax7.Zero", file: "main.tex", line: 9 },
  ];

  it("accepts exactly one begin and one end per mark, at either site", () => {
    expect(markerCountProblems(table, [
      { side: "b", n: 1, at: "paragraph" },
      { side: "e", n: 1, at: "paragraph" },
      { side: "b", n: 2, at: "stream" },
      { side: "e", n: 2, at: "stream" },
    ])).toEqual([]);
  });

  it("names a missing half, a doubled half, and an unknown number", () => {
    const problems = markerCountProblems(table, [
      { side: "b", n: 1, at: "paragraph" },
      { side: "b", n: 2, at: "stream" },
      { side: "b", n: 2, at: "stream" },
      { side: "e", n: 2, at: "stream" },
      { side: "e", n: 9, at: "stream" },
    ]);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain("mark 1 (Lax7.One) appears 1× as begin and 0× as end");
    expect(problems[1]).toContain("mark 2 (Lax7.Zero) appears 2× as begin and 1× as end");
    expect(problems[2]).toContain("marker number the rewriter never emitted: 9");
  });
});

describe("deterministic bundle tar", () => {
  const files = [
    { name: "index.json", content: Buffer.from("{}\n") },
    { name: "blocks/000.pb", content: Buffer.from([1, 2, 3, 4, 5]) },
    { name: "fonts/a.otf", content: Buffer.alloc(600, 7) },
    { name: "schema/latex.proto", content: Buffer.from("syntax;\n") },
  ];

  it("is byte-identical across calls and input orderings", () => {
    const first = writeDeterministicTar(files);
    const second = writeDeterministicTar([...files].reverse());
    expect(first.equals(second)).toBe(true);
  });

  it("writes well-formed ustar entries, sorted, with zeroed metadata", () => {
    const tar = writeDeterministicTar(files);
    expect(tar.length % 512).toBe(0);
    const names: string[] = [];
    let offset = 0;
    for (;;) {
      const header = tar.subarray(offset, offset + 512);
      if (header.every((byte) => byte === 0)) break;
      const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/su, "");
      names.push(name);
      expect(header.subarray(257, 262).toString("latin1")).toBe("ustar");
      expect(parseInt(header.subarray(136, 148).toString("latin1"), 8)).toBe(0); // mtime
      expect(parseInt(header.subarray(108, 116).toString("latin1"), 8)).toBe(0); // uid
      const size = parseInt(header.subarray(124, 136).toString("latin1"), 8);
      const expected = files.find((file) => file.name === name)!;
      expect(size).toBe(expected.content.length);
      expect(tar.subarray(offset + 512, offset + 512 + size).equals(expected.content)).toBe(true);
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    expect(names).toEqual(["blocks/000.pb", "fonts/a.otf", "index.json", "schema/latex.proto"]);
    // the archive ends with two zero blocks
    expect(tar.subarray(tar.length - 1024).every((byte) => byte === 0)).toBe(true);
  });

  it("refuses duplicate and over-long entry names", () => {
    expect(() => writeDeterministicTar([files[0]!, files[0]!])).toThrow("duplicate bundle entry");
    expect(() =>
      writeDeterministicTar([{ name: `fonts/${"x".repeat(120)}.otf`, content: Buffer.alloc(1) }]),
    ).toThrow("over 100 bytes");
  });
});

describe("prerequisite probe and compile shape", () => {
  it("names the missing piece of an unfetched fork", () => {
    const probed = probeReflowtex(path.join(tmpDir("lax-web-probe-"), "reflowtex"));
    expect(probed).toHaveProperty("missing");
    expect((probed as { missing: string }).missing).toContain("reflowtex");
    expect((probed as { missing: string }).missing).toContain("npm run reflowtex:fetch");
  });

  it("compiles with lualatex, shell escape, the injected package, and the jobname", () => {
    expect(webLatexmkArguments("main.tex")).toEqual([
      "-lualatex",
      "-interaction=nonstopmode",
      "-halt-on-error",
      "-shell-escape",
      "-usepretex",
      "-pretex=\\RequirePackage{laxreflow}",
      "-jobname=main",
      "main.tex",
    ]);
    // the job's copy precedes the marker packages, both non-recursive, and
    // the trailing colon keeps TeX Live's default tree
    expect(webCompileEnvironment("/job/paper/web/src", "/assets/tex", 1700000000)).toEqual({
      TEXINPUTS: "/job/paper/web/src:/assets/tex:",
      SOURCE_DATE_EPOCH: "1700000000",
      FORCE_SOURCE_DATE: "1",
    });
  });
});
