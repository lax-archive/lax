import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { CONTROL_REPOSITORY_ID, HANDLE_PATTERN, MAX_OWNERS } from "../shared/constants.js";
import type { IssueBinding } from "../shared/types.js";
import {
  isObject,
  normalizeSubmissionId,
  validateNewSubmissionId,
  ValidationError,
} from "../shared/validation.js";

export interface LocalSubmissionManifest {
  filename: string;
  id: string;
  title: string;
  authors: Array<{ github?: string }>;
  issue?: IssueBinding;
  initialOwners: string[];
}

export function readLocalSubmissionManifest(folder: string): LocalSubmissionManifest {
  const root = path.resolve(folder);
  const filename = path.join(root, "manifest.yaml");
  const document = readDocument(filename);
  const value = document.toJS({ maxAliasCount: 0 }) as unknown;
  if (!isObject(value)) throw new Error(`${filename} must be a YAML mapping`);
  if (typeof value.id !== "string") {
    throw new Error(`${filename} must contain an id of the form lax-N or LaxN`);
  }
  let id: string;
  try {
    id = normalizeSubmissionId(value.id);
  } catch {
    throw new Error(`${filename} must contain an id of the form lax-N or LaxN`);
  }
  if (typeof value.title !== "string" || value.title.trim() === "") {
    throw new Error(`${filename} must contain a non-empty title`);
  }
  const authors = Array.isArray(value.authors)
    ? value.authors.flatMap((author) =>
        isObject(author) && (author.github === undefined || typeof author.github === "string")
          ? [{ ...(typeof author.github === "string" ? { github: author.github } : {}) }]
          : [],
      )
    : [];
  const initialOwners = parseInitialOwners(value.initialOwners, filename);
  const issue = value.issue === undefined ? undefined : parseManifestIssue(value.issue, filename);
  return { filename, id, title: value.title, authors, issue, initialOwners };
}

/** Resolve the authoritative issue number recorded after the first update. */
export function issueNumberFromFolder(folder: string): number {
  const manifest = readLocalSubmissionManifest(folder);
  if (manifest.issue === undefined) {
    throw new Error(`${manifest.filename} has no issue binding; run \`lax update\` for this folder first`);
  }
  return manifest.issue.number;
}

export function submissionIdFromFolder(folder: string): string {
  const filename = path.join(path.resolve(folder), "manifest.yaml");
  const value = readDocument(filename).toJS({ maxAliasCount: 0 }) as unknown;
  if (!isObject(value) || typeof value.id !== "string") {
    throw new Error(`${filename} must contain an id of the form lax-N or LaxN`);
  }
  try {
    return normalizeSubmissionId(value.id);
  } catch {
    throw new Error(`${filename} must contain an id of the form lax-N or LaxN`);
  }
}

export function setManifestIssue(folder: string, issue: IssueBinding): void {
  if (
    issue.repositoryId !== CONTROL_REPOSITORY_ID ||
    !Number.isSafeInteger(issue.number) ||
    issue.number <= 0
  ) {
    throw new ValidationError("manifest issue binding is invalid");
  }
  updateDocument(folder, (document) => {
    document.set("issue", { repositoryId: issue.repositoryId, number: issue.number });
  });
}

export function clearManifestIssue(folder: string): void {
  updateDocument(folder, (document) => document.delete("issue"));
}

export function setInitialOwners(folder: string, handles: string[]): void {
  const byLowercase = new Map(handles.map((handle) => [handle.toLowerCase(), handle]));
  const normalized = [...byLowercase.values()].sort((left, right) =>
    left.localeCompare(right, "en", { sensitivity: "base" }),
  );
  if (normalized.length > MAX_OWNERS) {
    throw new Error(`initial owner list may contain at most ${MAX_OWNERS} GitHub users`);
  }
  for (const handle of normalized) {
    if (!HANDLE_PATTERN.test(handle)) throw new Error(`invalid GitHub handle: ${handle}`);
  }
  updateDocument(folder, (document) => document.set("initialOwners", normalized));
}

export function clearInitialOwners(folder: string): void {
  updateDocument(folder, (document) => document.delete("initialOwners"));
}

export function setManifestId(folder: string, id: string): void {
  validateNewSubmissionId(id);
  updateDocument(folder, (document) => {
    document.set("id", id);
    document.delete("issue");
  });
}

function parseManifestIssue(value: unknown, filename: string): IssueBinding {
  if (
    !isObject(value) ||
    Object.keys(value).sort().join(",") !== "number,repositoryId" ||
    value.repositoryId !== CONTROL_REPOSITORY_ID ||
    !Number.isSafeInteger(value.number) ||
    (value.number as number) <= 0
  ) {
    throw new Error(`${filename} issue must contain the authoritative repositoryId and a positive number`);
  }
  return { repositoryId: value.repositoryId as number, number: value.number as number };
}

function parseInitialOwners(value: unknown, filename: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_OWNERS) {
    throw new Error(`${filename} initialOwners must be a list of at most ${MAX_OWNERS} GitHub handles`);
  }
  const handles = value.map((entry) => {
    if (typeof entry !== "string" || !HANDLE_PATTERN.test(entry)) {
      throw new Error(`${filename} initialOwners contains an invalid GitHub handle`);
    }
    return entry;
  });
  if (new Set(handles.map((handle) => handle.toLowerCase())).size !== handles.length) {
    throw new Error(`${filename} initialOwners contains duplicate GitHub handles`);
  }
  return handles;
}

function updateDocument(folder: string, mutate: (document: ReturnType<typeof parseDocument>) => void): void {
  const filename = path.join(path.resolve(folder), "manifest.yaml");
  const document = readDocument(filename);
  mutate(document);
  const temporary = `${filename}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, document.toString(), { flag: "wx" });
    fs.renameSync(temporary, filename);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readDocument(filename: string): ReturnType<typeof parseDocument> {
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(fs.readFileSync(filename, "utf8"), {
      merge: false,
      uniqueKeys: true,
    });
  } catch (error) {
    throw new Error(`could not read ${filename}: ${(error as Error).message}`);
  }
  if (document.errors.length > 0) {
    throw new Error(`could not read ${filename}: ${document.errors.map((error) => error.message).join("; ")}`);
  }
  return document;
}
