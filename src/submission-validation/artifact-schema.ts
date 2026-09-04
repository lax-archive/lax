import path from "node:path";
import type { SourceLocation } from "../shared/types.js";
import {
  isObject,
  normalizeTitle,
  PAPER_ENGINES,
  requireExactKeys,
  validateCommit,
  validateFolder,
  validatePaperMain,
  validateSource,
  validateSubmissionId,
  ValidationError,
} from "../shared/validation.js";
import { PAPER_CAPS } from "./config.js";
import type {
  AnnotationSection,
  BuildOutputPayload,
  CaptureManifest,
  CapturedFile,
  ConceptEntry,
  PaperManifest,
  PaperMark,
  PaperMarkPoint,
  PaperOutput,
  PaperWebOutput,
  PublishedCapture,
  ResolvedDependency,
  StatementEntry,
  SubmissionAuthor,
  SubmissionManifest,
  ValidationFinding,
  ValidationReport,
  ValidationRequest,
  ValidationRuntimeIdentity,
} from "./contracts.js";
import {
  LEAN_NAME_PATTERN,
  parseCaptureBlobReference,
  submissionIdForPackage,
  validationRequestFromUnknown,
} from "./contracts.js";
import { markIdKind, markIdProblem } from "./paper/rewrite.js";

const MAX_CAPTURE_FILES = 100_000;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
const MAX_DEPENDENCIES = 10_000;
const MAX_FINDINGS = 10_000;
const PHASES = new Set([
  "source",
  "static",
  "resolution",
  "provision",
  "compile-concepts",
  "compile-proofs",
  "replay",
  "inspect",
  "paper",
  "emit",
]);

export interface SuccessfulValidationArtifacts {
  report: ValidationReport & { ok: true; buildOutput: BuildOutputPayload; capture: CaptureManifest };
  buildOutput: BuildOutputPayload;
}

export function parseSuccessfulValidationArtifacts(
  reportValue: unknown,
  buildOutputValue: unknown,
  expectedRequest: ValidationRequest,
  expectedRuntime: ValidationRuntimeIdentity,
): SuccessfulValidationArtifacts {
  const reportObject = exactObject(
    reportValue,
    [
      "reportVersion",
      "ok",
      "request",
      "runtime",
      "dependencies",
      "warnings",
      "violations",
      "buildOutput",
      "capture",
    ],
    "validation report",
  );
  if (reportObject.reportVersion !== 1 || reportObject.ok !== true) {
    throw new ValidationError("trusted publication requires a successful version 1 validation report");
  }
  const request = validationRequestFromUnknown(reportObject.request);
  if (JSON.stringify(request) !== JSON.stringify(validationRequestFromUnknown(expectedRequest))) {
    throw new ValidationError("validation report request does not match the authorized submit request");
  }
  const runtime = parseRuntime(reportObject.runtime);
  // Both sides go through parseRuntime, so the comparison is by value and
  // never by the key order a builder happened to use.
  if (JSON.stringify(runtime) !== JSON.stringify(parseRuntime(expectedRuntime))) {
    throw new ValidationError("validation report runtime does not match the workflow's pinned runtime");
  }
  const dependencies = boundedArray(reportObject.dependencies, "validation dependencies", MAX_DEPENDENCIES)
    .map((value, index) => parseDependency(value, index, runtime));
  requireUnique(dependencies.map((entry) => entry.packageName), "validation dependency package names");
  const warnings = boundedArray(reportObject.warnings, "validation warnings", MAX_FINDINGS)
    .map((value, index) => parseFinding(value, `validation warning ${index + 1}`));
  const violations = boundedArray(reportObject.violations, "validation violations", MAX_FINDINGS)
    .map((value, index) => parseFinding(value, `validation violation ${index + 1}`));
  if (violations.length !== 0) throw new ValidationError("successful validation report must have no violations");
  const reportBuildOutput = parseBuildOutputPayload(reportObject.buildOutput, request, runtime);
  const standaloneBuildOutput = parseBuildOutputPayload(buildOutputValue, request, runtime);
  if (JSON.stringify(reportObject.buildOutput) !== JSON.stringify(buildOutputValue)) {
    throw new ValidationError("standalone generated build output does not exactly match the validation report");
  }
  const capture = parseCaptureManifest(reportObject.capture, false);
  if (
    JSON.stringify(capture) !== JSON.stringify(reportBuildOutput.capture) ||
    JSON.stringify(capture) !== JSON.stringify(standaloneBuildOutput.capture)
  ) {
    throw new ValidationError("validation report and generated build output have different capture manifests");
  }
  if (
    capture.sourceCommit !== request.source.commit ||
    capture.leanToolchain !== runtime.leanToolchain ||
    capture.mathlibCommit !== runtime.mathlibCommit
  ) {
    throw new ValidationError("capture provenance does not match the validated source and runtime");
  }
  validateDependencyGraph(dependencies, reportBuildOutput);
  return {
    report: {
      reportVersion: 1,
      ok: true,
      request,
      runtime,
      dependencies,
      warnings,
      violations,
      buildOutput: reportBuildOutput,
      capture,
    },
    buildOutput: standaloneBuildOutput,
  };
}

function validateDependencyGraph(
  dependencies: ResolvedDependency[],
  buildOutput: BuildOutputPayload,
): void {
  const byPackage = new Map(dependencies.map((dependency) => [dependency.packageName, dependency]));
  const pending = [...buildOutput.requiredByConcepts, ...buildOutput.requiredByProofs];
  const reachable = new Set<string>();
  for (let index = 0; index < pending.length; index += 1) {
    const packageName = pending[index]!;
    if (reachable.has(packageName)) continue;
    const dependency = byPackage.get(packageName);
    if (dependency === undefined) {
      throw new ValidationError(`generated dependency ${packageName} is missing from the validation report`);
    }
    reachable.add(packageName);
    pending.push(...dependency.requiredPackages);
    if (dependency.kind === "proofs") pending.push(packageName.slice(0, -"Proofs".length));
  }
  const extras = dependencies.filter((dependency) => !reachable.has(dependency.packageName));
  if (extras.length > 0) {
    throw new ValidationError(
      `validation report contains unreachable dependencies: ${extras.map((entry) => entry.packageName).join(", ")}`,
    );
  }
}

export function parsePublishedCapture(value: unknown): PublishedCapture {
  return parseCaptureManifest(value, true) as PublishedCapture;
}

function parseRuntime(value: unknown): ValidationRuntimeIdentity {
  const object = exactObject(value, [
    "environment",
    "image",
    "imageDigest",
    "layoutVersion",
    "leanToolchain",
    "leanVersion",
    "mathlibRepository",
    "mathlibCommit",
  ], "validation runtime");
  const image = text(object.image, "validation runtime image", 512, false);
  const imageDigest = sha256(object.imageDigest, "validation runtime image digest");
  if (!image.endsWith(`@sha256:${imageDigest}`) && image !== `sha256:${imageDigest}`) {
    throw new ValidationError("validation runtime image and digest do not match");
  }
  const layoutVersion = positiveInteger(object.layoutVersion, "validation runtime layout version");
  // Shape only: the caller compares the whole identity to the one it built
  // from the environment table itself, so a report claiming an id whose pins
  // are not that entry's fails there, credential-free.
  return {
    environment: text(object.environment, "validation runtime environment", 64, false),
    image,
    imageDigest,
    layoutVersion,
    leanToolchain: text(object.leanToolchain, "validation Lean toolchain", 128, false),
    leanVersion: text(object.leanVersion, "validation Lean version", 64, false),
    mathlibRepository: validateSource({
      repository: object.mathlibRepository,
      commit: object.mathlibCommit,
      folder: ".",
    }).repository,
    mathlibCommit: validateCommit(object.mathlibCommit),
  };
}

function parseDependency(
  value: unknown,
  index: number,
  runtime: ValidationRuntimeIdentity,
): ResolvedDependency {
  const label = `validation dependency ${index + 1}`;
  const object = exactObject(value, [
    "packageName",
    "submissionId",
    "kind",
    "source",
    "state",
    "capture",
    "statements",
    "requiredPackages",
  ], label);
  const packageName = identifier(object.packageName, `${label} packageName`, 512);
  const submissionId = typeof object.submissionId === "string"
    ? validateSubmissionId(object.submissionId)
    : (() => { throw new ValidationError(`${label} submissionId must be a string`); })();
  if (submissionIdForPackage(packageName) !== submissionId) {
    throw new ValidationError(`${label} packageName does not match submissionId`);
  }
  const kind = object.kind;
  if (kind !== "concepts" && kind !== "proofs") throw new ValidationError(`${label} kind is invalid`);
  if ((kind === "proofs") !== packageName.endsWith("Proofs")) {
    throw new ValidationError(`${label} kind does not match packageName`);
  }
  const state = object.state;
  if (state !== "draft" && state !== "registered") throw new ValidationError(`${label} state is invalid`);
  const source = parseSource(object.source, `${label} source`);
  const capture = parsePublishedCapture(object.capture);
  if (
    capture.sourceCommit !== source.commit ||
    capture.leanToolchain !== runtime.leanToolchain ||
    capture.mathlibCommit !== runtime.mathlibCommit
  ) throw new ValidationError(`${label} capture provenance is inconsistent`);
  return {
    packageName,
    submissionId,
    kind,
    source,
    state,
    capture,
    statements: stringArray(object.statements, `${label} statements`, MAX_ENTRIES, 2_048),
    requiredPackages: stringArray(object.requiredPackages, `${label} requiredPackages`, MAX_ENTRIES, 512),
  };
}

function parseBuildOutputPayload(
  value: unknown,
  request: ValidationRequest,
  runtime: ValidationRuntimeIdentity,
): BuildOutputPayload {
  if (!isObject(value)) throw new ValidationError("generated build output must be an object");
  const object = exactObject(value, [
    "inputs",
    "requiredByConcepts",
    "requiredByProofs",
    "concepts",
    "proofs",
    "capture",
    ...(value.paper === undefined ? [] : ["paper"]),
  ], "generated build output");
  const inputs = exactObject(object.inputs, ["manifest", "abstract"], "generated build output inputs");
  const manifest = parseManifest(inputs.manifest, request.id, runtime);
  if ((manifest.paper !== undefined) !== (object.paper !== undefined)) {
    throw new ValidationError("generated build output must carry a paper exactly when the manifest declares one");
  }
  // The validate job records the PDF's digest and size; only the publisher
  // adds the registry address, after pushing the bytes (stage 3).
  const paper = object.paper === undefined ? undefined : parsePaperOutput(object.paper, manifest.paper!, false);
  const abstract = text(inputs.abstract, "generated abstract", 1024 * 1024, true);
  if (abstract.trim() === "") throw new ValidationError("generated abstract must not be empty");
  const concepts = boundedArray(object.concepts, "generated concepts", MAX_ENTRIES)
    .map((entry, index) => parseConcept(entry, index));
  const proofs = boundedArray(object.proofs, "generated proofs", MAX_ENTRIES)
    .map((entry, index) => parseProof(entry, index));
  requireUnique(concepts.map((entry) => entry.id), "generated concept ids");
  requireUnique(proofs.map((entry) => entry.id), "generated proof ids");
  return {
    inputs: { manifest, abstract },
    requiredByConcepts: stringArray(object.requiredByConcepts, "requiredByConcepts", MAX_ENTRIES, 512),
    requiredByProofs: stringArray(object.requiredByProofs, "requiredByProofs", MAX_ENTRIES, 512),
    concepts,
    proofs,
    capture: parseCaptureManifest(object.capture, false),
    ...(paper === undefined ? {} : { paper }),
  };
}

/**
 * The `paper` key of a build output (paper-plan.md, "Recorded shape"),
 * parsed fail-closed against the manifest block it must repeat — the repeat
 * check covers folder/main/engine only, never the manifest's `web` opt-out
 * (which gates the *derivation*, not the record shape). `published` demands
 * the digest-addressed registry blobs a database record carries; the
 * validate artifact must not have them yet. `web` is optional in both
 * branches (the conditional-key idiom), so pre-web records keep parsing.
 */
export function parsePaperOutput(value: unknown, manifest: PaperManifest, published: boolean): PaperOutput {
  if (!isObject(value)) throw new ValidationError("generated paper must be an object");
  const object = exactObject(value, [
    "folder",
    "main",
    "engine",
    "pdf",
    "pageSizes",
    "marks",
    ...(value.web === undefined ? [] : ["web"]),
  ], "generated paper");
  const folder = validateFolder(object.folder);
  const main = validatePaperMain(object.main);
  const engine = object.engine;
  if (typeof engine !== "string" || !(PAPER_ENGINES as readonly string[]).includes(engine)) {
    throw new ValidationError("generated paper engine is invalid");
  }
  if (folder !== manifest.folder || main !== manifest.main || engine !== manifest.engine) {
    throw new ValidationError("generated paper does not repeat the manifest's paper block");
  }
  if (object.web !== undefined && manifest.web === false) {
    throw new ValidationError("generated paper carries a web view the manifest opted out of");
  }
  const pdf = exactObject(object.pdf, ["digest", "bytes", "pages", ...(published ? ["registryBlob"] : [])], "generated paper pdf");
  const digest = sha256(pdf.digest, "generated paper pdf digest");
  const bytes = positiveInteger(pdf.bytes, "generated paper pdf bytes");
  if (bytes > PAPER_CAPS.pdfBytes) throw new ValidationError(`generated paper pdf exceeds ${PAPER_CAPS.pdfBytes} bytes`);
  const pages = positiveInteger(pdf.pages, "generated paper pdf pages");
  if (pages > PAPER_CAPS.pages) throw new ValidationError(`generated paper pdf exceeds ${PAPER_CAPS.pages} pages`);
  let registryBlob: string | undefined;
  if (published) {
    if (typeof pdf.registryBlob !== "string") throw new ValidationError("published paper registryBlob must be a string");
    const reference = parseCaptureBlobReference(pdf.registryBlob);
    if (reference === undefined) throw new ValidationError("published paper registryBlob is not a ghcr digest reference");
    if (reference.digest !== digest) throw new ValidationError("published paper registryBlob digest does not match the pdf digest");
    registryBlob = pdf.registryBlob;
  }
  const pageSizes = boundedArray(object.pageSizes, "generated paper pageSizes", PAPER_CAPS.pages).map((size, index) => {
    const label = `generated paper page size ${index + 1}`;
    if (!Array.isArray(size) || size.length !== 2) throw new ValidationError(`${label} must be a [width, height] pair`);
    return [coordinate(size[0], `${label} width`, true), coordinate(size[1], `${label} height`, true)] as [number, number];
  });
  if (pageSizes.length !== pages) throw new ValidationError("generated paper pageSizes must have one entry per page");
  const marks = boundedArray(object.marks, "generated paper marks", PAPER_CAPS.marks)
    .map((entry, index) => parsePaperMark(entry, index, pages));
  const web = object.web === undefined ? undefined : parsePaperWeb(object.web, published);
  return {
    folder,
    main,
    engine: engine as PaperOutput["engine"],
    pdf: { digest, bytes, pages, ...(registryBlob === undefined ? {} : { registryBlob }) },
    pageSizes,
    marks,
    ...(web === undefined ? {} : { web }),
  };
}

/**
 * The `paper.web` key (paper-web-plan.md, "Recorded shape"): the format pin
 * of the deriver and the bundle's content address. Digests are bare 64-hex
 * like every recorded digest; the `sha256:` prefix appears only inside the
 * OCI registryBlob address, which the published branch requires to carry
 * exactly the bundle digest.
 */
function parsePaperWeb(value: unknown, published: boolean): PaperWebOutput {
  const object = exactObject(value, ["format", "bundle"], "generated paper web");
  const format = exactObject(object.format, ["tool", "rev", "schema"], "generated paper web format");
  const tool = nonemptyText(format.tool, "generated paper web format tool", 64, false);
  const rev = validateCommit(format.rev);
  const schema = sha256(format.schema, "generated paper web format schema");
  const bundle = exactObject(
    object.bundle,
    ["digest", "bytes", ...(published ? ["registryBlob"] : [])],
    "generated paper web bundle",
  );
  const digest = sha256(bundle.digest, "generated paper web bundle digest");
  const bytes = positiveInteger(bundle.bytes, "generated paper web bundle bytes");
  if (bytes > PAPER_CAPS.webBundleBytes) {
    throw new ValidationError(`generated paper web bundle exceeds ${PAPER_CAPS.webBundleBytes} bytes`);
  }
  let registryBlob: string | undefined;
  if (published) {
    if (typeof bundle.registryBlob !== "string") {
      throw new ValidationError("published paper web registryBlob must be a string");
    }
    const reference = parseCaptureBlobReference(bundle.registryBlob);
    if (reference === undefined) {
      throw new ValidationError("published paper web registryBlob is not a ghcr digest reference");
    }
    if (reference.digest !== digest) {
      throw new ValidationError("published paper web registryBlob digest does not match the bundle digest");
    }
    registryBlob = bundle.registryBlob;
  }
  return {
    format: { tool, rev, schema },
    bundle: { digest, bytes, ...(registryBlob === undefined ? {} : { registryBlob }) },
  };
}

function parsePaperMark(value: unknown, index: number, pages: number): PaperMark {
  const label = `generated paper mark ${index + 1}`;
  const object = exactObject(value, ["id", "kind", "begin", "end"], label);
  const id = nonemptyText(object.id, `${label} id`, 2_048, false);
  const shape = markIdProblem(id);
  if (shape !== undefined) throw new ValidationError(`${label} id: ${shape}`);
  const kind = object.kind;
  if (kind !== "concept" && kind !== "proof" && kind !== "submission") {
    throw new ValidationError(`${label} kind is invalid`);
  }
  if (kind !== markIdKind(id)) throw new ValidationError(`${label} kind does not match its id`);
  return {
    id,
    kind,
    begin: parsePaperPoint(object.begin, `${label} begin`, pages),
    end: parsePaperPoint(object.end, `${label} end`, pages),
  };
}

function parsePaperPoint(value: unknown, label: string, pages: number): PaperMarkPoint {
  const object = exactObject(value, ["page", "x", "y", "mode"], label);
  const page = positiveInteger(object.page, `${label} page`);
  if (page > pages) throw new ValidationError(`${label} page is beyond the last page`);
  const mode = object.mode;
  if (mode !== "v" && mode !== "h") throw new ValidationError(`${label} mode is invalid`);
  return { page, x: coordinate(object.x, `${label} x`, false), y: coordinate(object.y, `${label} y`, false), mode };
}

/** A PDF user-space number: finite, and for a page size strictly positive. */
function coordinate(value: unknown, label: string, positive: boolean): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e6) {
    throw new ValidationError(`${label} must be a finite number`);
  }
  if (positive && value <= 0) throw new ValidationError(`${label} must be positive`);
  return value;
}

function parseManifest(
  value: unknown,
  expectedId: string,
  runtime: ValidationRuntimeIdentity,
): SubmissionManifest {
  if (!isObject(value)) throw new ValidationError("generated manifest must be an object");
  const object = exactObject(value, [
    "specVersion",
    "id",
    "leanVersion",
    "mathlibVersion",
    "title",
    "authors",
    "bibEntries",
    ...(value.supersedes === undefined ? [] : ["supersedes"]),
    ...(value.paper === undefined ? [] : ["paper"]),
  ], "generated manifest");
  if (object.specVersion !== "1" || object.id !== expectedId) {
    throw new ValidationError("generated manifest identity is invalid");
  }
  if (object.leanVersion !== runtime.leanVersion || object.mathlibVersion !== runtime.mathlibCommit) {
    throw new ValidationError("generated manifest runtime pins are invalid");
  }
  const title = text(object.title, "generated manifest title", 512, false);
  if (normalizeTitle(title) !== title) throw new ValidationError("generated manifest title is not normalized");
  const authors = boundedArray(object.authors, "generated manifest authors", 100)
    .map((entry, index) => parseAuthor(entry, index));
  let supersedes: string | undefined;
  if (object.supersedes !== undefined) {
    if (typeof object.supersedes !== "string") {
      throw new ValidationError("generated manifest supersedes must be a string");
    }
    supersedes = validateSubmissionId(object.supersedes);
    if (supersedes === expectedId) {
      throw new ValidationError("generated manifest cannot supersede its own submission");
    }
  }
  let paper: PaperManifest | undefined;
  if (object.paper !== undefined) {
    if (!isObject(object.paper)) throw new ValidationError("generated manifest paper must be an object");
    const block = exactObject(object.paper, [
      "folder",
      "main",
      "engine",
      ...(object.paper.web === undefined ? [] : ["web"]),
    ], "generated manifest paper");
    const engine = block.engine;
    if (typeof engine !== "string" || !(PAPER_ENGINES as readonly string[]).includes(engine)) {
      throw new ValidationError("generated manifest paper engine is invalid");
    }
    if (block.web !== undefined && typeof block.web !== "boolean") {
      throw new ValidationError("generated manifest paper web must be a boolean");
    }
    paper = {
      folder: validateFolder(block.folder),
      main: validatePaperMain(block.main),
      engine: engine as PaperManifest["engine"],
      ...(block.web === undefined ? {} : { web: block.web }),
    };
  }
  return {
    specVersion: "1",
    id: expectedId,
    leanVersion: runtime.leanVersion,
    mathlibVersion: runtime.mathlibCommit,
    title,
    authors,
    bibEntries: stringArray(object.bibEntries, "generated manifest bibEntries", 1_000, 16 * 1024, true),
    ...(supersedes === undefined ? {} : { supersedes }),
    ...(paper === undefined ? {} : { paper }),
  };
}

function parseAuthor(value: unknown, index: number): SubmissionAuthor {
  const label = `generated manifest author ${index + 1}`;
  if (!isObject(value)) throw new ValidationError(`${label} must be an object`);
  const keys = ["name", ...(value.orcid === undefined ? [] : ["orcid"]), ...(value.github === undefined ? [] : ["github"])];
  requireExactKeys(value, keys, label);
  return {
    name: nonemptyText(value.name, `${label} name`, 512, false),
    ...(value.orcid === undefined ? {} : { orcid: nonemptyText(value.orcid, `${label} orcid`, 128, false) }),
    ...(value.github === undefined ? {} : { github: nonemptyText(value.github, `${label} github`, 128, false) }),
  };
}

function parseConcept(value: unknown, index: number): ConceptEntry {
  const label = `generated concept ${index + 1}`;
  if (!isObject(value)) throw new ValidationError(`${label} must be an object`);
  requireExactKeys(value, [
    "id", "path", "title", "type", "description",
    ...(value.sections === undefined ? [] : ["sections"]),
    "imports", "mathlibImports", "sourceText", "statements",
  ], label);
  // A concept may declare any number of statements; the cap is only a
  // trusted-parse bound, not the old one-statement-per-concept rule.
  const statements = boundedArray(value.statements, `${label} statements`, MAX_ENTRIES)
    .map((entry, statementIndex) => parseStatement(entry, `${label} statement ${statementIndex + 1}`));
  return {
    id: identifier(value.id, `${label} id`, 2_048),
    path: relativeFile(value.path, `${label} path`),
    title: nonemptyText(value.title, `${label} title`, 8 * 1024, false),
    type: nonemptyText(value.type, `${label} type`, 8 * 1024, false),
    description: nonemptyText(value.description, `${label} description`, 1024 * 1024, true),
    ...(value.sections === undefined ? {} : { sections: parseSections(value.sections, label) }),
    imports: stringArray(value.imports, `${label} imports`, MAX_ENTRIES, 2_048),
    mathlibImports: stringArray(value.mathlibImports, `${label} mathlibImports`, MAX_ENTRIES, 2_048),
    sourceText: text(value.sourceText, `${label} sourceText`, 4 * 1024 * 1024, true, false),
    statements,
  };
}

function parseStatement(value: unknown, label: string): StatementEntry {
  if (!isObject(value)) throw new ValidationError(`${label} must be an object`);
  requireExactKeys(value, [
    "id", "signature",
    ...(value.startLine === undefined ? [] : ["startLine"]),
    ...(value.endLine === undefined ? [] : ["endLine"]),
    ...(value.doc === undefined ? [] : ["doc"]),
  ], label);
  const startLine = value.startLine === undefined ? undefined : positiveInteger(value.startLine, `${label} startLine`);
  const endLine = value.endLine === undefined ? undefined : positiveInteger(value.endLine, `${label} endLine`);
  if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
    throw new ValidationError(`${label} line range is reversed`);
  }
  return {
    id: identifier(value.id, `${label} id`, 2_048),
    signature: nonemptyText(value.signature, `${label} signature`, 64 * 1024, true),
    ...(startLine === undefined ? {} : { startLine }),
    ...(endLine === undefined ? {} : { endLine }),
    ...(value.doc === undefined ? {} : { doc: text(value.doc, `${label} doc`, 1024 * 1024, true) }),
  };
}

function parseProof(value: unknown, index: number): BuildOutputPayload["proofs"][number] {
  const label = `generated proof ${index + 1}`;
  if (!isObject(value)) throw new ValidationError(`${label} must be an object`);
  requireExactKeys(value, [
    "id", "path", "conclusion", "assumptions", "description",
    ...(value.sections === undefined ? [] : ["sections"]),
  ], label);
  return {
    id: identifier(value.id, `${label} id`, 2_048),
    path: relativeFile(value.path, `${label} path`),
    conclusion: identifier(value.conclusion, `${label} conclusion`, 2_048),
    assumptions: stringArray(value.assumptions, `${label} assumptions`, MAX_ENTRIES, 2_048),
    description: text(value.description, `${label} description`, 1024 * 1024, true),
    ...(value.sections === undefined ? {} : { sections: parseSections(value.sections, label) }),
  };
}

function parseSections(value: unknown, owner: string): AnnotationSection[] {
  return boundedArray(value, `${owner} sections`, 1_000).map((entry, index) => {
    const label = `${owner} section ${index + 1}`;
    const object = exactObject(entry, ["title", "markdown"], label);
    return {
      title: nonemptyText(object.title, `${label} title`, 8 * 1024, false),
      markdown: text(object.markdown, `${label} markdown`, 1024 * 1024, true),
    };
  });
}

function parseCaptureManifest(value: unknown, published: boolean): CaptureManifest | PublishedCapture {
  const object = exactObject(value, [
    "formatVersion", "digest", "sourceCommit", "leanToolchain", "mathlibCommit", "files",
    ...(published ? ["registryBlob"] : []),
  ], published ? "published capture" : "capture manifest");
  if (object.formatVersion !== 1) throw new ValidationError("capture formatVersion must be 1");
  const files = boundedArray(object.files, "capture files", MAX_CAPTURE_FILES)
    .map((entry, index) => parseCapturedFile(entry, index));
  if (files.length === 0) throw new ValidationError("capture files must not be empty");
  requireUnique(files.map((entry) => entry.path), "capture paths");
  const total = files.reduce((sum, entry) => sum + entry.bytes, 0);
  if (!Number.isSafeInteger(total) || total > MAX_CAPTURE_BYTES) throw new ValidationError("capture files exceed 2 GiB");
  const base: CaptureManifest = {
    formatVersion: 1,
    digest: sha256(object.digest, "capture digest"),
    sourceCommit: validateCommit(object.sourceCommit),
    leanToolchain: nonemptyText(object.leanToolchain, "capture leanToolchain", 128, false),
    mathlibCommit: validateCommit(object.mathlibCommit),
    files,
  };
  if (!published) return base;
  // Consumers never fetch a capture by tag: the reference must be a ghcr
  // digest address carrying exactly the digest this record declares, and
  // readers pull that digest and hash the received bytes. Any other
  // reference is rejected fail-closed here instead of trusted at download.
  if (typeof object.registryBlob !== "string") throw new ValidationError("published capture registryBlob must be a string");
  const reference = parseCaptureBlobReference(object.registryBlob);
  if (reference === undefined) {
    throw new ValidationError("published capture registryBlob is not a ghcr digest reference");
  }
  if (reference.digest !== base.digest) {
    throw new ValidationError("published capture registryBlob digest does not match the capture digest");
  }
  return { ...base, registryBlob: object.registryBlob };
}

function parseCapturedFile(value: unknown, index: number): CapturedFile {
  const label = `capture file ${index + 1}`;
  const object = exactObject(value, ["path", "bytes", "sha256"], label);
  const filePath = relativeFile(object.path, `${label} path`);
  const bytes = nonnegativeInteger(object.bytes, `${label} bytes`);
  return { path: filePath, bytes, sha256: sha256(object.sha256, `${label} sha256`) };
}

/** The most UTF-8 bytes a finding's rule and message may carry. `parseFinding`
 * enforces the bounds and `oneLineMessage` fits text to them, so the producer
 * and the parser cannot drift apart. */
export const FINDING_RULE_BYTES = 256;
export const FINDING_MESSAGE_BYTES = 8_000;

/** The elision marker. Visible on purpose: a reader must be able to tell a
 * cut from the real wording. */
const ELISION = "[…]";

/**
 * Rewrite arbitrary text — a transcript tail, a thrown error's `message`, a
 * file name the submission chose — into the exact shape `parseFinding`
 * accepts: line breaks folded to a visible marker, every character the schema
 * forbids replaced by a space, unpaired surrogates replaced, NFC applied and
 * the result fitted to `maxBytes`. Applying the rules instead of restating
 * them at each place that builds a finding is what stops a *passing*
 * validation from being refused at publication over its own warning text —
 * a refusal there is terminal, because rerunning the validation produces the
 * same bytes again.
 *
 * `elide` chooses what to sacrifice when the text is too long. A finding
 * message names what happened at its start and carries the transcript at its
 * end, so the default keeps both ends and drops the middle; a bare transcript
 * tail keeps only its end, where the error is.
 */
export function oneLineMessage(
  message: string,
  options: { maxBytes?: number; elide?: "middle" | "start" } = {},
): string {
  // Normalize before fitting, never after: composition exclusions mean NFC
  // can lengthen a string, and the byte budget has to hold for the text that
  // is actually written.
  const folded = message
    .replace(LINE_BREAK, " ⏎ ")
    .replace(ONE_LINE_FORBIDDEN_GLOBAL, " ")
    .replace(LONE_SURROGATE, "\ufffd")
    .normalize("NFC");
  const fitted = fitBytes(folded, options.maxBytes ?? FINDING_MESSAGE_BYTES, options.elide ?? "middle");
  // `nonemptyText` refuses a blank field, so text that sanitized away to
  // nothing still has to say that much: losing a report over an empty message
  // would be the very failure this function exists to prevent.
  return fitted.trim() === "" ? "(none)" : fitted;
}

function fitBytes(message: string, maxBytes: number, elide: "middle" | "start"): string {
  if (Buffer.byteLength(message, "utf8") <= maxBytes) return message;
  const marker = elide === "start" ? `${ELISION} ` : ` ${ELISION} `;
  const budget = maxBytes - Buffer.byteLength(marker, "utf8");
  if (budget <= 0) return utf8Prefix(message, maxBytes);
  if (elide === "start") return `${marker}${utf8Suffix(message, budget)}`;
  const head = utf8Prefix(message, Math.ceil(budget / 2));
  return `${head}${marker}${utf8Suffix(message, budget - Buffer.byteLength(head, "utf8"))}`;
}

/** The longest prefix of `message` within `maxBytes`, cut on a code point
 * boundary: a byte-wise cut would leave a partial sequence that decodes to a
 * replacement character. A prefix (and likewise a suffix) of NFC text is
 * itself NFC, so the fitting cannot undo the normalization above. */
function utf8Prefix(message: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of message) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += character.length;
  }
  return message.slice(0, end);
}

/** The longest suffix of `message` within `maxBytes`, cut the same way. */
function utf8Suffix(message: string, maxBytes: number): string {
  const characters = [...message];
  let bytes = 0;
  let start = message.length;
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index]!;
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    start -= character.length;
  }
  return message.slice(start);
}

function parseFinding(value: unknown, label: string): ValidationFinding {
  const object = exactObject(value, ["phase", "rule", "message"], label);
  if (typeof object.phase !== "string" || !PHASES.has(object.phase)) {
    throw new ValidationError(`${label} phase is invalid`);
  }
  return {
    phase: object.phase as ValidationFinding["phase"],
    rule: nonemptyText(object.rule, `${label} rule`, FINDING_RULE_BYTES, false),
    message: nonemptyText(object.message, `${label} message`, FINDING_MESSAGE_BYTES, false),
  };
}

function parseSource(value: unknown, label: string): SourceLocation {
  const object = exactObject(value, ["repository", "commit", "folder"], label);
  return validateSource(object);
}

function exactObject(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!isObject(value)) throw new ValidationError(`${label} must be an object`);
  requireExactKeys(value, keys, label);
  return value;
}

function boundedArray(value: unknown, label: string, limit: number): unknown[] {
  if (!Array.isArray(value)) throw new ValidationError(`${label} must be an array`);
  if (value.length > limit) throw new ValidationError(`${label} contains more than ${limit} entries`);
  return value;
}

function stringArray(
  value: unknown,
  label: string,
  countLimit: number,
  byteLimit: number,
  multiline = false,
): string[] {
  const result = boundedArray(value, label, countLimit)
    .map((entry, index) => text(entry, `${label}[${index}]`, byteLimit, multiline));
  requireUnique(result, label);
  return result;
}

function requireUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new ValidationError(`${label} must be unique`);
}

function identifier(value: unknown, label: string, maxBytes: number): string {
  const result = nonemptyText(value, label, maxBytes, false);
  if (!LEAN_NAME_PATTERN.test(result)) throw new ValidationError(`${label} must be a canonical Lean name`);
  return result;
}

function relativeFile(value: unknown, label: string): string {
  const result = nonemptyText(value, label, 4_096, false);
  if (result.includes("\\") || path.posix.isAbsolute(result)) throw new ValidationError(`${label} is not a relative POSIX path`);
  const normalized = path.posix.normalize(result);
  if (normalized !== result || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new ValidationError(`${label} is not a contained file path`);
  }
  return result;
}

function nonemptyText(
  value: unknown,
  label: string,
  maxBytes: number,
  multiline: boolean,
): string {
  const result = text(value, label, maxBytes, multiline);
  if (result.trim() === "") throw new ValidationError(`${label} must not be empty`);
  return result;
}

// What a report field may never carry, written once as a character-class body
// so the checks below and the rewriting in `oneLineMessage` cannot drift
// apart: control characters other than tab and the line terminators, DEL, the
// line and paragraph separators, and the zero-width, bidi-override and other
// invisible formatting marks. A one-line field forbids tab, LF and CR on top
// of those, and \u0009-\u000d closes the range to \u0000-\u001f.
const FORBIDDEN_ANYWHERE =
  "\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f\\u2028\\u2029\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\ufeff";
const FORBIDDEN_ON_ONE_LINE = `${FORBIDDEN_ANYWHERE}\\u0009-\\u000d`;
const MULTILINE_FORBIDDEN = new RegExp(`[${FORBIDDEN_ANYWHERE}]`, "u");
const ONE_LINE_FORBIDDEN = new RegExp(`[${FORBIDDEN_ON_ONE_LINE}]`, "u");
const ONE_LINE_FORBIDDEN_GLOBAL = new RegExp(`[${FORBIDDEN_ON_ONE_LINE}]`, "gu");
const LINE_BREAK = /\r\n|\r|\n/gu;
/** A surrogate the string never paired. Under the `u` flag a well-formed pair
 * is a single non-surrogate code point, so this matches exactly the lone
 * halves `hasUnpairedSurrogate` refuses. */
const LONE_SURROGATE = /[\ud800-\udfff]/gu;

function text(
  value: unknown,
  label: string,
  maxBytes: number,
  multiline: boolean,
  requireNfc = true,
): string {
  if (typeof value !== "string") throw new ValidationError(`${label} must be a string`);
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw new ValidationError(`${label} exceeds ${maxBytes} UTF-8 bytes`);
  if (requireNfc && value.normalize("NFC") !== value) throw new ValidationError(`${label} is not NFC-normalized`);
  if (!multiline && /[\r\n]/u.test(value)) throw new ValidationError(`${label} must be one line`);
  if (multiline && /\r/u.test(value)) throw new ValidationError(`${label} must use LF line endings`);
  const forbidden = multiline ? MULTILINE_FORBIDDEN : ONE_LINE_FORBIDDEN;
  if (forbidden.test(value) || hasUnpairedSurrogate(value)) throw new ValidationError(`${label} contains forbidden Unicode`);
  return value;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new ValidationError(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new ValidationError(`${label} must be a positive integer`);
  return value as number;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ValidationError(`${label} must be a nonnegative integer`);
  return value as number;
}
