import fs from "node:fs";
import path from "node:path";
import { parse, parseDocument } from "yaml";
import {
  CONTROL_REPOSITORY_ID,
  HANDLE_PATTERN,
  LEGACY_SUBMISSION_IDS,
  MAX_OWNERS,
  PLACEHOLDER_SUBMISSION_ID,
} from "../shared/constants.js";
import {
  environment as environmentById,
  epoch,
  type ArchiveEnvironment,
} from "../submission-validation/environments.js";
import type { IssueBinding } from "../shared/types.js";
import {
  isObject,
  normalizeSubmissionId,
  validateNewSubmissionId,
  ValidationError,
} from "../shared/validation.js";
import * as ui from "./ui.js";

export interface LocalSubmissionManifest {
  filename: string;
  id: string;
  /** The archive environment the submission declares, unvalidated: static
   * validation is where an unknown one becomes a violation. */
  leanVersion?: string;
  title?: string;
  authors: Array<{ github?: string }>;
  issue?: IssueBinding;
  initialOwners: string[];
}

/** Read the local fields the CLI needs before the full validation pipeline runs. */
export function readLocalSubmissionManifest(folder: string): LocalSubmissionManifest {
  const filename = path.join(path.resolve(folder), "manifest.yaml");
  const document = readDocument(filename);
  const value = document.toJS({ maxAliasCount: 0 }) as unknown;
  if (!isObject(value)) throw new Error(`${filename} must be a YAML mapping`);
  if (typeof value.id !== "string") {
    throw new Error(`${filename} must contain an id of the form lax-N or LaxN`);
  }
  let id: string;
  try {
    // Keep the last released offline placeholder readable so first submission
    // can rekey it instead of stranding the folder.
    id = normalizeSubmissionId(value.id, { placeholder: true });
  } catch {
    throw new Error(`${filename} must contain an id of the form lax-N or LaxN`);
  }
  const leanVersion = typeof value.leanVersion === "string" ? value.leanVersion : undefined;
  const title =
    typeof value.title === "string" && value.title.trim() !== "" ? value.title : undefined;
  const authors = Array.isArray(value.authors)
    ? value.authors.flatMap((author) =>
        isObject(author) && (author.github === undefined || typeof author.github === "string")
          ? [{ ...(typeof author.github === "string" ? { github: author.github } : {}) }]
          : [],
      )
    : [];
  const initialOwners = parseInitialOwners(value.initialOwners, filename);
  const issue = value.issue === undefined ? undefined : parseManifestIssue(value.issue, filename);
  return {
    filename,
    id,
    ...(leanVersion === undefined ? {} : { leanVersion }),
    ...(title === undefined ? {} : { title }),
    authors,
    issue,
    initialOwners,
  };
}

/**
 * The archive environment a local submission folder is in. The manifest's
 * `leanVersion` is the id and the table is the only thing that turns it into
 * an entry; an unreadable folder or an id this CLI does not admit falls back
 * to the epoch, because saying which environment is missing is static
 * validation's job and it says it properly.
 */
export function submissionEnvironment(folder: string): ArchiveEnvironment {
  try {
    return environmentById(readLocalSubmissionManifest(folder).leanVersion ?? "") ?? epoch();
  } catch {
    return epoch();
  }
}

/** The id a local submission folder carries, including the historical lax-0 placeholder. */
export function submissionIdFromFolder(folder: string): string {
  return readLocalSubmissionManifest(folder).id;
}

/** Resolve the authoritative issue number recorded after first submission. */
export function issueNumberFromFolder(folder: string): number {
  const manifest = readLocalSubmissionManifest(folder);
  if (manifest.issue !== undefined) return manifest.issue.number;
  if (LEGACY_SUBMISSION_IDS.has(manifest.id)) {
    return Number(manifest.id.slice("lax-".length));
  }
  if (manifest.id === PLACEHOLDER_SUBMISSION_ID) {
    throw new Error(
      `${ui.tilde(path.resolve(folder))} carries the old placeholder id ${PLACEHOLDER_SUBMISSION_ID}.\n` +
        `Run ${ui.cmd("lax submit")} for this folder; it will assign a real local id before creating an issue.`,
    );
  }
  throw new Error(
    `${manifest.filename} has no issue binding; run ${ui.cmd("lax submit")} for this folder first`,
  );
}

/** Whether a raw manifest declares a paper, for composing the CLI's rows. */
export function declaresPaper(folder: string): boolean {
  try {
    const value = parse(fs.readFileSync(path.join(path.resolve(folder), "manifest.yaml"), "utf8"), {
      maxAliasCount: 0,
      merge: false,
      uniqueKeys: true,
    }) as unknown;
    return isObject(value) && value.paper !== undefined;
  } catch {
    return false;
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
    throw new Error(
      `${filename} issue must contain the authoritative repositoryId and a positive number`,
    );
  }
  return { repositoryId: value.repositoryId as number, number: value.number as number };
}

function parseInitialOwners(value: unknown, filename: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_OWNERS) {
    throw new Error(
      `${filename} initialOwners must be a list of at most ${MAX_OWNERS} GitHub handles`,
    );
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

function updateDocument(
  folder: string,
  mutate: (document: ReturnType<typeof parseDocument>) => void,
): void {
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
    throw new Error(
      `could not read ${filename}: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }
  return document;
}
