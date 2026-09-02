// The paper web derivation end to end on the host path (paper-web-plan.md
// stage 2): the real latexmk+lualatex compile of the fresh web copy, the
// fork's encode child in the hash-pinned venv, the oracle over pdf.js text,
// and the deterministic bundle — through the full host pipeline into
// `paper.web` of the build output. Gated like reflowtex-fork.test.ts: skips
// wherever the reference clone (LAX_REFLOWTEX_SOURCE, or its container
// default), python3, lualatex, or latexmk is absent, so `npm run check`
// stays green everywhere.

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../../src/submission-validation/config.js";
import type { StaticPaper } from "../../src/submission-validation/contracts.js";
import { hostPaperCompiler } from "../../src/submission-validation/host/paper.js";
import { probeLatexmk } from "../../src/submission-validation/host/paper.js";
import { runPaperPhase, type PaperPhaseResult } from "../../src/submission-validation/paper/phase.js";
import { rewriteMarkers, texRewriteOrder } from "../../src/submission-validation/paper/rewrite.js";
import { hostWebDeriver } from "../../src/submission-validation/paper/web.js";
import { REFLOWTEX_REV } from "../../src/submission-validation/pins.js";
import { buildOnHost, freshLaxHome, makePaperSubmission, tmpDir } from "../support/host.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const reflowtexDir = path.join(repoRoot, "reflowtex");

const source = process.env.LAX_REFLOWTEX_SOURCE ?? "/home/user/radek-p/reflowtex";

function answers(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

const hasSource = fs.existsSync(path.join(source, "src", "extract", "serializer.lua"));
const hasPython = answers("python3", ["--version"]);
const hasLualatex = answers("lualatex", ["--version"]);
const hasLatexmk = probeLatexmk()?.supported === true;
const withWeb = hasSource && hasPython && hasLualatex && hasLatexmk;
if (!withWeb) {
  const missing = [
    hasSource ? undefined : `no reflowtex checkout at ${source} (set LAX_REFLOWTEX_SOURCE)`,
    hasPython ? undefined : "python3 not found",
    hasLualatex ? undefined : "lualatex not found",
    hasLatexmk ? undefined : "latexmk >= 4.77 not found",
  ].filter((reason) => reason !== undefined);
  console.warn(`paper-web: skipping — ${missing.join("; ")}`);
}

beforeAll(() => {
  freshLaxHome();
  if (!withWeb) return;
  // Idempotent: clone at the pin, patch strictly, reuse the venv while
  // requirements.lock is unchanged, regenerate latex_pb2.py.
  const result = spawnSync(process.execPath, [path.join(reflowtexDir, "fetch.mjs")], {
    encoding: "utf8",
    env: { ...process.env, LAX_REFLOWTEX_SOURCE: source },
  });
  if (result.status !== 0) {
    throw new Error(`reflowtex:fetch failed:\n${result.stdout}\n${result.stderr}`);
  }
});

/** Run the paper phase alone — real latexmk, real deriver, no Lean — on a
 * one-file paper; the fast path for the deriver's edge cases. */
async function derivePaper(mainTex: string): Promise<PaperPhaseResult> {
  const submissionRoot = tmpDir("lax-web-e2e-");
  fs.mkdirSync(path.join(submissionRoot, "paper"), { recursive: true });
  fs.writeFileSync(path.join(submissionRoot, "paper", "main.tex"), mainTex);
  const files = ["main.tex"];
  const order = texRewriteOrder("main.tex", files);
  const rewritten = rewriteMarkers(order.map((file) => ({
    path: file,
    text: fs.readFileSync(path.join(submissionRoot, "paper", file), "latin1"),
  })));
  expect(rewritten.problems).toEqual([]);
  const paper: StaticPaper = {
    manifest: { folder: "paper", main: "main.tex", engine: "pdflatex" },
    files,
    texFiles: order,
    rewritten: new Map(rewritten.rewritten.map((file) => [file.path, file.text])),
    marks: rewritten.marks,
  };
  const jobDir = tmpDir("lax-web-e2e-job-");
  return runPaperPhase({
    paper,
    submissionRoot,
    jobDir,
    sourceDateEpoch: 1_700_000_000,
    limits: DEFAULT_LIMITS,
    compile: hostPaperCompiler({ echo: false, maxOutputBytes: DEFAULT_LIMITS.maxOutputBytes }),
    deriveWeb: hostWebDeriver(),
  });
}

describe.skipIf(!withWeb)("paper web derivation (host path, real fork)", () => {
  it("derives the bundle through the full pipeline, deterministically, without touching the PDF", async () => {
    const root = makePaperSubmission("lax-21", {
      extraTex:
        "The treewidth of a graph never exceeds its vertex count:\n" +
        "\\begin{equation}\n  \\operatorname{tw}(G) \\le |V(G)| - 1.\n\\end{equation}\n\n" +
        "Efficient offices affirm fluffy waffles.\n",
    });
    const report = await buildOnHost(root, { id: "lax-21", webDeriver: hostWebDeriver() });
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    // no web-* warnings either: the derivation really succeeded
    expect(report.warnings).toEqual([]);

    const paper = report.buildOutput!.paper!;
    const web = paper.web!;
    expect(web.format.tool).toBe("reflowtex");
    expect(web.format.rev).toBe(REFLOWTEX_REV);
    expect(web.format.schema).toMatch(/^[0-9a-f]{64}$/u);
    expect(web.bundle.registryBlob).toBeUndefined();

    // the pipeline hands the bundle over, bound by the recorded address
    expect(report.paperWebPath).toBeDefined();
    const bundle = fs.readFileSync(report.paperWebPath!);
    expect(bundle.length).toBe(web.bundle.bytes);
    expect(createHash("sha256").update(bundle).digest("hex")).toBe(web.bundle.digest);

    // the tar holds exactly the frozen homes: index, blocks, fonts, schema
    const entries = execFileSync("tar", ["-tf", report.paperWebPath!], { encoding: "utf8" })
      .trim()
      .split("\n")
      .sort();
    expect(entries).toContain("index.json");
    expect(entries).toContain("blocks/000.pb");
    expect(entries).toContain("schema/latex.proto");
    expect(entries.some((entry) => /^fonts\/[^/]+\.(otf|ttf)$/u.test(entry))).toBe(true);
    for (const entry of entries) {
      expect(entry).toMatch(/^(index\.json|blocks\/000\.pb|schema\/latex\.proto|fonts\/[^/]+\.(otf|ttf))$/u);
    }
    const index = JSON.parse(
      execFileSync("tar", ["-xOf", report.paperWebPath!, "index.json"], { encoding: "utf8" }),
    ) as { formatVersion: number; tool: string; rev: string; schema: string; blocks: string[]; fonts: Record<string, string> };
    expect(index.formatVersion).toBe(1);
    expect(index.tool).toBe("reflowtex");
    expect(index.rev).toBe(REFLOWTEX_REV);
    expect(index.schema).toBe(web.format.schema);
    expect(index.blocks).toEqual(["blocks/000.pb"]);
    for (const served of Object.values(index.fonts)) expect(entries).toContain(served);
    // the schema pin is the digest of the bundled proto text itself
    const proto = execFileSync("tar", ["-xOf", report.paperWebPath!, "schema/latex.proto"]);
    expect(createHash("sha256").update(proto).digest("hex")).toBe(web.format.schema);

    // a second derivation of the same commit produces the same bundle bytes
    const again = await buildOnHost(root, { id: "lax-21", webDeriver: hostWebDeriver() });
    expect(again.violations).toEqual([]);
    expect(again.buildOutput!.paper!.web!.bundle.digest).toBe(web.bundle.digest);
    expect(fs.readFileSync(again.paperWebPath!).equals(bundle)).toBe(true);

    // fresh-copy isolation: a build without the deriver yields the same PDF
    // digest — the web compile never wrote into the PDF compile's copy
    const withoutWeb = await buildOnHost(root, { id: "lax-21" });
    expect(withoutWeb.violations).toEqual([]);
    expect(withoutWeb.buildOutput!.paper!.pdf.digest).toBe(paper.pdf.digest);
    expect(withoutWeb.buildOutput!.paper!.web).toBeUndefined();
    expect(withoutWeb.paperWebPath).toBeUndefined();
  }, 600_000);

  it("names dropped \\marginpar text in its own warning while the oracle still passes", async () => {
    const result = await derivePaper(`\\documentclass{article}
\\begin{document}
\\section{\\MakeUppercase{Overview of the machinery}}

% lax begin Lax21.One
Incomprehensibility characterizes extraordinarily overparameterized
representations; internationalization necessitates uncharacteristically
comprehensive hyphenation demonstrations of the utmost thoroughness.
% lax end
\\marginpar{A marginal note that only print shows} The text continues
after the marginal note with additional words to fill the line.

The \`\`quoted--text'' uses ligatures: efficient offices affirm fluffy
waffles, and $\\alpha \\le \\beta$ holds inline.
\\end{document}
`);
    expect(result.findings.violations).toEqual([]);
    expect(result.compiled?.web).toBeDefined();
    const warnings = result.findings.warnings;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.rule).toBe("web-unreferenced-paragraph");
    expect(warnings[0]!.message).toContain("A marginal note that only print shows");
    expect(warnings[0]!.message).toContain("\\marginpar");
  }, 600_000);

  it("skips with the first divergence location when print-only text breaks the oracle floor", async () => {
    const result = await derivePaper(`\\documentclass{article}
\\begin{document}

% lax begin Lax21.One
A short shared opening paragraph that both substrates carry verbatim.
% lax end

\\iflaxweb\\else
This entire print-only passage appears in the compiled PDF but never
reaches the reflow stream, and it is deliberately long enough that the
token similarity drops well below the oracle floor, word after word,
sentence after sentence, so the divergence detector has no choice but
to skip the derived view and point at this very spot.
\\fi

A short shared closing paragraph.
\\end{document}
`);
    // non-blocking: the PDF result stands, the web view is skipped loudly
    expect(result.findings.violations).toEqual([]);
    expect(result.compiled).toBeDefined();
    expect(result.compiled!.web).toBeUndefined();
    const oracle = result.findings.warnings.filter((warning) => warning.rule === "web-oracle");
    expect(oracle).toHaveLength(1);
    expect(oracle[0]!.message).toContain("diverges from the PDF text");
    expect(oracle[0]!.message).toContain("token similarity");
    expect(oracle[0]!.message).toContain("first divergence at token");
    expect(oracle[0]!.message).toContain("print only passage");
  }, 600_000);
});
