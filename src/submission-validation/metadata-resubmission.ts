import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isMap, isScalar, parseDocument } from "yaml";
import type { LoadedSubmission } from "../shared/archive.js";
import { requireCurrentRecord } from "../shared/record-gates.js";
import type { IssueBinding, PublishRequest, SourceLocation } from "../shared/types.js";
import {
  decodeUtf8,
  isObject,
  requireExactKeys,
  validateSource,
  validateSubmissionId,
  ValidationError,
} from "../shared/validation.js";
import { parsePublishedBuildOutputPayload } from "./artifact-schema.js";
import { DEFAULT_LIMITS, configuredRuntime } from "./config.js";
import type {
  BuildOutputPayload,
  SubmissionManifest,
  ValidationRequest,
  ValidationRuntimeIdentity,
} from "./contracts.js";
import { environment as environmentById } from "./environments.js";
import { FindingCollector } from "./findings.js";
import { fetchGitCommits } from "./source/fetch.js";
import { validateManifest } from "./validators/manifest.js";

const MANIFEST_LIMIT = 256 * 1024;
const ABSTRACT_LIMIT = 1024 * 1024;
const TREE_OUTPUT_LIMIT = 64 * 1024 * 1024;
const TREE_ENTRY_LIMIT = 100_000;
const PRESENTATION_FIELDS = ["title", "authors", "abstract"] as const;
const MANIFEST_PRESENTATION_FIELDS = new Set(["title", "authors"]);

export type PresentationField = (typeof PRESENTATION_FIELDS)[number];

export interface MetadataResubmissionArtifact {
  metadataVersion: 1;
  id: string;
  previousSource: SourceLocation;
  source: SourceLocation;
  previousBuildOutput: string;
  fields: PresentationField[];
  inputs: {
    manifest: SubmissionManifest;
    abstract: string;
  };
}

export interface ParsedMetadataResubmissionArtifact
  extends Omit<MetadataResubmissionArtifact, "inputs"> {
  inputs: {
    manifest: unknown;
    abstract: string;
  };
}

interface GitTreeEntry {
  mode: string;
  type: "blob" | "commit";
  object: string;
}

export interface PublishedBuildOutput {
  payload: BuildOutputPayload & { capture: BuildOutputPayload["capture"] & { registryBlob: string } };
  runtime: ValidationRuntimeIdentity;
}

/**
 * Return a reusable metadata artifact only after comparing the complete Git
 * trees and the exact non-presentation bytes of manifest.yaml. Any exception
 * is intentionally left to the workflow entry point, which treats it as
 * "classify unknown" and runs the ordinary validation pipeline.
 */
export async function classifyMetadataResubmission(
  request: PublishRequest,
  loaded: LoadedSubmission | undefined,
  options: { fetchTimeoutMs?: number } = {},
): Promise<MetadataResubmissionArtifact | undefined> {
  const current = requireCurrentRecord(request.id, loaded);
  const command = request.command;
  if (request.action !== "submit" || command?.action !== "submit") return undefined;
  const previousSource = current.files.record.source;
  const source = sourceOfSubmitCommand(command);
  if (
    previousSource === undefined ||
    previousSource.repository !== source.repository ||
    previousSource.folder !== source.folder ||
    previousSource.commit === source.commit ||
    request.preconditions?.record !== current.preconditions.record ||
    request.preconditions.buildOutput !== current.preconditions.buildOutput
  ) return undefined;

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lax-metadata-compare-"));
  const repositoryRoot = path.join(temporary, "repository");
  try {
    await fetchGitCommits(
      source.repository,
      [previousSource.commit, source.commit],
      repositoryRoot,
      options.fetchTimeoutMs ?? DEFAULT_LIMITS.fetchTimeoutMs,
    );
    return classifyFetchedMetadataResubmission(request, current, repositoryRoot);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

/** The pure-after-fetch half, exported so adversarial tests can use real local Git trees. */
export function classifyFetchedMetadataResubmission(
  request: PublishRequest,
  loaded: LoadedSubmission | undefined,
  repositoryRoot: string,
): MetadataResubmissionArtifact | undefined {
  const current = requireCurrentRecord(request.id, loaded);
  const command = request.command;
  if (request.action !== "submit" || command?.action !== "submit") return undefined;
  const previousSource = current.files.record.source;
  const source = sourceOfSubmitCommand(command);
  if (
    previousSource === undefined ||
    previousSource.repository !== source.repository ||
    previousSource.folder !== source.folder ||
    previousSource.commit === source.commit ||
    request.preconditions?.record !== current.preconditions.record ||
    request.preconditions.buildOutput !== current.preconditions.buildOutput
  ) return undefined;

  const previousTree = readTree(repositoryRoot, previousSource.commit);
  const nextTree = readTree(repositoryRoot, source.commit);
  const changedPaths = changedTreePaths(previousTree, nextTree);
  if (changedPaths.length === 0) return undefined;
  const prefix = source.folder === "." ? "" : `${source.folder}/`;
  const manifestPath = `${prefix}manifest.yaml`;
  const abstractPath = `${prefix}abstract.md`;
  const allowedPaths = new Set([manifestPath, abstractPath]);
  if (changedPaths.some((changed) => !allowedPaths.has(changed))) return undefined;
  for (const filename of allowedPaths) {
    const before = previousTree.get(filename);
    const after = nextTree.get(filename);
    if (!regularBlob(before) || !regularBlob(after)) return undefined;
  }

  const previousManifestText = readBlob(repositoryRoot, previousTree.get(manifestPath)!, MANIFEST_LIMIT);
  const nextManifestText = readBlob(repositoryRoot, nextTree.get(manifestPath)!, MANIFEST_LIMIT);
  const previousAbstract = normalizedAbstract(
    readBlob(repositoryRoot, previousTree.get(abstractPath)!, ABSTRACT_LIMIT),
  );
  const nextAbstract = normalizedAbstract(
    readBlob(repositoryRoot, nextTree.get(abstractPath)!, ABSTRACT_LIMIT),
  );
  const previousManifest = checkedManifest(previousManifestText, request);
  const nextManifest = checkedManifest(nextManifestText, request);
  const published = parseCurrentBuildOutput(current, previousSource);
  if (
    JSON.stringify(published.payload.inputs.manifest) !== JSON.stringify(previousManifest) ||
    published.payload.inputs.abstract !== previousAbstract
  ) return undefined;
  if (!sameNonPresentationManifest(previousManifest, nextManifest)) return undefined;
  if (maskedManifest(previousManifestText) !== maskedManifest(nextManifestText)) return undefined;

  const fields: PresentationField[] = [];
  if (previousManifest.title !== nextManifest.title) fields.push("title");
  if (JSON.stringify(previousManifest.authors) !== JSON.stringify(nextManifest.authors)) fields.push("authors");
  if (previousAbstract !== nextAbstract) fields.push("abstract");
  if (fields.length === 0) return undefined;

  // Parse the exact record we intend the metadata publisher to construct.
  // This catches any current-schema incompatibility before an artifact can
  // claim the fast path, while the publisher repeats the same parse later.
  const candidate = {
    ...published.payload,
    inputs: { manifest: nextManifest, abstract: nextAbstract },
    capture: { ...published.payload.capture, sourceCommit: source.commit },
  };
  parsePublishedBuildOutputPayload(
    candidate,
    validationRequest(request.id, source, request.issue, request.archiveSha),
    published.runtime,
  );

  return {
    metadataVersion: 1,
    id: request.id,
    previousSource,
    source,
    previousBuildOutput: current.preconditions.buildOutput,
    fields,
    inputs: { manifest: nextManifest, abstract: nextAbstract },
  };
}

/** Parse the bounded handoff before a credentialed publisher may use it. */
export function parseMetadataResubmissionArtifact(
  value: unknown,
  request: PublishRequest,
): ParsedMetadataResubmissionArtifact {
  if (!isObject(value)) throw new ValidationError("metadata resubmission artifact must be an object");
  requireExactKeys(value, [
    "metadataVersion",
    "id",
    "previousSource",
    "source",
    "previousBuildOutput",
    "fields",
    "inputs",
  ], "metadata resubmission artifact");
  if (value.metadataVersion !== 1) {
    throw new ValidationError("metadata resubmission artifact must have version 1");
  }
  if (typeof value.id !== "string" || validateSubmissionId(value.id) !== request.id) {
    throw new ValidationError("metadata resubmission artifact id does not match the submit request");
  }
  const previousSource = validateSource(value.previousSource);
  const source = validateSource(value.source);
  if (
    previousSource.repository !== source.repository ||
    previousSource.folder !== source.folder ||
    previousSource.commit === source.commit
  ) {
    throw new ValidationError(
      "metadata resubmission artifact must compare distinct commits in one repository and folder",
    );
  }
  if (
    request.command?.action !== "submit" ||
    JSON.stringify(source) !== JSON.stringify(sourceOfSubmitCommand(request.command))
  ) {
    throw new ValidationError("metadata resubmission artifact source does not match the submit request");
  }
  if (
    typeof value.previousBuildOutput !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.previousBuildOutput) ||
    value.previousBuildOutput !== request.preconditions?.buildOutput
  ) {
    throw new ValidationError("metadata resubmission artifact does not match the routed build output");
  }
  if (!Array.isArray(value.fields) || value.fields.length === 0) {
    throw new ValidationError("metadata resubmission artifact fields must be a non-empty list");
  }
  const fields = value.fields.map((field) => {
    if (!(PRESENTATION_FIELDS as readonly unknown[]).includes(field)) {
      throw new ValidationError("metadata resubmission artifact contains a non-presentation field");
    }
    return field as PresentationField;
  });
  const sortedFields = PRESENTATION_FIELDS.filter((field) => fields.includes(field));
  if (
    fields.length !== sortedFields.length ||
    fields.some((field, index) => field !== sortedFields[index])
  ) {
    throw new ValidationError("metadata resubmission artifact fields must be unique and ordered");
  }
  if (!isObject(value.inputs)) throw new ValidationError("metadata resubmission inputs must be an object");
  requireExactKeys(value.inputs, ["manifest", "abstract"], "metadata resubmission inputs");
  if (
    typeof value.inputs.abstract !== "string" ||
    Buffer.byteLength(value.inputs.abstract, "utf8") > ABSTRACT_LIMIT ||
    value.inputs.abstract.trim() === "" ||
    value.inputs.abstract.replace(/\r\n?/gu, "\n") !== value.inputs.abstract
  ) {
    throw new ValidationError("metadata resubmission abstract is invalid");
  }
  return {
    metadataVersion: 1,
    id: request.id,
    previousSource,
    source,
    previousBuildOutput: value.previousBuildOutput,
    fields,
    inputs: { manifest: value.inputs.manifest, abstract: value.inputs.abstract },
  };
}

/** Strictly parse the current record's reusable build payload. */
export function parseCurrentBuildOutput(
  current: LoadedSubmission,
  source: SourceLocation,
): PublishedBuildOutput {
  const output = current.files.buildOutput;
  const expectedKeys = [
    "specVersion",
    "id",
    "issue",
    "inputs",
    "requiredByConcepts",
    "requiredByProofs",
    "concepts",
    "proofs",
    "capture",
    ...(output.paper === undefined ? [] : ["paper"]),
  ];
  requireExactKeys(output, expectedKeys, "published build-output.json");
  if (!isObject(output.inputs) || !isObject(output.inputs.manifest)) {
    throw new ValidationError("published build-output.json has no manifest inputs");
  }
  const environmentId = output.inputs.manifest.leanVersion;
  if (typeof environmentId !== "string") {
    throw new ValidationError("published build-output.json has no archive environment");
  }
  const selected = environmentById(environmentId);
  if (selected === undefined) {
    throw new ValidationError("published build-output.json names no admitted archive environment");
  }
  const runtime = configuredRuntime(selected);
  const payloadValue = Object.fromEntries(
    Object.entries(output).filter(([key]) => !["specVersion", "id", "issue"].includes(key)),
  );
  const payload = parsePublishedBuildOutputPayload(
    payloadValue,
    validationRequest(current.files.record.id, source, current.files.buildOutput.issue, current.snapshot.sha),
    runtime,
  );
  return { payload, runtime };
}

export function presentationChanges(
  previous: BuildOutputPayload["inputs"],
  next: { manifest: SubmissionManifest; abstract: string },
): PresentationField[] | undefined {
  if (!sameNonPresentationManifest(previous.manifest, next.manifest)) return undefined;
  const fields: PresentationField[] = [];
  if (previous.manifest.title !== next.manifest.title) fields.push("title");
  if (JSON.stringify(previous.manifest.authors) !== JSON.stringify(next.manifest.authors)) fields.push("authors");
  if (previous.abstract !== next.abstract) fields.push("abstract");
  return fields;
}

function validationRequest(
  id: string,
  source: SourceLocation,
  issue: IssueBinding,
  archiveSha: string,
): ValidationRequest {
  return { requestVersion: 1, id, source, archiveSha, issue };
}

function sourceOfSubmitCommand(
  command: Extract<NonNullable<PublishRequest["command"]>, { action: "submit" }>,
): SourceLocation {
  return validateSource({
    repository: command.repository,
    commit: command.commit,
    folder: command.folder,
  });
}

function checkedManifest(content: string, request: PublishRequest): SubmissionManifest {
  const findings = new FindingCollector("static");
  const manifest = validateManifest(
    content,
    request.id,
    configuredRuntime,
    findings,
    request.issue,
    request.legacyManifestWithoutIssue,
  );
  if (manifest === undefined || findings.failed) {
    throw new ValidationError("metadata comparison could not validate manifest.yaml");
  }
  return manifest;
}

function normalizedAbstract(content: string): string {
  const abstract = content.replace(/\r\n?/gu, "\n");
  if (abstract.trim() === "") throw new ValidationError("metadata comparison found an empty abstract.md");
  return abstract;
}

function sameNonPresentationManifest(left: SubmissionManifest, right: SubmissionManifest): boolean {
  const withoutPresentation = (manifest: SubmissionManifest): Record<string, unknown> => {
    const { title: _title, authors: _authors, ...rest } = manifest;
    return rest;
  };
  return JSON.stringify(withoutPresentation(left)) === JSON.stringify(withoutPresentation(right));
}

/**
 * Mask only the YAML value nodes for title and authors, then compare every
 * remaining byte. This is deliberately stricter than comparing parsed
 * objects: a comment, blank line, key spelling, or formatting edit anywhere
 * outside those two values sends the submission through full validation.
 */
function maskedManifest(content: string): string {
  const document = parseDocument(content, { merge: false, uniqueKeys: true });
  if (document.errors.length > 0 || !isMap(document.contents)) {
    throw new ValidationError("metadata comparison could not parse manifest.yaml exactly");
  }
  const ranges: Array<{ field: string; start: number; end: number }> = [];
  for (const pair of document.contents.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") continue;
    if (!MANIFEST_PRESENTATION_FIELDS.has(pair.key.value)) continue;
    const range = pair.value?.range;
    if (range === undefined || range.length < 2) {
      throw new ValidationError("metadata comparison could not locate a manifest field");
    }
    ranges.push({ field: pair.key.value, start: range[0], end: range[1] });
  }
  if (ranges.length !== MANIFEST_PRESENTATION_FIELDS.size) {
    throw new ValidationError("metadata comparison could not locate every allowed manifest field");
  }
  ranges.sort((left, right) => left.start - right.start);
  let result = "";
  let offset = 0;
  for (const range of ranges) {
    if (range.start < offset || range.end < range.start || range.end > content.length) {
      throw new ValidationError("metadata comparison found overlapping manifest fields");
    }
    result += `${content.slice(offset, range.start)}<lax-${range.field}>`;
    offset = range.end;
  }
  return result + content.slice(offset);
}

function readTree(repositoryRoot: string, commit: string): Map<string, GitTreeEntry> {
  const output = gitBytes(
    repositoryRoot,
    ["ls-tree", "-r", "-z", "--full-tree", commit],
    TREE_OUTPUT_LIMIT,
  );
  const text = decodeUtf8(output);
  const records = text.split("\0");
  if (records.at(-1) !== "") throw new ValidationError("Git tree output was not NUL-terminated");
  records.pop();
  if (records.length > TREE_ENTRY_LIMIT) {
    throw new ValidationError(`Git tree contains more than ${TREE_ENTRY_LIMIT} entries`);
  }
  const entries = new Map<string, GitTreeEntry>();
  for (const record of records) {
    const match = /^([0-7]{6}) (blob|commit) ([0-9a-f]{40})\t([\s\S]+)$/u.exec(record);
    if (match === null || entries.has(match[4]!)) {
      throw new ValidationError("Git tree output is malformed or contains duplicate paths");
    }
    entries.set(match[4]!, {
      mode: match[1]!,
      type: match[2]! as GitTreeEntry["type"],
      object: match[3]!,
    });
  }
  return entries;
}

function changedTreePaths(
  previous: Map<string, GitTreeEntry>,
  next: Map<string, GitTreeEntry>,
): string[] {
  const paths = [...new Set([...previous.keys(), ...next.keys()])].sort();
  return paths.filter((filename) => {
    const left = previous.get(filename);
    const right = next.get(filename);
    return left?.mode !== right?.mode || left?.type !== right?.type || left?.object !== right?.object;
  });
}

function regularBlob(entry: GitTreeEntry | undefined): entry is GitTreeEntry {
  return entry?.mode === "100644" && entry.type === "blob";
}

function readBlob(repositoryRoot: string, entry: GitTreeEntry, maxBytes: number): string {
  if (!regularBlob(entry)) throw new ValidationError("metadata file is not a regular Git blob");
  return decodeUtf8(gitBytes(repositoryRoot, ["cat-file", "blob", entry.object], maxBytes));
}

function gitBytes(repositoryRoot: string, args: string[], maxBytes: number): Uint8Array {
  if (!path.isAbsolute(repositoryRoot) || repositoryRoot === "/") {
    throw new ValidationError("Git comparison root is invalid");
  }
  try {
    return execFileSync("git", ["-C", repositoryRoot, ...args], {
      encoding: "buffer",
      maxBuffer: maxBytes,
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: path.join(path.dirname(repositoryRoot), ".lax-fetch-home"),
        GIT_ALLOW_PROTOCOL: "https",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      },
    });
  } catch (error) {
    throw new ValidationError(`Git metadata comparison failed: ${(error as Error).message}`);
  }
}
