import path from "node:path";
import type { SourceLocation } from "../shared/types.js";
import {
  isObject,
  normalizeTitle,
  requireExactKeys,
  validateCommit,
  validateSource,
  validateSubmissionId,
  ValidationError,
} from "../shared/validation.js";
import type {
  AnnotationSection,
  BuildOutputPayload,
  CaptureManifest,
  CapturedFile,
  ConceptEntry,
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
  parseCaptureBlobReference,
  submissionIdForPackage,
  validationRequestFromUnknown,
} from "./contracts.js";

const MAX_CAPTURE_FILES = 100_000;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
const MAX_DEPENDENCIES = 10_000;
const MAX_FINDINGS = 10_000;
const LEAN_NAME = /^(?:[\p{L}_][\p{L}\p{N}\p{M}_']*)(?:\.(?:[\p{L}_][\p{L}\p{N}\p{M}_']*))*$/u;
const PHASES = new Set([
  "source",
  "static",
  "resolution",
  "provision",
  "compile-concepts",
  "compile-proofs",
  "replay",
  "inspect",
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
    throw new ValidationError("validation report request does not match the authorized update request");
  }
  const runtime = parseRuntime(reportObject.runtime);
  if (JSON.stringify(runtime) !== JSON.stringify(expectedRuntime)) {
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
  return {
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
  const object = exactObject(value, [
    "inputs",
    "requiredByConcepts",
    "requiredByProofs",
    "concepts",
    "proofs",
    "capture",
  ], "generated build output");
  const inputs = exactObject(object.inputs, ["manifest", "abstract"], "generated build output inputs");
  const manifest = parseManifest(inputs.manifest, request.id, runtime);
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
  };
}

function parseManifest(
  value: unknown,
  expectedId: string,
  runtime: ValidationRuntimeIdentity,
): SubmissionManifest {
  const object = exactObject(value, [
    "specVersion",
    "id",
    "leanVersion",
    "mathlibVersion",
    "title",
    "authors",
    "bibEntries",
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
  return {
    specVersion: "1",
    id: expectedId,
    leanVersion: runtime.leanVersion,
    mathlibVersion: runtime.mathlibCommit,
    title,
    authors,
    bibEntries: stringArray(object.bibEntries, "generated manifest bibEntries", 1_000, 16 * 1024, true),
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
  const statements = boundedArray(value.statements, `${label} statements`, 1)
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

function parseFinding(value: unknown, label: string): ValidationFinding {
  const object = exactObject(value, ["phase", "rule", "message"], label);
  if (typeof object.phase !== "string" || !PHASES.has(object.phase)) {
    throw new ValidationError(`${label} phase is invalid`);
  }
  return {
    phase: object.phase as ValidationFinding["phase"],
    rule: nonemptyText(object.rule, `${label} rule`, 256, false),
    message: nonemptyText(object.message, `${label} message`, 8_000, false),
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
  if (!LEAN_NAME.test(result)) throw new ValidationError(`${label} must be a canonical Lean name`);
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
  const forbidden = multiline
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u
    : /[\u0000-\u001f\u007f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
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
