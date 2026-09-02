// The paper phase's independent piece (paper-plan.md, "Pipeline placement"):
// copy the declared folder with its rewritten `.tex` files into the job
// directory, compile it through an injected executor (latexmk on the host,
// the pinned TeX Live container on the trusted path), read the destinations
// back, and run the count check. Nothing here depends on Lean, so a pipeline
// starts it right after the static gate and joins it before Emit; the join —
// resolving each mark's id to a card — is paper/resolve.ts.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PAPER_CAPS, type ValidationLimits } from "../config.js";
import type { StaticPaper } from "../contracts.js";
import { FindingCollector } from "../findings.js";
import { latexmkArguments, logTail, paperPdfName } from "./compile.js";
import { extractPdf, matchDestinations, type LocatedMark } from "./extract.js";

/** Runs latexmk with `args` in `cwd` — the working copy of the paper folder.
 * The executor owns the environment (paperCompileEnvironment in compile.ts
 * gives the values; where `laxmark.sty` sits depends on the executor). */
export type PaperCompiler = (
  cwd: string,
  args: string[],
  sourceDateEpoch: number,
) => Promise<{ code: number; output: string; timedOut?: boolean }>;

export interface PaperPhaseInput {
  paper: StaticPaper;
  /** The submission root the folder is copied from. */
  submissionRoot: string;
  jobDir: string;
  /** The source commit's time, for reproducible PDFs. */
  sourceDateEpoch: number;
  limits: ValidationLimits;
  compile: PaperCompiler;
}

export interface CompiledPaper {
  /** The compiled PDF inside the job directory. */
  pdfPath: string;
  digest: string;
  bytes: number;
  pages: number;
  pageSizes: Array<[number, number]>;
  /** Marks located in the PDF, in mark-number order, ids unresolved. */
  located: LocatedMark[];
}

export interface PaperPhaseResult {
  compiled?: CompiledPaper;
  findings: FindingCollector;
}

export async function runPaperPhase(input: PaperPhaseInput): Promise<PaperPhaseResult> {
  const findings = new FindingCollector("paper");
  const { paper } = input;
  const workDir = path.join(input.jobDir, "paper", "src");
  copyPaperFolder(paper, path.join(fs.realpathSync(input.submissionRoot), paper.manifest.folder), workDir);

  const result = await input.compile(workDir, latexmkArguments(paper.manifest.engine, paper.manifest.main), input.sourceDateEpoch);
  if (result.code !== 0 || result.timedOut === true) {
    findings.violate(
      "compile",
      (result.timedOut === true
        ? `the paper did not compile within ${Math.round(input.limits.paperCompileTimeoutMs / 60_000)} minutes`
        : `the paper did not compile (latexmk exit ${result.code})`) +
        `; the end of the transcript:\n${logTail(result.output, input.limits.paperLogTailChars)}`,
    );
    return { findings };
  }

  const pdfPath = path.join(workDir, paperPdfName(paper.manifest.main));
  let bytes: number;
  try {
    const stat = fs.lstatSync(pdfPath);
    if (!stat.isFile()) throw new Error("not a regular file");
    bytes = stat.size;
  } catch {
    findings.violate("compile", `latexmk finished but left no ${paperPdfName(paper.manifest.main)} behind`);
    return { findings };
  }
  if (bytes > PAPER_CAPS.pdfBytes) {
    findings.violate("pdf-size", `the compiled paper is ${formatMiB(bytes)}, over the ${formatMiB(PAPER_CAPS.pdfBytes)} cap`);
    return { findings };
  }

  let extracted;
  try {
    extracted = await extractPdf(pdfPath, {
      timeoutMs: input.limits.paperExtractTimeoutMs,
      maxOutputBytes: input.limits.maxOutputBytes,
    });
  } catch (error) {
    findings.violate("extract", error instanceof Error ? error.message : String(error));
    return { findings };
  }
  if (extracted.pages > PAPER_CAPS.pages) {
    findings.violate("pdf-pages", `the compiled paper has ${extracted.pages} pages, over the ${PAPER_CAPS.pages} cap`);
    return { findings };
  }
  if (extracted.pages === 0) {
    findings.violate("pdf-pages", "the compiled paper has no pages");
    return { findings };
  }
  const matched = matchDestinations(paper.marks, extracted);
  for (const problem of matched.problems) findings.violate("marks", problem);
  if (matched.problems.length > 0) return { findings };

  return {
    compiled: {
      pdfPath,
      digest: sha256File(pdfPath),
      bytes,
      pages: extracted.pages,
      pageSizes: extracted.pageSizes,
      located: matched.marks,
    },
    findings,
  };
}

/** The compile copy: every file of the folder, `.tex` files in their
 * rewritten form (re-encoded as they were decoded, latin1 — see the static
 * gate), everything else byte for byte. Never the author's tree. */
function copyPaperFolder(paper: StaticPaper, folder: string, destination: string): void {
  fs.rmSync(destination, { recursive: true, force: true });
  for (const file of paper.files) {
    const target = path.join(destination, ...file.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const rewritten = paper.rewritten.get(file);
    if (rewritten !== undefined) fs.writeFileSync(target, rewritten, "latin1");
    else fs.copyFileSync(path.join(folder, ...file.split("/")), target);
  }
}

/**
 * The original (unrewritten) paper sources, under `paper/` in the capture
 * (paper-plan.md, "Storage"): a registered record stays self-contained if
 * the source repository disappears — the same promise the capture makes for
 * Lean. The file list is the static gate's, so the copy holds exactly what
 * the compile saw, byte for byte, and never the rewritten texts.
 */
export function capturePaperSources(paper: StaticPaper, submissionRoot: string, captureRoot: string): void {
  const folder = path.join(fs.realpathSync(submissionRoot), paper.manifest.folder);
  const destination = path.join(captureRoot, "paper");
  fs.rmSync(destination, { recursive: true, force: true });
  for (const file of paper.files) {
    const target = path.join(destination, ...file.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(folder, ...file.split("/")), target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, 0o444);
  }
}

function sha256File(filename: string): string {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
