// The paper web derivation (paper-web-plan.md, stage 2 — the host path):
// beside the compiled PDF, derive the ReflowTeX bundle the website's reflow
// viewer renders. Injection, not splitting: a **fresh rewritten copy of its
// own** (`paper/web/src` in the job directory, never the PDF compile's
// `paper/src` — sharing would overwrite `main.pdf` under `-jobname` and
// fail the digest re-hash in outputs.ts) compiles under lualatex with
// `laxreflow.sty` injected the way `laxmark.sty` is on the PDF path; the
// fork's encode pipeline (a capped child in the hash-pinned venv) turns the
// serializer's node list into the protobuf block; the oracle (web-oracle.ts)
// compares the stream's glyph text against the PDF's text layer; and the
// bundle writer seals index.json + blocks + fonts + schema into a
// deterministic tar.
//
// **Non-blocking, by construction**: a deriver returns warnings, never
// violations — every failure (missing toolchain, compile error, marker
// count mismatch, oracle divergence, cap overrun) is a `web-*` warning on
// the `paper` phase, `paper.web` is simply omitted, and the PDF path is
// untouched. The host deriver exists for tests and fixture generation;
// `lax build` does not derive the web view by default (the archive's
// trusted derivation is stage 3), so the seam stays off until injected.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PAPER_CAPS, type ValidationLimits } from "../config.js";
import type { PaperMarkTableEntry, PaperWebFormat, StaticPaper } from "../contracts.js";
import { run } from "../host/proc.js";
import { engineAvailable, laxmarkDirectory, MIN_LATEXMK_VERSION, probeLatexmkAsync } from "../host/paper.js";
import { REFLOWTEX_REV } from "../pins.js";
import { oneLineTail, paperJobName } from "./compile.js";
import { extractPdfText } from "./extract.js";
import { copyPaperFolder } from "./phase.js";
import {
  assemblePdfText,
  compareTokens,
  oracleTokens,
  removeTokenRun,
} from "./web-oracle.js";

/** What the paper phase hands a web deriver, after the PDF path succeeded. */
export interface WebDeriveInput {
  paper: StaticPaper;
  submissionRoot: string;
  jobDir: string;
  sourceDateEpoch: number;
  limits: ValidationLimits;
  /** The compiled, digest-recorded PDF — the oracle's other substrate. */
  pdfPath: string;
}

/** A successful derivation: the sealed bundle still inside the job
 * directory, its content address, and the format pin the record carries. */
export interface DerivedWebBundle {
  bundlePath: string;
  digest: string;
  bytes: number;
  format: PaperWebFormat;
}

/** A deriver's finding: always a warning on the `paper` phase — the type
 * carries no violation channel, so a deriver cannot block validation. */
export interface WebWarning {
  rule: string;
  message: string;
}

export interface WebDerivation {
  web?: DerivedWebBundle;
  warnings: WebWarning[];
}

/** The seam the pipelines and tests inject, mirroring the runner/compiler
 * seams: absent means the web view is not derived at all. */
export type WebDeriver = (input: WebDeriveInput) => Promise<WebDerivation>;

/** The fetched fork's consumable surfaces (reflowtex/README.md). */
export interface ReflowtexInstallation {
  checkout: string;
  serializer: string;
  venvPython: string;
  encodeScript: string;
  schemaProto: string;
  generatedPb2: string;
}

/** Resolve `reflowtex/` beside `src`/`dist`, the way laxmarkDirectory does. */
export function reflowtexDirectory(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "reflowtex");
}

/** The fetched fork's surfaces, or the missing piece by name. */
export function probeReflowtex(root = reflowtexDirectory()): ReflowtexInstallation | { missing: string } {
  const installation: ReflowtexInstallation = {
    checkout: path.join(root, "checkout"),
    serializer: path.join(root, "checkout", "src", "extract", "serializer.lua"),
    venvPython: path.join(root, "venv", "bin", "python"),
    encodeScript: path.join(root, "encode_web.py"),
    schemaProto: path.join(root, "checkout", "src", "schema", "latex.proto"),
    generatedPb2: path.join(root, "checkout", "build", "latex_pb2.py"),
  };
  for (const [name, filename] of Object.entries(installation)) {
    // statSync, not lstat: a venv's python is a symlink by construction.
    if (name === "checkout" ? !fs.existsSync(filename) : !fs.statSync(filename, { throwIfNoEntry: false })?.isFile()) {
      return { missing: `${path.relative(path.dirname(root), filename)} (run \`npm run reflowtex:fetch\`)` };
    }
  }
  return installation;
}

/** The web compile's latexmk invocation (paper-web-plan.md, "Derivation
 * model"): always lualatex regardless of the manifest engine, with
 * `-shell-escape` for tikz's external library — the one deviation from the
 * PDF compile's flags — and the `-jobname` lesson applied verbatim. */
export function webLatexmkArguments(main: string): string[] {
  return [
    "-lualatex",
    "-interaction=nonstopmode",
    "-halt-on-error",
    "-shell-escape",
    "-usepretex",
    "-pretex=\\RequirePackage{laxreflow}",
    `-jobname=${paperJobName(main)}`,
    main,
  ];
}

/** The web compile's environment: the job's copy FIRST (its rewritten
 * sources must win any TEXINPUTS race — the spike's driver lesson), then
 * the marker-package directory, both non-recursive, then TeX Live's
 * default path via the trailing colon. */
export function webCompileEnvironment(webSrcDir: string, styDir: string, sourceDateEpoch: number): Record<string, string> {
  return {
    TEXINPUTS: `${webSrcDir}:${styDir}:`,
    SOURCE_DATE_EPOCH: String(sourceDateEpoch),
    FORCE_SOURCE_DATE: "1",
  };
}

// ── marker sanity ──────────────────────────────────────────────────────────

export interface StreamMarkerInstance {
  side: "b" | "e";
  n: number;
  /** Whether it rides inside a referenced paragraph or as a stream item. */
  at: "paragraph" | "stream";
}

/**
 * The stream's markers must match the rewriter's mark table exactly: one
 * begin and one end per mark number in referenced content, and no number
 * the table does not explain. (The glyphless hoist *copies* a marker into
 * the stream while the unreferenced paragraph keeps its node — the child
 * counts referenced content only, so the copy is single here.) Returns the
 * problems, empty when the counts agree.
 */
export function markerCountProblems(
  table: readonly PaperMarkTableEntry[],
  markers: readonly StreamMarkerInstance[],
): string[] {
  const problems: string[] = [];
  const counts = new Map<number, { b: number; e: number }>();
  for (const marker of markers) {
    const slot = counts.get(marker.n) ?? { b: 0, e: 0 };
    slot[marker.side] += 1;
    counts.set(marker.n, slot);
  }
  const known = new Set(table.map((entry) => entry.n));
  for (const entry of table) {
    const slot = counts.get(entry.n) ?? { b: 0, e: 0 };
    if (slot.b !== 1 || slot.e !== 1) {
      problems.push(
        `mark ${entry.n} (${entry.id}) appears ${slot.b}× as begin and ${slot.e}× as end in the stream, expected exactly once each`,
      );
    }
  }
  for (const n of [...counts.keys()].sort((a, b) => a - b)) {
    if (!known.has(n)) problems.push(`the stream carries a marker number the rewriter never emitted: ${n}`);
  }
  return problems;
}

// ── deterministic bundle tar ───────────────────────────────────────────────

export interface BundleFile {
  /** POSIX path inside the tar (`index.json`, `blocks/000.pb`, …). */
  name: string;
  content: Buffer;
}

/**
 * A deterministic ustar archive — the capture seal's flags (`--sort=name
 * --mtime=@0 --owner=0 --group=0 --numeric-owner --format=ustar`) as a
 * writer: entries sorted by name, zero mtime/uid/gid, mode 0644, no
 * directory entries. Same inputs, same bytes, on every machine.
 */
export function writeDeterministicTar(files: readonly BundleFile[]): Buffer {
  const blocks: Buffer[] = [];
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const names = new Set<string>();
  for (const file of sorted) {
    if (names.has(file.name)) throw new Error(`duplicate bundle entry ${file.name}`);
    names.add(file.name);
    if (Buffer.byteLength(file.name, "utf8") > 100) throw new Error(`bundle entry name over 100 bytes: ${file.name}`);
    blocks.push(tarHeader(file.name, file.content.length), file.content, padding(file.content.length));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, 0o644); // mode
  writeOctal(header, 108, 8, 0); // uid
  writeOctal(header, 116, 8, 0); // gid
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0); // mtime
  header.fill(" ", 148, 156); // checksum, spaces while summing
  header.write("0", 156, 1, "latin1"); // typeflag: regular file
  header.write("ustar", 257, "latin1");
  header.write("00", 263, "latin1");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  return header;
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "latin1");
}

function padding(size: number): Buffer {
  return Buffer.alloc((512 - (size % 512)) % 512);
}

// ── the encode child's reports, parsed as data ─────────────────────────────

interface StreamReport {
  markers: StreamMarkerInstance[];
  text: string;
  unreferenced: Array<{ text: string; markers: Array<[string, number]> }>;
}

interface EncodeReport {
  pbBytes: number;
  fonts: Record<string, string>;
  /** Image rules the serializer could not source (plain \includegraphics),
   * kept as kerns by the encode — see the fork's convert_pictures. */
  droppedPictures: number;
}

function parseStreamReport(value: unknown): StreamReport {
  const object = asObject(value, "stream report");
  if (!Array.isArray(object.markers)) throw new Error("stream report: markers must be an array");
  const markers = object.markers.map((entry): StreamMarkerInstance => {
    const marker = asObject(entry, "stream marker");
    if ((marker.side !== "b" && marker.side !== "e") || !Number.isSafeInteger(marker.n)) {
      throw new Error("stream report: invalid marker");
    }
    if (marker.at !== "paragraph" && marker.at !== "stream") throw new Error("stream report: invalid marker site");
    return { side: marker.side, n: marker.n as number, at: marker.at };
  });
  if (typeof object.text !== "string") throw new Error("stream report: text must be a string");
  if (!Array.isArray(object.unreferenced)) throw new Error("stream report: unreferenced must be an array");
  const unreferenced = object.unreferenced.map((entry) => {
    const paragraph = asObject(entry, "unreferenced paragraph");
    if (typeof paragraph.text !== "string" || !Array.isArray(paragraph.markers)) {
      throw new Error("stream report: invalid unreferenced paragraph");
    }
    return { text: paragraph.text, markers: paragraph.markers as Array<[string, number]> };
  });
  return { markers, text: object.text, unreferenced };
}

export function parseEncodeReport(value: unknown): EncodeReport {
  const object = asObject(value, "encode report");
  if (!Number.isSafeInteger(object.pbBytes) || (object.pbBytes as number) <= 0) {
    throw new Error("encode report: invalid pbBytes");
  }
  const fonts = asObject(object.fonts ?? {}, "encode report fonts");
  const map: Record<string, string> = {};
  for (const [original, served] of Object.entries(fonts)) {
    if (typeof served !== "string") throw new Error("encode report: font map values must be strings");
    map[original] = served;
  }
  const dropped = object.droppedPictures ?? 0;
  if (!Number.isSafeInteger(dropped) || (dropped as number) < 0) {
    throw new Error("encode report: invalid droppedPictures");
  }
  return { pbBytes: object.pbBytes as number, fonts: map, droppedPictures: dropped as number };
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** A font file the bundle will serve: a plain name, no traversal, a font
 * extension. Anything else fails the derivation closed. The same shape
 * gates the container export list — the values come out of output.json,
 * which a `-shell-escape` document can write itself, so nothing but a
 * plain basename ever reaches the export step or the sealed bundle. */
export const FONT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.(otf|ttf)$/u;

// ── the shared derivation engine ───────────────────────────────────────────
// The host and container derivers differ only in their prerequisites, in how
// the injected lualatex compile executes, and in the container path's bounded
// export step. Everything else — the fresh copy, the compile and log gates,
// the output.json cap, the encode child, marker sanity, the oracle, and the
// bundle seal — is this shared code (paper-web-plan.md stage 3: call it,
// don't copy it).

/** The warnings-only harness every deriver runs inside: `skip` records the
 * one reason and returns the empty derivation, and anything thrown becomes a
 * `web-derivation` warning — accumulated warnings survive either way. */
export async function runWebDerivation(
  derive: (
    warnings: WebWarning[],
    skip: (rule: string, message: string) => WebDerivation,
  ) => Promise<WebDerivation>,
): Promise<WebDerivation> {
  const warnings: WebWarning[] = [];
  const skip = (rule: string, message: string): WebDerivation => {
    warnings.push({ rule, message });
    return { warnings };
  };
  try {
    return await derive(warnings, skip);
  } catch (error) {
    warnings.push({
      rule: "web-derivation",
      message: `the reflow view was not derived: ${error instanceof Error ? error.message : String(error)}`,
    });
    return { warnings };
  }
}

/** The fresh web copy — never the PDF compile's `paper/src` — with the
 * fork's serializer beside the main file (dofile resolves it against the
 * job directory), the pre-created `pics/` externalization prefix tikz will
 * not make itself, and the encode output directory. */
export function prepareWebSource(
  input: WebDeriveInput,
  serializer: string,
): { webSrc: string; webOut: string } {
  const webDir = path.join(input.jobDir, "paper", "web");
  const webSrc = path.join(webDir, "src");
  const webOut = path.join(webDir, "out");
  fs.rmSync(webDir, { recursive: true, force: true });
  copyPaperFolder(
    input.paper,
    path.join(fs.realpathSync(input.submissionRoot), input.paper.manifest.folder),
    webSrc,
  );
  fs.copyFileSync(serializer, path.join(webSrc, "serializer.lua"));
  fs.mkdirSync(path.join(webSrc, "pics"), { recursive: true });
  fs.mkdirSync(webOut, { recursive: true, mode: 0o700 });
  return { webSrc, webOut };
}

/**
 * A failed or repaired web compile as its skip warning, or undefined when
 * the compile is clean. The log gate is the fork's own rule: nonstopmode
 * repairs the document, so any `! ` line means the node list is silently
 * wrong even though a PDF (and an output.json) appeared.
 */
export function webCompileProblem(
  result: { code: number; output: string; timedOut?: boolean },
  webSrc: string,
  main: string,
  limits: ValidationLimits,
): WebWarning | undefined {
  if (result.code !== 0 || result.timedOut === true) {
    return {
      rule: "web-compile",
      message:
        (result.code === 124 || result.timedOut === true
          ? `the reflow view was not derived: the web compile did not finish within ${Math.round(limits.paperCompileTimeoutMs / 60_000)} minutes`
          : `the reflow view was not derived: lualatex failed under laxreflow (latexmk exit ${result.code})`) +
        `; the end of the transcript: ${oneLineTail(result.output, limits.paperLogTailChars)}`,
    };
  }
  const texErrors = readTexErrors(path.join(webSrc, `${paperJobName(main)}.log`));
  if (texErrors.length > 0) {
    return {
      rule: "web-compile",
      message:
        `the reflow view was not derived: lualatex reported ${texErrors.length} error(s) under laxreflow ` +
        `(nonstopmode continued, so the serialized stream would be silently wrong): ${oneLineTail(texErrors.slice(0, 10).join("\n"), 12_000)}`,
    };
  }
  return undefined;
}

/** The serializer's output.json as its skip warning (missing or over the
 * size cap), or undefined when the size-capped read may proceed. */
export function serializedStreamProblem(webSrc: string, limits: ValidationLimits): WebWarning | undefined {
  const stat = fs.lstatSync(path.join(webSrc, "output.json"), { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile()) {
    return { rule: "web-compile", message: "the reflow view was not derived: the serializer left no output.json behind" };
  }
  if (stat.size > limits.paperWebOutputJsonBytes) {
    return {
      rule: "web-output-cap",
      message:
        `the reflow view was not derived: the serialized stream is ${formatMiB(stat.size)}, ` +
        `over the ${formatMiB(limits.paperWebOutputJsonBytes)} cap`,
    };
  }
  return undefined;
}

/**
 * The font files the run used, from the serializer's font table — the
 * container path's export list. The serializer records basenames; legacy
 * 8-bit faces record "unknown" and have no file to resolve by name, so only
 * FONT_NAME-shaped `.otf`/`.ttf` names survive. Call after
 * serializedStreamProblem cleared the size cap.
 */
export function webFontFilenames(webSrc: string, limits: ValidationLimits): string[] {
  const names = new Set<string>();
  for (const entry of fontTableEntries(webSrc, limits)) {
    if (typeof entry.filename === "string" && FONT_NAME.test(entry.filename)) names.add(entry.filename);
  }
  return [...names].sort();
}

/** A legacy face's TeX name, safe as a path segment and a quoted shell word. */
const LEGACY_FONT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/u;

/**
 * The legacy 8-bit faces of the font table — entries with no real font file
 * ("unknown"), which the encode converts from their Type1 outlines
 * (`<name>.pfb`, e.g. plain lualatex math's cmmi10/cmsy10). The container
 * export resolves those outlines in-image too, because the encode host has
 * no TeX tree; a name that cannot be resolved just keeps the metric-box
 * fallback, exactly as on a TeX-full host. Same untrusted-value posture as
 * webFontFilenames.
 */
export function webLegacyFontNames(webSrc: string, limits: ValidationLimits): string[] {
  const names = new Set<string>();
  for (const entry of fontTableEntries(webSrc, limits)) {
    const filename = entry.filename;
    const legacy = filename === undefined || filename === null || filename === "unknown";
    if (!legacy) continue;
    const name = entry.name;
    if (typeof name === "string" && name !== "unknown" && LEGACY_FONT_NAME.test(name)) names.add(name);
  }
  return [...names].sort();
}

function fontTableEntries(webSrc: string, limits: ValidationLimits): Array<{ filename?: unknown; name?: unknown }> {
  const data = boundedJson(path.join(webSrc, "output.json"), limits.paperWebOutputJsonBytes);
  const fonts = (data as { fonts?: unknown }).fonts;
  if (fonts === null || typeof fonts !== "object" || Array.isArray(fonts)) return [];
  return Object.values(fonts as Record<string, unknown>).filter(
    (entry): entry is { filename?: unknown; name?: unknown } =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry),
  );
}

/** How the shared encode+seal tail runs the encode child in one deriver. */
export interface WebEncodeOptions {
  /** Extra `encode_web.py` arguments (the container path's `--fonts`,
   * pointing font provisioning at the exported bytes). */
  extraArgs?: string[];
  /** Extra environment for the encode child. The container path pins
   * REFLOWTEX_DVISVGM to a failing command: pictures must arrive
   * pre-converted from the pinned TeX image, never through a host binary. */
  env?: Record<string, string>;
  echo?: boolean;
}

/**
 * Everything after compile + export, shared verbatim between the derivers:
 * the encode child (capped, in the hash-pinned venv), its reports parsed as
 * data, marker sanity against the rewriter's table, the oracle over the
 * PDF's text layer, and the deterministic bundle seal.
 */
export async function encodeAndSealWebBundle(
  input: WebDeriveInput,
  reflowtex: ReflowtexInstallation,
  webSrc: string,
  webOut: string,
  warnings: WebWarning[],
  skip: (rule: string, message: string) => WebDerivation,
  options: WebEncodeOptions = {},
): Promise<WebDerivation> {
  const echo = options.echo ?? false;
  const paper = input.paper;

  // ── the encode child, capped, in the hash-pinned venv ──────────────────
  if (echo) console.log("\n== reflowtex encode (paper web) ==");
  const encode = await run(
    reflowtex.venvPython,
    [
      reflowtex.encodeScript,
      "--checkout", reflowtex.checkout,
      "--job", webSrc,
      "--out", webOut,
      ...(options.extraArgs ?? []),
    ],
    webSrc,
    {
      echo,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...options.env },
      timeoutMs: input.limits.paperWebEncodeTimeoutMs,
      maxOutputBytes: input.limits.maxOutputBytes,
    },
  );
  if (encode.code !== 0) {
    return skip(
      "web-encode",
      (encode.code === 124
        ? `the reflow view was not derived: the encode step did not finish within ${Math.round(input.limits.paperWebEncodeTimeoutMs / 60_000)} minutes`
        : `the reflow view was not derived: the encode step failed (exit ${encode.code})`) +
        `; the end of the transcript: ${oneLineTail(encode.output, input.limits.paperLogTailChars)}`,
    );
  }
  let stream: StreamReport;
  let encoded: EncodeReport;
  let block: Buffer;
  try {
    stream = parseStreamReport(boundedJson(path.join(webOut, "stream.json"), input.limits.paperWebOutputJsonBytes));
    encoded = parseEncodeReport(boundedJson(path.join(webOut, "encode.json"), 1024 * 1024));
    block = fs.readFileSync(path.join(webOut, "blocks", "000.pb"));
    if (block.length === 0 || block.length !== encoded.pbBytes) throw new Error("encoded block size mismatch");
  } catch (error) {
    return skip("web-encode", `the reflow view was not derived: ${error instanceof Error ? error.message : String(error)}`);
  }

  // ── marker sanity against the rewriter's table ─────────────────────────
  const markerProblems = markerCountProblems(paper.marks, stream.markers);
  if (markerProblems.length > 0) {
    return skip(
      "web-marker-count",
      `the reflow view was not derived: the serialized stream does not carry the mark table exactly — ` +
        markerProblems.join("; "),
    );
  }

  // ── the oracle: PDF text layer vs stream glyph text ────────────────────
  let pdfTokens: string[];
  try {
    const pages = await extractPdfText(input.pdfPath, {
      timeoutMs: input.limits.paperExtractTimeoutMs,
      maxOutputBytes: input.limits.maxOutputBytes,
    });
    pdfTokens = oracleTokens(assemblePdfText(pages).text);
  } catch (error) {
    return skip("web-oracle", `the reflow view was not derived: ${error instanceof Error ? error.message : String(error)}`);
  }
  const streamTokens = oracleTokens(stream.text);
  for (const paragraph of stream.unreferenced) {
    const tokens = oracleTokens(paragraph.text);
    if (tokens.length === 0) continue; // marker-only capture (the hoist's leftover)
    // The cheap loud diagnostic for \marginpar and friends: text the
    // reflow surface will not show, named, whether or not the web view
    // itself derives.
    warnings.push({
      rule: "web-unreferenced-paragraph",
      message:
        "the reflow view omits a captured paragraph the page stream never references " +
        `(\\marginpar and similar produce these): "${preview(paragraph.text)}"`,
    });
    pdfTokens = removeTokenRun(pdfTokens, tokens).tokens;
  }
  const verdict = compareTokens(pdfTokens, streamTokens, input.limits.paperWebOracleSimilarity);
  if (verdict.divergence !== undefined) {
    return skip(
      "web-oracle",
      `the reflow view was not derived: the serialized stream diverges from the PDF text ` +
        `(token similarity ${verdict.similarity.toFixed(4)} < ${input.limits.paperWebOracleSimilarity}); ` +
        `first divergence at token ${verdict.divergence.index}: ` +
        `PDF reads "${verdict.divergence.pdf}", the stream reads "${verdict.divergence.stream}"`,
    );
  }

  if (encoded.droppedPictures > 0) {
    // Derived, but not whole: the loud counterpart of the encode's kern
    // fallback, so an omitted figure never passes unremarked.
    warnings.push({
      rule: "web-pictures-dropped",
      message:
        `the reflow view omits ${encoded.droppedPictures} included graphic(s) the web compile could not ` +
        "externalize (plain \\includegraphics — class logos, ORCID icons, raster figures; tikz pictures are shown); " +
        "each keeps its width as blank space",
    });
  }

  // ── the bundle: index.json + blocks + fonts + schema, sealed ───────────
  const schemaBytes = fs.readFileSync(reflowtex.schemaProto);
  const files: BundleFile[] = [
    { name: "blocks/000.pb", content: block },
    { name: "schema/latex.proto", content: schemaBytes },
  ];
  const fontsDir = path.join(webOut, "fonts");
  const served = new Set<string>();
  for (const name of fs.existsSync(fontsDir) ? fs.readdirSync(fontsDir).sort() : []) {
    if (!FONT_NAME.test(name)) {
      return skip("web-bundle", `the reflow view was not derived: the encode step served an unexpected font file name: ${name}`);
    }
    served.add(name);
    files.push({ name: `fonts/${name}`, content: fs.readFileSync(path.join(fontsDir, name)) });
  }
  const fontMap: Record<string, string> = {};
  for (const original of Object.keys(encoded.fonts).sort()) {
    const target = encoded.fonts[original]!;
    if (!FONT_NAME.test(original) || !served.has(target)) {
      return skip("web-bundle", `the reflow view was not derived: the font map names a file the bundle does not carry: ${original} -> ${target}`);
    }
    fontMap[original] = `fonts/${target}`;
  }
  const format: PaperWebFormat = {
    tool: "reflowtex",
    rev: REFLOWTEX_REV,
    schema: createHash("sha256").update(schemaBytes).digest("hex"),
  };
  const index = {
    formatVersion: 1,
    tool: format.tool,
    rev: format.rev,
    schema: format.schema,
    blocks: ["blocks/000.pb"],
    fonts: fontMap,
  };
  files.push({ name: "index.json", content: Buffer.from(`${JSON.stringify(index, null, 2)}\n`, "utf8") });
  const tar = writeDeterministicTar(files);
  if (tar.length > PAPER_CAPS.webBundleBytes) {
    return skip(
      "web-bundle-cap",
      `the reflow view was not derived: the bundle is ${formatMiB(tar.length)}, over the ${formatMiB(PAPER_CAPS.webBundleBytes)} cap`,
    );
  }
  const bundlePath = path.join(path.dirname(webSrc), "paper-web.tar");
  fs.writeFileSync(bundlePath, tar, { mode: 0o600 });
  return {
    web: {
      bundlePath,
      digest: createHash("sha256").update(tar).digest("hex"),
      bytes: tar.length,
      format,
    },
    warnings,
  };
}

// ── the host deriver ───────────────────────────────────────────────────────

/**
 * The host web deriver: latexmk + lualatex from PATH over the fetched fork
 * (`npm run reflowtex:fetch`), the encode child in the hash-pinned venv.
 * Auto-skips with a `web-toolchain` warning when any prerequisite is
 * absent — the latexmk-skip pattern. Local derivations exist for tests and
 * fixture generation; the archive's trusted derivation
 * (paper/web-container.ts) is the authority.
 */
export function hostWebDeriver(options: { echo?: boolean } = {}): WebDeriver {
  const echo = options.echo ?? false;
  return async (input) => runWebDerivation(async (warnings, skip) => {
    // ── prerequisites: the auto-skip, never a violation ──────────────────
    const reflowtex = probeReflowtex();
    if ("missing" in reflowtex) {
      return skip("web-toolchain", `the reflow view was not derived: missing ${reflowtex.missing}`);
    }
    const latexmk = await probeLatexmkAsync();
    if (latexmk === undefined || !latexmk.supported) {
      return skip("web-toolchain", `the reflow view was not derived: latexmk >= ${MIN_LATEXMK_VERSION} is not installed`);
    }
    if (!(await engineAvailable("lualatex"))) {
      return skip("web-toolchain", "the reflow view was not derived: lualatex is not installed");
    }

    // ── the fresh web copy and the injected lualatex compile ─────────────
    const paper = input.paper;
    const { webSrc, webOut } = prepareWebSource(input, reflowtex.serializer);
    if (echo) console.log("\n== latexmk (paper web) ==");
    const styDir = laxmarkDirectory();
    const compile = await run("latexmk", webLatexmkArguments(paper.manifest.main), webSrc, {
      echo,
      env: {
        ...webCompileEnvironment(webSrc, styDir, input.sourceDateEpoch),
        PATH: process.env.PATH ?? "/usr/bin:/bin",
      },
      timeoutMs: input.limits.paperCompileTimeoutMs,
      maxOutputBytes: input.limits.maxOutputBytes,
    });
    const compileProblem = webCompileProblem(compile, webSrc, paper.manifest.main, input.limits);
    if (compileProblem !== undefined) return skip(compileProblem.rule, compileProblem.message);
    const streamProblem = serializedStreamProblem(webSrc, input.limits);
    if (streamProblem !== undefined) return skip(streamProblem.rule, streamProblem.message);

    // ── everything after compile is the shared engine ────────────────────
    return encodeAndSealWebBundle(input, reflowtex, webSrc, webOut, warnings, skip, { echo });
  });
}

/** The `! ` lines of a TeX transcript — each one a repaired-document error. */
function readTexErrors(logFile: string): string[] {
  try {
    return fs
      .readFileSync(logFile, "latin1")
      .split("\n")
      .filter((line) => line.startsWith("! "));
  } catch {
    return [];
  }
}

function boundedJson(filename: string, cap: number): unknown {
  const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile()) throw new Error(`${path.basename(filename)} is missing`);
  if (stat.size > cap) throw new Error(`${path.basename(filename)} exceeds ${formatMiB(cap)}`);
  return JSON.parse(fs.readFileSync(filename, "utf8")) as unknown;
}

function preview(text: string): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return collapsed.length <= 120 ? collapsed : `${collapsed.slice(0, 120)}…`;
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
