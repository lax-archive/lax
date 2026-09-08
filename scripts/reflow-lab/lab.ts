#!/usr/bin/env -S npx tsx
// The reflow lab: a local corpus harness for the paper layer's derived web
// view (paper-web-plan.md). It runs the *production* derivation — the
// docker-backed container paper compiler and `containerWebDeriver` over the
// pinned TeX Live image, the fetched fork's encode child, the oracle, the
// bundle seal — over a corpus of real LaTeX papers, then builds the real
// lax-website (real schema gate, real vendored viewer, real CSS) over
// synthesized records, screenshots every reflow page beside its PDF, and
// aggregates a report. Nothing here is a fake: what the lab derives is what
// the Validate job would derive, byte for byte, given the same fork and
// sources.
//
//   npm run reflow-lab -- derive [name…] [--jobs N] [--force]
//   npm run reflow-lab -- site
//   npm run reflow-lab -- shots [name…] [--width 1100]
//   npm run reflow-lab -- report
//   npm run reflow-lab -- all [name…] [--jobs N] [--force] [--width 1100]
//   npm run reflow-lab -- smoke        # the self-test on fixtures/smoke
//
// Everything generated lives under LAX_REFLOW_LAB (default
// ~/.cache/lax-reflow-lab), never in the repository. See README.md.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Profiler, type Span } from "../../src/shared/profile.js";
import {
  configuredRuntime,
  limitsFor,
  PAPER_CAPS,
  type ValidationLimits,
} from "../../src/submission-validation/config.js";
import type { PaperEngine, StaticPaper } from "../../src/submission-validation/contracts.js";
import { epoch } from "../../src/submission-validation/environments.js";
import { laxmarkDirectory } from "../../src/submission-validation/host/paper.js";
import { paperPdfName } from "../../src/submission-validation/paper/compile.js";
import { containerPaperCompiler } from "../../src/submission-validation/paper/container.js";
import { extractPdfText } from "../../src/submission-validation/paper/extract.js";
import { runPaperPhase, type PaperCompiler } from "../../src/submission-validation/paper/phase.js";
import { rewriteMarkers, texRewriteOrder } from "../../src/submission-validation/paper/rewrite.js";
import {
  parseStreamReport,
  reflowtexDirectory,
  type StreamReport,
  type WebDeriver,
} from "../../src/submission-validation/paper/web.js";
import { containerWebDeriver } from "../../src/submission-validation/paper/web-container.js";
import { compareTokens, judgeWebOracle } from "../../src/submission-validation/paper/web-oracle.js";
import { ContainerRunner } from "../../src/submission-validation/sandbox/container.js";

// ── places ─────────────────────────────────────────────────────────────────

const LAB_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(LAB_DIR, "..", "..");
const ROOT = path.resolve(process.env.LAX_REFLOW_LAB ?? path.join(os.homedir(), ".cache", "lax-reflow-lab"));
const WEBSITE = path.resolve(process.env.LAX_WEBSITE_DIR ?? path.join(os.homedir(), "git", "lax-website"));
const DIRS = {
  corpus: path.join(ROOT, "corpus"),
  jobs: path.join(ROOT, "jobs"),
  db: path.join(ROOT, "db"),
  papers: path.join(ROOT, "papers"),
  bundles: path.join(ROOT, "bundles"),
  site: path.join(ROOT, "site"),
  shots: path.join(ROOT, "shots"),
} as const;
const SITE_LOG = path.join(ROOT, "site-build.log");
const SITE_JSON = path.join(ROOT, "site.json");
const REPORT_JSON = path.join(ROOT, "report.json");
const REPORT_MD = path.join(ROOT, "report.md");

/** The corpus papers are not commits, so the compile is pinned to one fixed
 * source date — reproducible across runs, like the fixture generator's. */
const DEFAULT_SOURCE_DATE_EPOCH = 1_700_000_000;
/** How tall one screenshot slice is, in CSS pixels. */
const SLICE_PX = 1400;
/** The narrow rendering: the width, and how many slices of it are kept. */
const NARROW_WIDTH = 700;
const NARROW_SLICES = 2;
/** How many PDF pages are rasterized beside the reflow shots. */
const PDF_PAGES = 4;

// ── the corpus ─────────────────────────────────────────────────────────────

const ENGINES: readonly PaperEngine[] = ["pdflatex", "lualatex", "xelatex"];

/** `corpus/<name>/lab.json`, as the README specifies it. */
interface CorpusEntry {
  name: string;
  dir: string;
  main: string;
  engine: PaperEngine;
  class: string;
  source: string;
  title?: string;
  sourceDateEpoch?: number;
}

function readCorpusEntry(name: string): CorpusEntry | { name: string; problem: string } {
  const dir = path.join(DIRS.corpus, name);
  const file = path.join(dir, "lab.json");
  if (!fs.existsSync(file)) return { name, problem: "no lab.json" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return { name, problem: `lab.json does not parse: ${message(error)}` };
  }
  if (!isObject(parsed)) return { name, problem: "lab.json must hold an object" };
  const main = parsed.main;
  const engine = parsed.engine;
  if (typeof main !== "string" || main === "" || path.isAbsolute(main) || main.split("/").includes("..")) {
    return { name, problem: "lab.json: main must be a relative .tex path inside the entry" };
  }
  if (typeof engine !== "string" || !(ENGINES as readonly string[]).includes(engine)) {
    return { name, problem: `lab.json: engine must be one of ${ENGINES.join("|")}` };
  }
  const entry: CorpusEntry = {
    name,
    dir,
    main,
    engine: engine as PaperEngine,
    class: typeof parsed.class === "string" ? parsed.class : "",
    source: typeof parsed.source === "string" ? parsed.source : "",
  };
  if (typeof parsed.title === "string") entry.title = parsed.title;
  if (typeof parsed.sourceDateEpoch === "number" && Number.isSafeInteger(parsed.sourceDateEpoch)) {
    entry.sourceDateEpoch = parsed.sourceDateEpoch;
  }
  return entry;
}

/** Every corpus entry (or the named ones), in name order; an entry another
 * agent is still writing — no lab.json yet, or one that does not parse — is
 * reported and skipped, never fatal. */
function readCorpus(names: string[]): CorpusEntry[] {
  fs.mkdirSync(DIRS.corpus, { recursive: true });
  const candidates = names.length > 0
    ? names
    : fs.readdirSync(DIRS.corpus, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const entries: CorpusEntry[] = [];
  for (const name of candidates) {
    const entry = readCorpusEntry(name);
    if ("problem" in entry) {
      log(name, `skipped: ${entry.problem}`);
      if (names.length > 0) process.exitCode = 1;
      continue;
    }
    entries.push(entry);
  }
  return entries;
}

// ── the static gate's paper half, mirrored ─────────────────────────────────
// phases/static.ts's checkPaper needs a whole submission (manifest, license,
// the two Lean packages) around the paper; a corpus entry is the paper folder
// alone. This is the same walk, the same caps, and the same rewriter call,
// for the manifest block `paper: {folder: ".", main, engine}`.

/** What the lab leaves in a corpus entry that is not part of the paper. */
const LAB_OWN_FILES = new Set(["lab.json"]);

function buildStaticPaper(entry: CorpusEntry): { paper?: StaticPaper; problems: string[] } {
  const problems: string[] = [];
  const folderReal = fs.realpathSync(entry.dir);
  const files: string[] = [];
  let bytes = 0;
  const walk = (relative: string): void => {
    const directory = relative === "" ? folderReal : path.join(folderReal, relative);
    for (const dirent of fs.readdirSync(directory, { withFileTypes: true })) {
      const relativeEntry = relative === "" ? dirent.name : `${relative}/${dirent.name}`;
      if (dirent.isSymbolicLink()) {
        problems.push(`paper folder contains a symlink, which is not accepted: ${relativeEntry}`);
        continue;
      }
      if (dirent.isDirectory()) {
        if (dirent.name === ".git" || dirent.name === ".lake") continue;
        walk(relativeEntry);
        continue;
      }
      if (!dirent.isFile()) {
        problems.push(`paper folder contains a non-regular entry: ${relativeEntry}`);
        continue;
      }
      if (relative === "" && LAB_OWN_FILES.has(dirent.name)) continue;
      files.push(relativeEntry);
      bytes += fs.statSync(path.join(folderReal, relativeEntry)).size;
    }
  };
  walk("");
  if (files.length > PAPER_CAPS.folderFiles) problems.push(`paper folder holds more than ${PAPER_CAPS.folderFiles} files`);
  if (bytes > PAPER_CAPS.folderBytes) problems.push(`paper folder exceeds ${PAPER_CAPS.folderBytes} bytes`);
  if (!files.includes(entry.main)) problems.push(`paper entry file ${entry.main} is not a regular file under the entry`);
  if (problems.length > 0) return { problems };
  files.sort();
  const texFiles = texRewriteOrder(entry.main, files);
  const rewrite = rewriteMarkers(
    texFiles.map((file) => ({ path: file, text: fs.readFileSync(path.join(folderReal, file), "latin1") })),
  );
  if (rewrite.problems.length > 0) return { problems: rewrite.problems };
  return {
    paper: {
      manifest: { folder: ".", main: entry.main, engine: entry.engine },
      files,
      texFiles,
      rewritten: new Map(rewrite.rewritten.map((file) => [file.path, file.text])),
      marks: rewrite.marks,
    },
    problems,
  };
}

// ── the skip key: what a derivation depends on ─────────────────────────────

interface InputKey {
  key: string;
  parts: Record<string, string>;
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hashTree(root: string, skip: (relative: string, name: string) => boolean): string {
  const hash = createHash("sha256");
  const walk = (relative: string): void => {
    const directory = relative === "" ? root : path.join(root, relative);
    for (const dirent of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const relativeEntry = relative === "" ? dirent.name : `${relative}/${dirent.name}`;
      if (skip(relativeEntry, dirent.name)) continue;
      if (dirent.isDirectory()) {
        walk(relativeEntry);
        continue;
      }
      if (!dirent.isFile()) continue;
      hash.update(`${relativeEntry}\0`);
      hash.update(fs.readFileSync(path.join(root, relativeEntry)));
      hash.update("\0");
    }
  };
  walk("");
  return hash.digest("hex");
}

function gitOutput(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

/** The fork checkout's HEAD plus a hash of its working-tree diff (tracked
 * changes against HEAD), so an experiment on the serializer or the encode
 * modules invalidates every entry — plus the lax-side encode driver. */
function reflowtexKey(): Record<string, string> {
  const root = reflowtexDirectory();
  const checkout = path.join(root, "checkout");
  const head = gitOutput(checkout, ["rev-parse", "HEAD"]).trim();
  const diff = gitOutput(checkout, ["diff", "HEAD", "--", ".", ":(exclude)build"]);
  const driver = ["encode_web.py", "requirements.lock"]
    .map((name) => {
      const file = path.join(root, name);
      return fs.existsSync(file) ? sha256(fs.readFileSync(file)) : "missing";
    })
    .join(",");
  return {
    reflowtexHead: head === "" ? "unknown" : head,
    reflowtexDiff: sha256(diff),
    reflowtexDriver: sha256(driver),
  };
}

function laxPaperKey(): string {
  const hash = createHash("sha256");
  const paperDir = path.join(REPO, "src", "submission-validation", "paper");
  for (const name of fs.readdirSync(paperDir).filter((n) => n.endsWith(".ts")).sort()) {
    hash.update(`${name}\0`).update(fs.readFileSync(path.join(paperDir, name))).update("\0");
  }
  const texDir = path.join(REPO, "assets", "tex");
  for (const name of fs.readdirSync(texDir).filter((n) => n.endsWith(".sty")).sort()) {
    hash.update(`${name}\0`).update(fs.readFileSync(path.join(texDir, name))).update("\0");
  }
  return hash.digest("hex");
}

function inputKey(entry: CorpusEntry, shared: Record<string, string>): InputKey {
  const parts = {
    corpus: hashTree(entry.dir, (_relative, name) => name === ".git" || name === ".lake"),
    ...shared,
  };
  return { key: sha256(JSON.stringify(parts)), parts };
}

// ── the job record ─────────────────────────────────────────────────────────

type JobStatus = "derived" | "web-skipped" | "pdf-failed";

interface Finding {
  kind: "violation" | "warning";
  rule: string;
  message: string;
}

interface OracleReport {
  /** Token similarity, exact when `bounded` is false; when the pair is under
   * 0.5 the search stops and this is the bound it stopped at. */
  similarity: number;
  bounded: boolean;
  floor: number;
  passes: boolean;
  /** The production divergence report, present only when the gate fails. */
  divergence?: { index: number; pdf: string; stream: string };
  /** Where the two token sequences first differ, whether or not the gate
   * passes — the pointer into the `oracle-*.txt` dumps beside lab.json. */
  firstDifference?: { index: number; pdf: string; stream: string };
  /** The compared sequences' lengths — what the `oracle-*.txt` dumps hold. */
  pdfTokens: number;
  streamTokens: number;
  folioLines: number;
  headerLines: number;
  marginNumbers: number;
  /** The PDF's margin text runs (`\marginpar` notes pdf.js splices into
   * the body lines): how many the assembly took off, how many the stream
   * carried and were taken off its side, and how many it lacked, which
   * went back onto the PDF side. */
  marginTextRuns: number;
  marginTextMatched: number;
  marginTextUnmatched: number;
  /** The stream's relocated paragraphs (footnotes set as endnotes): how
   * many the PDF carried and were taken off its side, the tokens that
   * took, and how many it lacked, which stand on the stream side. */
  relocatedParagraphs: number;
  relocatedMatched: number;
  relocatedTokens: number;
  relocatedUnmatched: number;
  unreferencedParagraphs: number;
  omittedParagraphs: number;
  removedTokens: number;
  budgetTokens: number;
  overBudget: boolean;
}

interface JobRecord {
  name: string;
  corpus: Omit<CorpusEntry, "name" | "dir">;
  status: JobStatus;
  inputKey: string;
  inputs: Record<string, string>;
  derivedAt: string;
  wallMs: number;
  timings: {
    pdfCompileMs?: number;
    webMs?: number;
    /** Container spans by label (`paper-compile`, `paper-web-compile`,
     * `paper-web-export`, `image-inspect`), summed. */
    containers: Record<string, number>;
  };
  findings: Finding[];
  /** The `web-*` rule the derivation stopped at, when it did. */
  skipRule?: string;
  skipMessage?: string;
  error?: string;
  pdf?: { path: string; digest: string; bytes: number; pages: number; pageSizes: Array<[number, number]> };
  web?: { bundlePath: string; digest: string; bytes: number; format: { tool: string; rev: string; schema: string } };
  oracle?: OracleReport;
}

function jobRecordPath(name: string): string {
  return path.join(DIRS.jobs, name, "lab.json");
}

function readJobRecord(name: string): JobRecord | undefined {
  const file = jobRecordPath(name);
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as JobRecord;
  } catch {
    return undefined;
  }
}

function readAllJobRecords(): JobRecord[] {
  if (!fs.existsSync(DIRS.jobs)) return [];
  return fs.readdirSync(DIRS.jobs).sort().flatMap((name) => {
    const record = readJobRecord(name);
    return record === undefined ? [] : [record];
  });
}

// ── derive ─────────────────────────────────────────────────────────────────

/** The stream report, read back from the encode child's `stream.json` the
 * derivation keeps in `paper/web/out/` — through the deriver's own parser,
 * so the lab rejects exactly what production rejects. */
function readStreamReport(file: string): StreamReport | undefined {
  if (!fs.existsSync(file)) return undefined;
  return parseStreamReport(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
}

/**
 * The oracle, recomputed from the kept artifacts by the code
 * `encodeAndSealWebBundle` runs (`judgeWebOracle`, web-oracle.ts): the
 * PDF's text layer through pdf.js, the stream report as parsed, one
 * judgment. The production call reports a number only when it fails, so
 * the lab runs the comparison once more at 0.5 for the number when the
 * judgment's own comparison stopped at the floor.
 */
async function recomputeOracle(jobDir: string, main: string, limits: ValidationLimits): Promise<OracleReport | undefined> {
  const stream = readStreamReport(path.join(jobDir, "paper", "web", "out", "stream.json"));
  if (stream === undefined) return undefined;
  const pdfPath = path.join(jobDir, "paper", "src", paperPdfName(main));
  if (!fs.existsSync(pdfPath)) return undefined;
  const pages = await extractPdfText(pdfPath, {
    timeoutMs: limits.paperExtractTimeoutMs,
    maxOutputBytes: limits.maxOutputBytes,
  });
  const judged = judgeWebOracle({ pdfPages: pages, stream, floor: limits.paperWebOracleSimilarity });
  const measured = judged.verdict.divergence === undefined
    ? judged.verdict
    : compareTokens(judged.pdfTokens, judged.streamTokens, 0.5);
  // Both compared sequences, one token per line, so `diff jobs/<name>/oracle-pdf.txt
  // jobs/<name>/oracle-stream.txt` shows every run the number summarizes.
  fs.writeFileSync(path.join(jobDir, "oracle-pdf.txt"), `${judged.pdfTokens.join("\n")}\n`);
  fs.writeFileSync(path.join(jobDir, "oracle-stream.txt"), `${judged.streamTokens.join("\n")}\n`);
  return {
    similarity: measured.similarity,
    bounded: measured.divergence !== undefined,
    floor: limits.paperWebOracleSimilarity,
    passes: judged.passes,
    ...(judged.verdict.divergence === undefined ? {} : { divergence: judged.verdict.divergence }),
    ...(judged.firstDifference === undefined ? {} : { firstDifference: judged.firstDifference }),
    pdfTokens: judged.pdfTokens.length,
    streamTokens: judged.streamTokens.length,
    folioLines: judged.assembled.folioLines,
    headerLines: judged.assembled.headerLines,
    marginNumbers: judged.assembled.marginNumbers,
    marginTextRuns: judged.assembled.marginText.length,
    marginTextMatched: judged.margin.matched,
    marginTextUnmatched: judged.margin.unmatched.length,
    relocatedParagraphs: stream.relocated.length,
    relocatedMatched: judged.relocation.matched,
    relocatedTokens: judged.relocation.matchedTokens,
    relocatedUnmatched: judged.relocation.unmatched.length,
    unreferencedParagraphs: stream.unreferenced.length,
    omittedParagraphs: judged.subtraction.omitted.length,
    removedTokens: judged.subtraction.removedTokens,
    budgetTokens: judged.subtraction.budgetTokens,
    overBudget: judged.subtraction.overBudget,
  };
}

function containerSpans(root: Span): Record<string, number> {
  const sums: Record<string, number> = {};
  const walk = (span: Span): void => {
    if (span.container === true) {
      const label = span.name.replace(/^container /u, "");
      sums[label] = (sums[label] ?? 0) + span.ms;
    }
    for (const child of span.children) walk(child);
  };
  walk(root);
  for (const key of Object.keys(sums)) sums[key] = Math.round(sums[key]!);
  return sums;
}

async function deriveEntry(entry: CorpusEntry, shared: Record<string, string>, force: boolean): Promise<JobRecord | undefined> {
  const key = inputKey(entry, shared);
  const previous = readJobRecord(entry.name);
  if (!force && previous !== undefined && previous.inputKey === key.key) {
    log(entry.name, `unchanged since ${previous.derivedAt} (${previous.status}); skipping — use --force to rerun`);
    return previous;
  }
  const jobDir = path.join(DIRS.jobs, entry.name);
  fs.rmSync(jobDir, { recursive: true, force: true });
  fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });

  const started = performance.now();
  const record: JobRecord = {
    name: entry.name,
    corpus: {
      main: entry.main,
      engine: entry.engine,
      class: entry.class,
      source: entry.source,
      ...(entry.title === undefined ? {} : { title: entry.title }),
      ...(entry.sourceDateEpoch === undefined ? {} : { sourceDateEpoch: entry.sourceDateEpoch }),
    },
    status: "pdf-failed",
    inputKey: key.key,
    inputs: key.parts,
    derivedAt: new Date().toISOString(),
    wallMs: 0,
    timings: { containers: {} },
    findings: [],
  };
  const finish = (): JobRecord => {
    record.wallMs = Math.round(performance.now() - started);
    fs.writeFileSync(jobRecordPath(entry.name), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  };

  const built = buildStaticPaper(entry);
  if (built.paper === undefined) {
    record.findings = built.problems.map((problem) => ({ kind: "violation", rule: "paper", message: problem }));
    log(entry.name, `static gate: ${built.problems.join("; ")}`);
    return finish();
  }

  // The production wiring (pipeline.ts): one ContainerRunner over the job
  // directory with the epoch's limits, the container paper compiler with
  // the shipped sty directory, and the container web deriver over the same
  // runner. The paper containers mount only the job copy and the sty
  // directory, so the Lean runtime is never verified or provisioned.
  const environment = epoch();
  const limits = limitsFor(environment);
  const profiler = new Profiler();
  const runner = new ContainerRunner(environment, configuredRuntime(environment), limits, jobDir, profiler);
  const compile = containerPaperCompiler(runner, limits, laxmarkDirectory());
  const timedCompile: PaperCompiler = async (cwd, args, sourceDateEpoch) => {
    const t = performance.now();
    try {
      return await compile(cwd, args, sourceDateEpoch);
    } finally {
      record.timings.pdfCompileMs = Math.round(performance.now() - t);
    }
  };
  const derive = containerWebDeriver(runner);
  const timedDerive: WebDeriver = async (input) => {
    const t = performance.now();
    try {
      return await derive(input);
    } finally {
      record.timings.webMs = Math.round(performance.now() - t);
    }
  };

  log(entry.name, `deriving (${entry.engine}, ${built.paper.files.length} files)`);
  try {
    const result = await runPaperPhase({
      paper: built.paper,
      submissionRoot: entry.dir,
      jobDir,
      sourceDateEpoch: entry.sourceDateEpoch ?? DEFAULT_SOURCE_DATE_EPOCH,
      limits,
      compile: timedCompile,
      deriveWeb: timedDerive,
    });
    record.findings = [
      ...result.findings.violations.map((f): Finding => ({ kind: "violation", rule: f.rule, message: f.message })),
      ...result.findings.warnings.map((f): Finding => ({ kind: "warning", rule: f.rule, message: f.message })),
    ];
    const compiled = result.compiled;
    if (compiled !== undefined) {
      record.pdf = {
        path: compiled.pdfPath,
        digest: compiled.digest,
        bytes: compiled.bytes,
        pages: compiled.pages,
        pageSizes: compiled.pageSizes,
      };
      if (compiled.web !== undefined) {
        record.web = {
          bundlePath: compiled.web.bundlePath,
          digest: compiled.web.digest,
          bytes: compiled.web.bytes,
          format: compiled.web.format,
        };
        record.status = "derived";
      } else {
        record.status = "web-skipped";
        const skip = [...record.findings].reverse().find(
          (f) => f.kind === "warning" && f.rule.startsWith("web-") && f.message.startsWith("the reflow view was not derived"),
        );
        if (skip !== undefined) {
          record.skipRule = skip.rule;
          record.skipMessage = skip.message;
        }
      }
    }
  } catch (error) {
    record.error = message(error);
    log(entry.name, `failed: ${record.error}`);
  }
  record.timings.containers = containerSpans(profiler.snapshot());

  if (record.pdf !== undefined) {
    try {
      const oracle = await recomputeOracle(jobDir, entry.main, limits);
      if (oracle !== undefined) record.oracle = oracle;
    } catch (error) {
      record.findings.push({ kind: "warning", rule: "lab-oracle", message: `the lab could not recompute the oracle: ${message(error)}` });
    }
  }
  const done = finish();
  const similarity = done.oracle === undefined ? "" : `, oracle ${done.oracle.similarity.toFixed(4)}`;
  log(entry.name, `${done.status}${done.skipRule === undefined ? "" : ` (${done.skipRule})`}${similarity}, ${(done.wallMs / 1000).toFixed(1)} s`);
  return done;
}

async function commandDerive(names: string[], options: Options): Promise<void> {
  ensureLabDirs();
  const entries = readCorpus(names);
  if (entries.length === 0) {
    console.log(`no corpus entries under ${DIRS.corpus} (each needs a lab.json — see scripts/reflow-lab/README.md)`);
    return;
  }
  const shared = { ...reflowtexKey(), laxPaper: laxPaperKey() };
  console.log(`deriving ${entries.length} entr${entries.length === 1 ? "y" : "ies"} with ${options.jobs} at a time into ${DIRS.jobs}`);
  await pool(entries, options.jobs, async (entry) => {
    try {
      await deriveEntry(entry, shared, options.force);
    } catch (error) {
      log(entry.name, `the lab itself failed: ${message(error)}`);
      process.exitCode = 1;
    }
  });
}

// ── site ───────────────────────────────────────────────────────────────────

/** A corpus name as a record id: the site writes `<id>/paper.html`, and the
 * website sorts ids by their number, which a lab name has none of — it
 * simply sorts last, by name. The name is the id so the page is findable. */
function recordId(name: string): string {
  return name;
}

/** One lax-database record per derived entry, in the shape of a real paper
 * record (lax-65): record.json, owner-list.json, and a build-output.json
 * whose `paper` block carries the lab's digests. No concepts, no proofs,
 * no marks — the minimum the loader and the generator accept. */
function writeRecord(job: JobRecord): void {
  const pdf = job.pdf!;
  const id = recordId(job.name);
  const environment = epoch();
  const dir = path.join(DIRS.db, id);
  fs.mkdirSync(dir, { recursive: true });
  const createdAt = job.derivedAt;
  fs.writeFileSync(
    path.join(dir, "record.json"),
    `${JSON.stringify({ specVersion: "1", id, state: "registered", createdAt, registeredAt: createdAt }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(dir, "owner-list.json"),
    `${JSON.stringify({ specVersion: "1", owners: [{ githubId: 1, handle: "reflow-lab" }] }, null, 2)}\n`,
  );
  const title = job.corpus.title ?? job.name;
  const manifest = {
    specVersion: "1",
    id,
    leanVersion: environment.id,
    mathlibVersion: environment.mathlibCommit,
    title,
    authors: [{ name: "Reflow lab" }],
    bibEntries: [],
    paper: { folder: ".", main: job.corpus.main, engine: job.corpus.engine },
  };
  const abstract =
    `Reflow lab corpus entry \`${job.name}\` (class ${job.corpus.class || "unknown"}, ${job.corpus.engine}` +
    `${job.corpus.source ? `, source: ${job.corpus.source}` : ""}). ` +
    `Derived ${job.derivedAt}; status ${job.status}.\n`;
  const paper = {
    folder: ".",
    main: job.corpus.main,
    engine: job.corpus.engine,
    pdf: { digest: pdf.digest, bytes: pdf.bytes, pages: pdf.pages },
    pageSizes: pdf.pageSizes,
    marks: [],
    ...(job.web === undefined
      ? {}
      : { web: { format: job.web.format, bundle: { digest: job.web.digest, bytes: job.web.bytes } } }),
  };
  const output = {
    specVersion: "1",
    id,
    inputs: { manifest, abstract },
    requiredByConcepts: [],
    requiredByProofs: [],
    concepts: [],
    proofs: [],
    capture: { leanToolchain: environment.leanToolchain, mathlibCommit: environment.mathlibCommit },
    paper,
  };
  fs.writeFileSync(path.join(dir, "build-output.json"), `${JSON.stringify(output, null, 2)}\n`);
}

interface SiteRecord {
  builtAt: string;
  websiteDir: string;
  records: string[];
  /** Records the site build dropped to the PDF-only page, by the log line
   * that said why (the schema/tool/format gate). */
  gate: Record<string, string>;
  ok: boolean;
}

async function commandSite(): Promise<void> {
  ensureLabDirs();
  const jobs = readAllJobRecords().filter((job) => job.pdf !== undefined && fs.existsSync(job.pdf.path));
  if (jobs.length === 0) {
    console.log("no derived entries with a PDF under jobs/; run `derive` first");
    return;
  }
  fs.rmSync(DIRS.db, { recursive: true, force: true });
  fs.rmSync(DIRS.site, { recursive: true, force: true });
  fs.mkdirSync(DIRS.db, { recursive: true });
  for (const job of jobs) {
    writeRecord(job);
    fs.copyFileSync(job.pdf!.path, path.join(DIRS.papers, `${job.pdf!.digest}.pdf`));
    if (job.web !== undefined && fs.existsSync(job.web.bundlePath)) {
      fs.copyFileSync(job.web.bundlePath, path.join(DIRS.bundles, `${job.web.digest}.tar`));
    }
  }
  const cli = path.join(WEBSITE, "src", "cli.ts");
  if (!fs.existsSync(cli)) throw new Error(`lax-website is not at ${WEBSITE} (set LAX_WEBSITE_DIR)`);
  const args = ["tsx", cli, "build", "--database", DIRS.db, "--papers", DIRS.papers, "--bundles", DIRS.bundles, "--out", DIRS.site];
  console.log(`building the site: (cd ${WEBSITE} && npx ${args.join(" ")})`);
  const { code, output } = await runCapturing("npx", args, WEBSITE);
  fs.writeFileSync(SITE_LOG, output);
  const gate: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const match = /^([^:\s]+): (paper web .*rendering the PDF-only page)$/u.exec(line.trim());
    if (match !== null) gate[match[1]!] = match[2]!;
  }
  const site: SiteRecord = {
    builtAt: new Date().toISOString(),
    websiteDir: WEBSITE,
    records: jobs.map((job) => recordId(job.name)),
    gate,
    ok: code === 0,
  };
  fs.writeFileSync(SITE_JSON, `${JSON.stringify(site, null, 2)}\n`);
  if (code !== 0) {
    process.stdout.write(output);
    throw new Error(`the site build failed (exit ${code}); transcript in ${SITE_LOG}`);
  }
  for (const [id, line] of Object.entries(gate)) console.log(`  gate: ${id}: ${line}`);
  console.log(`site built: ${DIRS.site} (${jobs.length} paper page${jobs.length === 1 ? "" : "s"}; transcript in ${SITE_LOG})`);
}

// ── shots ──────────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".pdf": "application/pdf",
  ".otf": "font/otf",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".pb": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
};

/** Serve the built site from its root — the viewer's font map resolves
 * `../fonts/` against the page, and `fonts/` sits at the site root. */
function serveSite(): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    let relative = decodeURIComponent(url.pathname).replace(/^\/+/u, "");
    if (relative === "" || relative.endsWith("/")) relative += "index.html";
    const file = path.resolve(DIRS.site, relative);
    const inside = file === DIRS.site || file.startsWith(`${DIRS.site}${path.sep}`);
    if (!inside || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    response.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}

// The slice of Playwright the lab uses, typed by hand: the package is
// installed under scripts/reflow-lab/node_modules only (its own
// package.json), so `npm run typecheck` must not depend on it.
interface PwPage {
  on(event: string, handler: (...args: any[]) => void): void;
  goto(url: string, options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle"; timeout?: number }): Promise<unknown>;
  click(selector: string, options?: { timeout?: number; noWaitAfter?: boolean }): Promise<void>;
  $(selector: string): Promise<PwElementHandle | null>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  waitForFunction(expression: string, arg?: unknown, options?: { timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T = unknown>(expression: string): Promise<T>;
  screenshot(options: {
    path: string;
    fullPage?: boolean;
    clip?: { x: number; y: number; width: number; height: number };
    timeout?: number;
  }): Promise<unknown>;
  close(): Promise<void>;
}
interface PwElementHandle {
  click(options?: { timeout?: number; noWaitAfter?: boolean }): Promise<void>;
}
interface PwBrowser {
  newPage(options?: { viewport?: { width: number; height: number } }): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwModule {
  chromium: { launch(options?: Record<string, unknown>): Promise<PwBrowser> };
}

async function loadPlaywright(): Promise<PwModule> {
  const entry = path.join(LAB_DIR, "node_modules", "playwright", "index.mjs");
  if (!fs.existsSync(entry)) {
    throw new Error(`playwright is not installed: run (cd ${LAB_DIR} && npm install) — see README.md`);
  }
  return (await import(pathToFileURL(entry).href)) as PwModule;
}

interface ViewStats {
  width: number;
  blocks: number;
  svgs: number;
  texts: number;
  missingGlyphs: number;
  /** The reflow document's own height, and the whole page's. */
  docHeightPx: number;
  pageHeightPx: number;
  consoleErrors: string[];
  pageErrors: string[];
  consoleWarnings: number;
  /** Errors matching IGNORED_CONSOLE (the site's comment widget). */
  ignoredConsoleErrors: number;
  renderErrors: string[];
  screenshots: string[];
  error?: string;
}

/** Console errors the built site produces on any origin but its own, none
 * of them about the reflow view: the Remark42 comments iframe is refused
 * by its frame-ancestors policy when the page is served from the lab. They
 * are counted, never listed. */
const IGNORED_CONSOLE = [/comments\.laxarchive\.org/u, /frame-ancestors/u];

const STATS_JS = `(() => {
  const doc = document.getElementById('manuscript-reflow-doc');
  const blocks = [...document.querySelectorAll('.latex-block')];
  return {
    blocks: blocks.length,
    svgs: document.querySelectorAll('.latex-block svg').length,
    texts: document.querySelectorAll('.latex-block text').length,
    missingGlyphs: document.querySelectorAll('.latex-missing-glyph').length,
    docHeightPx: doc ? Math.round(doc.getBoundingClientRect().height) : 0,
    pageHeightPx: document.documentElement.scrollHeight,
    renderErrors: blocks
      .filter((b) => (b.textContent || '').startsWith('Render error'))
      .map((b) => (b.textContent || '').slice(0, 300)),
  };
})()`;

/** Open the paper page, switch to the reflow view, paint every segment
 * (the viewer paints lazily on approach; `beforeprint` is its own hook to
 * paint everything), then measure and shoot. */
async function renderView(
  browser: PwBrowser,
  url: string,
  width: number,
  shotsDir: string,
  maxSlices: number | undefined,
): Promise<ViewStats> {
  const stats: ViewStats = {
    width,
    blocks: 0,
    svgs: 0,
    texts: 0,
    missingGlyphs: 0,
    docHeightPx: 0,
    pageHeightPx: 0,
    consoleErrors: [],
    pageErrors: [],
    consoleWarnings: 0,
    ignoredConsoleErrors: 0,
    renderErrors: [],
    screenshots: [],
  };
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  page.on("console", (msg: { type(): string; text(): string }) => {
    if (msg.type() === "error") {
      const text = msg.text();
      if (IGNORED_CONSOLE.some((pattern) => pattern.test(text))) stats.ignoredConsoleErrors += 1;
      else stats.consoleErrors.push(text.slice(0, 500));
    } else if (msg.type() === "warning") stats.consoleWarnings += 1;
  });
  page.on("pageerror", (error: unknown) => stats.pageErrors.push(message(error).slice(0, 500)));
  try {
    await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    // The reflow page opens on the reflowed text (lax-website main since the
    // paper.html / paper-pdf.html split); an older site keeps the toggle.
    const toggle = await page.$('button[data-view="reflow"]');
    if (toggle) await toggle.click({ timeout: 60_000, noWaitAfter: true });
    await page.waitForSelector(".latex-block svg", { timeout: 180_000 });
    // The viewer initializes blocks sequentially; every block must have
    // laid out before the whole document is painted.
    await page.waitForFunction(
      "[...document.querySelectorAll('.latex-block')].every((b) => b.querySelector('svg') || (b.textContent || '').startsWith('Render error'))",
      undefined,
      { timeout: 180_000 },
    );
    await page.evaluate("document.fonts.ready.then(() => true)");
    await page.waitForTimeout(800);
    await page.evaluate("window.dispatchEvent(new Event('beforeprint')), true");
    await page.waitForTimeout(500);
    Object.assign(stats, await page.evaluate<Partial<ViewStats>>(STATS_JS));
    const full = path.join(shotsDir, `reflow-${width}.png`);
    if (maxSlices === undefined) {
      try {
        await page.screenshot({ path: full, fullPage: true, timeout: 120_000 });
        stats.screenshots.push(full);
      } catch (error) {
        stats.error = `full-page screenshot failed: ${message(error)}`;
      }
    }
    const slices = Math.ceil(stats.pageHeightPx / SLICE_PX);
    const wanted = maxSlices === undefined ? slices : Math.min(slices, maxSlices);
    for (let k = 0; k < wanted; k += 1) {
      const y = k * SLICE_PX;
      const file = path.join(shotsDir, `reflow-${width}-${k + 1}.png`);
      await page.screenshot({
        path: file,
        fullPage: true,
        clip: { x: 0, y, width, height: Math.min(SLICE_PX, stats.pageHeightPx - y) },
        timeout: 120_000,
      });
      stats.screenshots.push(file);
    }
  } catch (error) {
    stats.error = message(error);
    try {
      const file = path.join(shotsDir, `reflow-${width}-failed.png`);
      await page.screenshot({ path: file, timeout: 30_000 });
      stats.screenshots.push(file);
    } catch {
      // nothing to keep
    }
  } finally {
    await page.close();
  }
  return stats;
}

interface ShotsRecord {
  name: string;
  id: string;
  takenAt: string;
  /** Whether the built page carries the reflow surface at all (it does not
   * when the derivation skipped or the site's gate dropped the bundle). */
  reflowSurface: boolean;
  views: ViewStats[];
  pdfPages: string[];
  error?: string;
}

function rasterizePdfPages(pdf: string, shotsDir: string): string[] {
  for (const name of fs.readdirSync(shotsDir)) if (/^pdf-\d+\.png$/u.test(name)) fs.rmSync(path.join(shotsDir, name));
  execFileSync("pdftoppm", ["-r", "110", "-png", "-f", "1", "-l", String(PDF_PAGES), pdf, path.join(shotsDir, "pdf")], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const pages: string[] = [];
  for (const name of fs.readdirSync(shotsDir).sort()) {
    const match = /^pdf-(\d+)\.png$/u.exec(name);
    if (match === null) continue;
    const k = Number(match[1]);
    const target = path.join(shotsDir, `pdf-${k}.png`);
    if (name !== `pdf-${k}.png`) fs.renameSync(path.join(shotsDir, name), target);
    pages.push(target);
  }
  return pages;
}

async function commandShots(names: string[], options: Options): Promise<void> {
  ensureLabDirs();
  if (!fs.existsSync(DIRS.site)) throw new Error(`no site under ${DIRS.site}; run \`site\` first`);
  const jobs = readAllJobRecords().filter((job) => job.pdf !== undefined && (names.length === 0 || names.includes(job.name)));
  if (jobs.length === 0) {
    console.log("nothing to shoot: no derived entries (or none of the named ones)");
    return;
  }
  const playwright = await loadPlaywright();
  const server = await serveSite();
  const browser = await playwright.chromium.launch();
  try {
    for (const job of jobs) {
      const id = recordId(job.name);
      const shotsDir = path.join(DIRS.shots, job.name);
      fs.mkdirSync(shotsDir, { recursive: true });
      for (const name of fs.readdirSync(shotsDir)) if (name.startsWith("reflow-")) fs.rmSync(path.join(shotsDir, name));
      const record: ShotsRecord = {
        name: job.name,
        id,
        takenAt: new Date().toISOString(),
        reflowSurface: false,
        views: [],
        pdfPages: [],
      };
      try {
        record.pdfPages = rasterizePdfPages(job.pdf!.path, shotsDir);
      } catch (error) {
        record.error = `pdftoppm failed: ${message(error)}`;
      }
      const pageFile = path.join(DIRS.site, id, "paper.html");
      if (!fs.existsSync(pageFile)) {
        record.error = `${record.error === undefined ? "" : `${record.error}; `}the site has no ${id}/paper.html (rebuild with \`site\`)`;
      } else if (!fs.readFileSync(pageFile, "utf8").includes('id="manuscript-reflow-doc"')) {
        log(job.name, "the paper page has no reflow surface (derivation skipped, or the site gate dropped the bundle)");
      } else {
        record.reflowSurface = true;
        const url = `http://127.0.0.1:${server.port}/${encodeURIComponent(id)}/paper.html`;
        log(job.name, `rendering ${url} at ${options.width}px and ${NARROW_WIDTH}px`);
        record.views.push(await renderView(browser, url, options.width, shotsDir, undefined));
        record.views.push(await renderView(browser, url, NARROW_WIDTH, shotsDir, NARROW_SLICES));
        for (const view of record.views) {
          const problems = [
            ...(view.error === undefined ? [] : [view.error]),
            ...(view.missingGlyphs > 0 ? [`${view.missingGlyphs} missing glyphs`] : []),
            ...(view.consoleErrors.length > 0 ? [`${view.consoleErrors.length} console errors`] : []),
            ...(view.pageErrors.length > 0 ? [`${view.pageErrors.length} page errors`] : []),
          ];
          log(job.name, `${view.width}px: ${view.blocks} blocks, ${view.svgs} svgs, ${view.docHeightPx}px tall${problems.length > 0 ? ` — ${problems.join(", ")}` : ""}`);
        }
      }
      fs.writeFileSync(path.join(shotsDir, "shots.json"), `${JSON.stringify(record, null, 2)}\n`);
    }
  } finally {
    await browser.close();
    server.close();
  }
}

// ── report ─────────────────────────────────────────────────────────────────

interface ReportEntry {
  name: string;
  id: string;
  class: string;
  engine: string;
  source: string;
  status: JobStatus;
  derivedAt: string;
  wallMs: number;
  timings: JobRecord["timings"];
  pages?: number;
  pdfDigest?: string;
  bundleDigest?: string;
  bundleBytes?: number;
  skipRule?: string;
  oracle?: OracleReport;
  siteGate?: string;
  shots?: ShotsRecord;
  findings: Finding[];
  warnings: string[];
}

function readShots(name: string): ShotsRecord | undefined {
  const file = path.join(DIRS.shots, name, "shots.json");
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as ShotsRecord;
  } catch {
    return undefined;
  }
}

function cell(value: string | number | undefined): string {
  return value === undefined ? "" : String(value).replace(/\|/gu, "\\|");
}

function commandReport(): void {
  ensureLabDirs();
  const site = fs.existsSync(SITE_JSON) ? (JSON.parse(fs.readFileSync(SITE_JSON, "utf8")) as SiteRecord) : undefined;
  const entries: ReportEntry[] = readAllJobRecords().map((job) => {
    const id = recordId(job.name);
    const shots = readShots(job.name);
    const warnings: string[] = [];
    if (job.error !== undefined) warnings.push(`error: ${job.error}`);
    for (const finding of job.findings) warnings.push(`${finding.kind} ${finding.rule}: ${clip(finding.message, 400)}`);
    const gate = site?.gate[id];
    if (gate !== undefined) warnings.push(`site gate: ${gate}`);
    if (job.oracle !== undefined && !job.oracle.passes) {
      warnings.push(`oracle: similarity ${job.oracle.similarity.toFixed(4)}${job.oracle.bounded ? " (bound)" : ""} under the ${job.oracle.floor} floor` +
        (job.oracle.divergence === undefined ? "" : ` — first divergence at token ${job.oracle.divergence.index}: PDF "${clip(job.oracle.divergence.pdf, 120)}" vs stream "${clip(job.oracle.divergence.stream, 120)}"`));
    }
    if (job.oracle !== undefined && job.oracle.firstDifference !== undefined) {
      const d = job.oracle.firstDifference;
      warnings.push(`oracle: ${job.oracle.pdfTokens} PDF vs ${job.oracle.streamTokens} stream tokens, first difference at token ${d.index}: PDF "${clip(d.pdf, 120)}" vs stream "${clip(d.stream, 120)}" (diff oracle-pdf.txt oracle-stream.txt in the job directory)`);
    }
    if (job.oracle !== undefined && job.oracle.relocatedUnmatched > 0) {
      warnings.push(`oracle: ${job.oracle.relocatedUnmatched} of ${job.oracle.relocatedParagraphs} relocated paragraph(s) not found in the PDF; the other ${job.oracle.relocatedMatched} took ${job.oracle.relocatedTokens} token(s) off its side`);
    }
    if (job.oracle !== undefined && job.oracle.omittedParagraphs > 0) {
      warnings.push(`oracle: ${job.oracle.omittedParagraphs} unreferenced paragraph(s) subtracted (${job.oracle.removedTokens} of a ${job.oracle.budgetTokens}-token budget)`);
    }
    if (shots !== undefined) {
      if (shots.error !== undefined) warnings.push(`shots: ${shots.error}`);
      if (job.status === "derived" && !shots.reflowSurface) warnings.push("shots: the built page has no reflow surface");
      for (const view of shots.views) {
        if (view.error !== undefined) warnings.push(`shots ${view.width}px: ${view.error}`);
        if (view.missingGlyphs > 0) warnings.push(`shots ${view.width}px: ${view.missingGlyphs} missing glyph(s)`);
        for (const line of view.renderErrors) warnings.push(`shots ${view.width}px: ${line}`);
        for (const line of view.pageErrors) warnings.push(`shots ${view.width}px page error: ${clip(line, 300)}`);
        for (const line of view.consoleErrors) warnings.push(`shots ${view.width}px console: ${clip(line, 300)}`);
        if (view.blocks > 0 && view.svgs === 0) warnings.push(`shots ${view.width}px: blocks present but nothing painted`);
      }
    }
    return {
      name: job.name,
      id,
      class: job.corpus.class,
      engine: job.corpus.engine,
      source: job.corpus.source,
      status: job.status,
      derivedAt: job.derivedAt,
      wallMs: job.wallMs,
      timings: job.timings,
      ...(job.pdf === undefined ? {} : { pages: job.pdf.pages, pdfDigest: job.pdf.digest }),
      ...(job.web === undefined ? {} : { bundleDigest: job.web.digest, bundleBytes: job.web.bytes }),
      ...(job.skipRule === undefined ? {} : { skipRule: job.skipRule }),
      ...(job.oracle === undefined ? {} : { oracle: job.oracle }),
      ...(gate === undefined ? {} : { siteGate: gate }),
      ...(shots === undefined ? {} : { shots }),
      findings: job.findings,
      warnings,
    };
  });

  const summary = {
    entries: entries.length,
    derived: entries.filter((e) => e.status === "derived").length,
    webSkipped: entries.filter((e) => e.status === "web-skipped").length,
    pdfFailed: entries.filter((e) => e.status === "pdf-failed").length,
    withWarnings: entries.filter((e) => e.warnings.length > 0).length,
  };
  fs.writeFileSync(
    REPORT_JSON,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), root: ROOT, site, summary, entries }, null, 2)}\n`,
  );

  const lines: string[] = [];
  lines.push("# Reflow lab report", "");
  lines.push(`Generated ${new Date().toISOString()} from \`${ROOT}\`.`);
  lines.push(`${summary.entries} entries: ${summary.derived} derived, ${summary.webSkipped} web-skipped, ${summary.pdfFailed} pdf-failed; ${summary.withWarnings} with warnings.`);
  if (site !== undefined) lines.push(`Site built ${site.builtAt} (${site.ok ? "ok" : "FAILED"}) from \`${site.websiteDir}\`.`);
  lines.push("");
  lines.push("| name | class | engine | pages | status | skip rule | oracle | blocks | missing glyphs | console errors | wall s |");
  lines.push("|---|---|---|---:|---|---|---:|---:|---:|---:|---:|");
  for (const entry of entries) {
    const wide = entry.shots?.views[0];
    const oracle = entry.oracle === undefined ? "" : `${entry.oracle.similarity.toFixed(4)}${entry.oracle.bounded ? "≤" : ""}`;
    const consoleErrors = entry.shots === undefined
      ? ""
      : entry.shots.views.reduce((sum, view) => sum + view.consoleErrors.length + view.pageErrors.length, 0);
    lines.push(
      `| ${[
        cell(entry.name),
        cell(entry.class),
        cell(entry.engine),
        cell(entry.pages),
        cell(entry.status + (entry.siteGate === undefined ? "" : " (gated)")),
        cell(entry.skipRule),
        cell(oracle),
        cell(wide?.blocks),
        cell(wide?.missingGlyphs),
        cell(consoleErrors),
        cell((entry.wallMs / 1000).toFixed(1)),
      ].join(" | ")} |`,
    );
  }
  lines.push("");
  for (const entry of entries) {
    if (entry.warnings.length === 0) continue;
    lines.push(`## ${entry.name}`, "");
    const where = [
      `job: \`${path.join(DIRS.jobs, entry.name)}\``,
      ...(entry.shots === undefined ? [] : [`shots: \`${path.join(DIRS.shots, entry.name)}\``]),
      ...(entry.pages === undefined ? [] : [`page: \`${path.join(DIRS.site, entry.id, "paper.html")}\``]),
    ];
    lines.push(where.join(" · "), "");
    for (const warning of entry.warnings) lines.push(`- ${warning}`);
    lines.push("");
  }
  fs.writeFileSync(REPORT_MD, `${lines.join("\n")}\n`);
  console.log(lines.slice(0, 5 + entries.length + 3).join("\n"));
  console.log(`report: ${REPORT_MD} and ${REPORT_JSON}`);
}

// ── smoke: the self-test ───────────────────────────────────────────────────

async function commandSmoke(options: Options): Promise<void> {
  ensureLabDirs();
  const fixture = path.join(LAB_DIR, "fixtures", "smoke");
  const target = path.join(DIRS.corpus, "_smoke");
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(fixture, target, { recursive: true });
  console.log(`smoke fixture copied to ${target}`);
  await commandAll(["_smoke"], options);
}

async function commandAll(names: string[], options: Options): Promise<void> {
  await commandDerive(names, options);
  await commandSite();
  await commandShots(names, options);
  commandReport();
}

// ── plumbing ───────────────────────────────────────────────────────────────

interface Options {
  jobs: number;
  force: boolean;
  width: number;
}

function ensureLabDirs(): void {
  for (const dir of Object.values(DIRS)) fs.mkdirSync(dir, { recursive: true });
}

function log(name: string, line: string): void {
  console.log(`[${name}] ${line}`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clip(text: string, max: number): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function pool<T>(items: readonly T[], size: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next]!;
      next += 1;
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

function runCapturing(command: string, args: string[], cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, output: Buffer.concat(chunks).toString("utf8") }));
  });
}

function parseArguments(argv: string[]): { command: string; names: string[]; options: Options } {
  const options: Options = { jobs: 3, force: false, width: 1100 };
  const names: string[] = [];
  let command = "";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--force") options.force = true;
    else if (argument === "--jobs" || argument === "--width") {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 1) throw new Error(`${argument} needs a positive integer`);
      if (argument === "--jobs") options.jobs = value;
      else options.width = value;
      index += 1;
    } else if (argument.startsWith("--")) throw new Error(`unknown option ${argument}`);
    else if (command === "") command = argument;
    else names.push(argument);
  }
  return { command, names, options };
}

const USAGE = `usage: npm run reflow-lab -- <command> [name…] [--jobs N] [--force] [--width W]

  derive [name…]   run the production paper compile + web derivation per corpus entry
  site             synthesize db/, copy papers/ and bundles/, build the real website into site/
  shots [name…]    screenshot each reflow page (chromium) and rasterize the PDF's first pages
  report           aggregate jobs/*/lab.json and shots/*/shots.json into report.md + report.json
  all [name…]      derive → site → shots → report
  smoke            copy fixtures/smoke to corpus/_smoke and run \`all _smoke\`

lab root: ${ROOT} (LAX_REFLOW_LAB); website: ${WEBSITE} (LAX_WEBSITE_DIR)`;

async function main(): Promise<void> {
  const { command, names, options } = parseArguments(process.argv.slice(2));
  switch (command) {
    case "derive":
      await commandDerive(names, options);
      break;
    case "site":
      await commandSite();
      break;
    case "shots":
      await commandShots(names, options);
      break;
    case "report":
      commandReport();
      break;
    case "all":
      await commandAll(names, options);
      break;
    case "smoke":
      await commandSmoke(options);
      break;
    default:
      console.log(USAGE);
      process.exitCode = command === "" || command === "help" ? 0 : 2;
  }
}

main().catch((error: unknown) => {
  console.error(message(error));
  process.exit(1);
});
