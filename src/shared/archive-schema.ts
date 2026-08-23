import { createHash } from "node:crypto";
import { SPEC_VERSION, SUBMISSION_ID_PATTERN } from "./constants.js";
import type {
  ArchiveFiles,
  ArchiveRecord,
  BuildOutput,
  GitHubIdentity,
  IssueBinding,
  OwnerList,
  SourceLocation,
} from "./types.js";
import {
  isObject,
  requireExactKeys,
  validateFolder,
  validateIdentity,
  validateRepositoryUrl,
  validateCommit,
  validateSubmissionId,
  ValidationCollector,
  ValidationError,
} from "./validation.js";

export const ARCHIVE_FILENAMES = ["record.json", "build-output.json", "owner-list.json"] as const;
export type ArchiveFilename = (typeof ARCHIVE_FILENAMES)[number];
export type ArchiveChanges = Partial<Record<ArchiveFilename, string>>;

export function parseArchiveFiles(id: string, texts: Record<string, string>): ArchiveFiles {
  validateSubmissionId(id);
  const names = Object.keys(texts).sort();
  const expected = [...ARCHIVE_FILENAMES].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new ValidationError(`${id} must contain exactly ${ARCHIVE_FILENAMES.join(", ")}`);
  }
  const problems = new ValidationCollector();
  const record = problems.capture(() => parseRecord(parse(texts["record.json"]!, "record.json"), id));
  const buildOutput = problems.capture(() =>
    parseBuildOutput(parse(texts["build-output.json"]!, "build-output.json"), id),
  );
  const ownerList = problems.capture(() => parseOwnerList(parse(texts["owner-list.json"]!, "owner-list.json")));
  problems.throwIfAny();
  return { record: record!, buildOutput: buildOutput!, ownerList: ownerList! };
}

export function parseRecord(value: unknown, id: string): ArchiveRecord {
  if (!isObject(value)) throw new ValidationError("record.json must be an object");
  const problems = new ValidationCollector();
  const state = value.state;
  const expected =
    state === "init"
      ? ["specVersion", "id", "state", "createdAt"]
      : state === "draft"
        ? ["specVersion", "id", "state", "createdAt", "source"]
        : state === "registered"
          ? "source" in value
            ? ["specVersion", "id", "state", "createdAt", "source"]
            : ["specVersion", "id", "state", "createdAt"]
        : state === "deleted"
          ? ["specVersion", "id", "state", "createdAt", "deletedAt"]
          : undefined;
  if (expected === undefined) problems.add("record.json has an invalid state");
  else problems.capture(() => requireExactKeys(value, expected, "record.json"));
  problems.capture(() => commonIdentity(value, id, "record.json"));
  const createdAt = problems.capture(() => timestamp(value.createdAt, "record.json.createdAt"));
  if ((state === "draft" || state === "registered") && "source" in value) {
    const source = problems.capture(() => parseSource(value.source));
    problems.throwIfAny();
    return { specVersion: "1", id, state, createdAt: createdAt!, source: source! };
  }
  if (state === "deleted") {
    const deletedAt = problems.capture(() => timestamp(value.deletedAt, "record.json.deletedAt"));
    problems.throwIfAny();
    return {
      specVersion: "1",
      id,
      state,
      createdAt: createdAt!,
      deletedAt: deletedAt!,
    };
  }
  problems.throwIfAny();
  return {
    specVersion: "1",
    id,
    state: state === "registered" ? "registered" : "init",
    createdAt: createdAt!,
  };
}

export function parseBuildOutput(value: unknown, id: string): BuildOutput {
  if (!isObject(value)) throw new ValidationError("build-output.json must be an object");
  const problems = new ValidationCollector();
  problems.capture(() => commonIdentity(value, id, "build-output.json"));
  if ("state" in value || "status" in value) {
    problems.add("build-output.json must not duplicate lifecycle state or status");
  }
  const issue = problems.capture(() => parseIssueBinding(value.issue));
  problems.throwIfAny();
  return { ...value, specVersion: "1", id, issue: issue! } as BuildOutput;
}

export function parseOwnerList(value: unknown): OwnerList {
  if (!isObject(value)) throw new ValidationError("owner-list.json must be an object");
  const problems = new ValidationCollector();
  problems.capture(() => requireExactKeys(value, ["specVersion", "owners"], "owner-list.json"));
  if (value.specVersion !== SPEC_VERSION) problems.add("owner-list.json specVersion must be 1");
  if (!Array.isArray(value.owners) || value.owners.length === 0) {
    problems.add("owner-list.json owners must be a non-empty array");
    problems.throwIfAny();
  }
  const owners: GitHubIdentity[] = [];
  (value.owners as unknown[]).forEach((entry, index) => {
    if (!isObject(entry)) {
      problems.add(`owner ${index + 1} must be an object`);
      return;
    }
    problems.capture(() => requireExactKeys(entry, ["githubId", "handle"], `owner ${index + 1}`));
    const owner = problems.capture(() => validateIdentity(entry, `owner ${index + 1}`));
    if (owner !== undefined) owners.push(owner);
  });
  for (let index = 1; index < owners.length; index += 1) {
    if (owners[index - 1]!.githubId >= owners[index]!.githubId) {
      problems.add("owner-list.json owners must have unique ids sorted numerically");
      break;
    }
  }
  const handles = new Set(owners.map((owner) => owner.handle.toLowerCase()));
  if (handles.size !== owners.length) problems.add("owner-list.json has duplicate handles");
  problems.throwIfAny();
  return { specVersion: "1", owners };
}

/**
 * The successor claim `lax submit` echoed into a record's build output
 * (`inputs.manifest.supersedes`), in its canonical id form. Trusted writes
 * only ever store the normalized value, so anything else is corruption and
 * fails closed instead of silently freeing the target's successor slot.
 */
export function supersedesClaim(buildOutput: Record<string, unknown>): string | undefined {
  const inputs = buildOutput.inputs;
  if (!isObject(inputs) || !isObject(inputs.manifest)) return undefined;
  const value = inputs.manifest.supersedes;
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ValidationError("build-output.json supersedes claim must be a string");
  }
  return validateSubmissionId(value);
}

export function parseIssueBinding(value: unknown): IssueBinding {
  if (!isObject(value)) throw new ValidationError("build-output.json issue must be an object");
  const problems = new ValidationCollector();
  problems.capture(() => requireExactKeys(value, ["repositoryId", "number"], "build-output.json issue"));
  if (!Number.isSafeInteger(value.repositoryId) || (value.repositoryId as number) <= 0) {
    problems.add("issue.repositoryId must be a positive integer");
  }
  if (!Number.isSafeInteger(value.number) || (value.number as number) <= 0) {
    problems.add("issue.number must be a positive integer");
  }
  problems.throwIfAny();
  return { repositoryId: value.repositoryId as number, number: value.number as number };
}

function parseSource(value: unknown): SourceLocation {
  if (!isObject(value)) throw new ValidationError("record.json source must be an object");
  requireExactKeys(value, ["repository", "commit", "folder"], "record.json source");
  return {
    repository: validateRepositoryUrl(value.repository),
    commit: validateCommit(value.commit),
    folder: validateFolder(value.folder),
  };
}

function commonIdentity(value: Record<string, unknown>, id: string, label: string): void {
  const problems = new ValidationCollector();
  if (value.specVersion !== SPEC_VERSION) problems.add(`${label} specVersion must be 1`);
  if (value.id !== id || typeof value.id !== "string" || !SUBMISSION_ID_PATTERN.test(value.id)) {
    problems.add(`${label} id does not match ${id}`);
  }
  problems.throwIfAny();
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u.test(value)) {
    throw new ValidationError(`${label} must be a UTC timestamp without fractional seconds`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().replace(".000Z", "Z") !== value) {
    throw new ValidationError(`${label} is not a real timestamp`);
  }
  return value;
}

function parse(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ValidationError(`${label} is not valid JSON`);
  }
}

export function jsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function fileDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function fileDigests(texts: Record<string, string>): {
  record: string;
  buildOutput: string;
  ownerList: string;
} {
  return {
    record: fileDigest(texts["record.json"]!),
    buildOutput: fileDigest(texts["build-output.json"]!),
    ownerList: fileDigest(texts["owner-list.json"]!),
  };
}

export function initialFiles(
  id: string,
  issue: IssueBinding,
  actor: GitHubIdentity,
  createdAt: string,
): Record<string, string> {
  const record: ArchiveRecord = { specVersion: "1", id, state: "init", createdAt };
  const buildOutput: BuildOutput = { specVersion: "1", id, issue };
  const ownerList: OwnerList = { specVersion: "1", owners: [actor] };
  const files = {
    "record.json": jsonFile(record),
    "build-output.json": jsonFile(buildOutput),
    "owner-list.json": jsonFile(ownerList),
  };
  parseArchiveFiles(id, files);
  return files;
}

export function replaceOwnerList(
  id: string,
  current: Record<string, string>,
  owners: GitHubIdentity[],
): Record<string, string> {
  const next = { ...current, "owner-list.json": jsonFile({ specVersion: "1", owners }) };
  parseArchiveFiles(id, next);
  return next;
}

export function registeredFiles(id: string, current: Record<string, string>): Record<string, string> {
  const parsed = parseArchiveFiles(id, current);
  if (parsed.record.state !== "init" && parsed.record.state !== "draft") {
    throw new ValidationError("only an init or draft submission can be registered");
  }
  const next = {
    ...current,
    "record.json": jsonFile({ ...parsed.record, state: "registered" }),
  };
  parseArchiveFiles(id, next);
  return next;
}

export function deletedFiles(
  id: string,
  current: Record<string, string>,
  deletedAt: string,
): Record<string, string> {
  const parsed = parseArchiveFiles(id, current);
  if (parsed.record.state !== "init" && parsed.record.state !== "draft") {
    throw new ValidationError("only an init or draft submission can be deleted");
  }
  const next = {
    ...current,
    "record.json": jsonFile({
      specVersion: "1",
      id,
      state: "deleted",
      createdAt: parsed.record.createdAt,
      deletedAt,
    }),
    "build-output.json": jsonFile({ specVersion: "1", id, issue: parsed.buildOutput.issue }),
  };
  parseArchiveFiles(id, next);
  return next;
}
