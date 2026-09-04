// The web derivation's seams and mechanics without any TeX (paper-web-plan.md
// stage 2): the deterministic bundle tar, the marker sanity count, the
// prerequisite probe, the join passthrough into `paper.web`, the paper
// phase's threading of an injected WebDeriver — including the `paper.web:
// false` opt-out and the warnings-only (never blocking) contract — and the
// encode-to-seal path itself, driven with a stand-in encode child over a
// real PDF so the oracle's verdict is measured through the code that ships.
// The real derivation is covered by test/e2e/paper-web.test.ts.

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
import { ONE_LINE_TAIL_BYTES, oneLineTail } from "../../src/submission-validation/paper/compile.js";
import { runPaperPhase, type CompiledPaper } from "../../src/submission-validation/paper/phase.js";
import {
  encodeAndSealWebBundle,
  markerCountProblems,
  probeReflowtex,
  runWebDerivation,
  webCompileEnvironment,
  webLatexmkArguments,
  writeDeterministicTar,
  type ReflowtexInstallation,
  type WebDeriveInput,
  type WebDerivation,
  type WebDeriver,
  parseEncodeReport,
} from "../../src/submission-validation/paper/web.js";
import { tmpDir } from "../support/host.js";

// ── a real minimal PDF, so the phase's pdf.js extraction genuinely runs ────

/** One text line per string: `T*` puts each on its own baseline, which is
 * what makes pdf.js report them as separate lines with `hasEOL` — the shape
 * the oracle's furniture stripping reads. Keep each line to a printed line's
 * worth of text: pdf.js reports a text item only as far as the media box's
 * right edge, so at this 12pt size a line past about ninety characters comes
 * back truncated mid-word — a fixture that silently loses its own tail. */
function minimalPdf(text: string | readonly string[]): Buffer {
  const lines = typeof text === "string" ? [text] : text;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R " +
      "/Resources << /Font << /F1 5 0 R >> >> >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 12 Tf 14 TL 72 720 Td ${lines.map((line) => `(${line}) Tj T*`).join(" ")} ET`;
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

// ── the encode-to-seal path, over a real PDF ──────────────────────────────

interface StandInStream {
  text: string;
  unreferenced?: string[];
}

/**
 * A stand-in for the fork's encode child — node in place of the venv's
 * python — writing the three outputs the real child writes. Everything
 * downstream of it inside `encodeAndSealWebBundle` (report parsing, marker
 * sanity, pdf.js extraction, the oracle, the seal) then runs for real, so
 * these tests measure the shipped verdict and not a restatement of it.
 */
function standInFork(stream: StandInStream): ReflowtexInstallation {
  const root = tmpDir("lax-web-fork-");
  const report = {
    markers: [],
    text: stream.text,
    unreferenced: (stream.unreferenced ?? []).map((text) => ({ text, markers: [] })),
  };
  const script = path.join(root, "encode_web.mjs");
  fs.writeFileSync(
    script,
    [
      `import fs from "node:fs";`,
      `import path from "node:path";`,
      `const out = process.argv[process.argv.indexOf("--out") + 1];`,
      `const block = Buffer.from("a serialized block");`,
      `fs.mkdirSync(path.join(out, "blocks"), { recursive: true });`,
      `fs.writeFileSync(path.join(out, "blocks", "000.pb"), block);`,
      `fs.writeFileSync(path.join(out, "stream.json"), ${JSON.stringify(JSON.stringify(report))});`,
      `fs.writeFileSync(path.join(out, "encode.json"), JSON.stringify({ pbBytes: block.length, fonts: {} }));`,
      "",
    ].join("\n"),
  );
  const schema = path.join(root, "latex.proto");
  fs.writeFileSync(schema, 'syntax = "proto3";\n');
  return {
    checkout: root,
    serializer: script,
    venvPython: process.execPath,
    encodeScript: script,
    schemaProto: schema,
    generatedPb2: script,
    pymupdf: root,
  };
}

/** Compile-free derivation: a real PDF carrying `pdfLines`, the stand-in
 * child carrying the stream, the shipped encode → oracle → seal path. */
async function derive(
  pdfLines: readonly string[],
  stream: StandInStream,
): Promise<{ derivation: WebDerivation; bundlePath: string }> {
  const { paper, submissionRoot } = markerlessPaper();
  const jobDir = tmpDir("lax-web-job-");
  const webSrc = path.join(jobDir, "paper", "web", "src");
  const webOut = path.join(jobDir, "paper", "web", "out");
  fs.mkdirSync(webSrc, { recursive: true });
  fs.mkdirSync(webOut, { recursive: true });
  const pdfPath = path.join(jobDir, "main.pdf");
  fs.writeFileSync(pdfPath, minimalPdf(pdfLines));
  const input: WebDeriveInput = {
    paper,
    submissionRoot,
    jobDir,
    sourceDateEpoch: 0,
    limits: DEFAULT_LIMITS,
    pdfPath,
  };
  const derivation = await runWebDerivation((warnings, skip) =>
    encodeAndSealWebBundle(input, standInFork(stream), webSrc, webOut, warnings, skip));
  return { derivation, bundlePath: path.join(jobDir, "paper", "web", "paper-web.tar") };
}

/** A one-page paper's worth of text. The size matters: the budget the
 * oracle spends on unreferenced captures is a share of the document, so a
 * margin note is only honest against a paper long enough to hold one. */
const body = [
  "The construction proceeds by induction on the height of the tree,",
  "and every step preserves the invariant stated in the previous section.",
  "The base case is immediate, since a single vertex carries no edges at all,",
  "and the inductive step splits the tree at a centroid and applies the",
  "hypothesis to each of the two halves in turn.",
];

describe("the oracle over the encode reports", () => {
  it("seals a view whose only omission is a margin note, and names the note", async () => {
    const note = "A marginal note that only print shows";
    const { derivation, bundlePath } = await derive([...body, note], {
      text: body.join(" "),
      unreferenced: [note],
    });
    expect(derivation.web).toBeDefined();
    expect(fs.existsSync(bundlePath)).toBe(true);
    expect(derivation.warnings.map((warning) => warning.rule)).toEqual(["web-unreferenced-paragraph"]);
    expect(derivation.warnings[0]!.message).toContain(note);
  });

  it("refuses to seal when the unreferenced captures pass the budget", async () => {
    // Seven of eight paragraphs missing from the stream: subtracting them
    // all leaves the oracle comparing one paragraph with itself, and the
    // bundle would carry an eighth of the paper the PDF beside it shows.
    const paragraphs = Array.from(
      { length: 8 },
      (unused, index) => `Paragraph number ${index} states a genuine claim about the construction here.`,
    );
    const { derivation, bundlePath } = await derive(paragraphs, {
      text: paragraphs[0]!,
      unreferenced: paragraphs.slice(1),
    });
    expect(derivation.web).toBeUndefined();
    expect(fs.existsSync(bundlePath)).toBe(false);
    const rules = derivation.warnings.map((warning) => warning.rule);
    expect(rules).toEqual([...Array.from({ length: 7 }, () => "web-unreferenced-paragraph"), "web-unreferenced-cap"]);
    const cap = derivation.warnings[7]!.message;
    expect(cap).toContain("never references 7 captured paragraph(s)");
    expect(cap).toContain("carrying 77 of the PDF's 88 tokens, past the 17");
  });

  it("refuses to seal a short paper whose stream drops a quarter of it", async () => {
    // The budget's absolute floor is what one honest margin note costs a
    // short paper; it is not a licence to drop a section. Thirty tokens sit
    // well under that floor and are still a quarter of this paper, so the
    // share of the document — not the constant — has to decide.
    const kept = Array.from(
      { length: 8 },
      (unused, index) => `Kept sentence ${index} that both the PDF and the serialized stream carry verbatim.`,
    );
    const droppedLines = [
      "A print only section of about thirty tokens that the",
      "serialized stream never carries, long enough to matter to a",
      "reader and short enough to sit under the absolute floor.",
    ];
    const { derivation, bundlePath } = await derive([...kept, ...droppedLines], {
      text: kept.join(" "),
      unreferenced: [droppedLines.join(" ")],
    });
    expect(derivation.web).toBeUndefined();
    expect(fs.existsSync(bundlePath)).toBe(false);
    expect(derivation.warnings.map((warning) => warning.rule))
      .toEqual(["web-unreferenced-paragraph", "web-unreferenced-cap"]);
    expect(derivation.warnings[1]!.message).toContain("carrying 30 of the PDF's 134 tokens, past the 26");
  });

  it("keeps a table of small integers, which the folio stripper once ate", async () => {
    // Every row reads as at most four digits once the column spacing is
    // collapsed; deleting them from the PDF side while the stream carries
    // them is a divergence the paper never had.
    const rows = ["1   1", "2   3", "3   7", "4  15", "5  31", "6  63", "7  127", "8  255"];
    const { derivation } = await derive([...body, ...rows, "7"], {
      text: [...body, ...rows].join(" "),
    });
    expect(derivation.warnings).toEqual([]);
    expect(derivation.web).toBeDefined();
  });

  it("skips, loudly, when the stream really does diverge from the PDF", async () => {
    const printOnly = Array.from(
      { length: 6 },
      (unused, index) => `Print only sentence ${index} that the serialized stream never carries at all.`,
    );
    const { derivation } = await derive([...body, ...printOnly], { text: body.join(" ") });
    expect(derivation.web).toBeUndefined();
    expect(derivation.warnings.map((warning) => warning.rule)).toEqual(["web-oracle"]);
    expect(derivation.warnings[0]!.message).toContain("diverges from the PDF text");
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

describe("report-schema hygiene of web messages", () => {
  // The 2026-09-03 lax-65 round trip: a web-encode warning carried a raw
  // transcript tail, the publisher's schema ("message must be one line")
  // refused the report, and a *non-blocking* derivation blocked publication.
  it("folds a transcript tail onto one schema-clean line within the byte budget", () => {
    const folded = oneLineTail("line one\r\nline\ttwo\nERROR: x\u200b\n", 12_000);
    expect(folded).not.toMatch(/[\r\n\t\u200b]/u);
    expect(folded).toBe("line one ⏎ line two ⏎ ERROR: x ");
    const long = oneLineTail("é".repeat(10_000), 12_000);
    expect(Buffer.byteLength(long, "utf8")).toBeLessThanOrEqual(ONE_LINE_TAIL_BYTES + 8);
    expect(long.startsWith("[…] ")).toBe(true);
    expect(long).not.toContain("\ufffd");
    expect(long.normalize("NFC")).toBe(long);
  });

  it("reads the encode's dropped-picture count, defaulting to none", () => {
    expect(parseEncodeReport({ pbBytes: 2, fonts: {} }).droppedPictures).toBe(0);
    expect(parseEncodeReport({ pbBytes: 2, fonts: {}, droppedPictures: 3 }).droppedPictures).toBe(3);
    expect(() => parseEncodeReport({ pbBytes: 2, fonts: {}, droppedPictures: -1 })).toThrow(/droppedPictures/u);
    expect(() => parseEncodeReport({ pbBytes: 2, fonts: {}, droppedPictures: 1.5 })).toThrow(/droppedPictures/u);
  });
});
