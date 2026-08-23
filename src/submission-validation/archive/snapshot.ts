import fs from "node:fs";
import path from "node:path";
import { supersedesClaim } from "../../shared/archive-schema.js";
import { DATABASE_REPOSITORY } from "../../shared/constants.js";
import { fetchGitCheckout } from "../source/fetch.js";
import type { ValidationLimits } from "../config.js";
import { parseCaptureBlobReference, type ArchiveSourceRecord, type PublishedCapture } from "../contracts.js";
import { isObject, validateCommit, validateFolder, validateRepositoryUrl } from "../../shared/validation.js";

const MAX_ARCHIVE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CAPTURE_FILES = 100_000;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024 * 1024;

export class ArchiveSnapshot {
  private readonly records = new Map<string, ArchiveSourceRecord>();

  constructor(readonly root: string, readonly sha: string) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^lax-[1-9][0-9]*$/u.test(entry.name)) continue;
      this.records.set(entry.name, loadRecordDirectory(root, entry.name));
    }
  }

  get(id: string): ArchiveSourceRecord | undefined {
    return this.records.get(id);
  }

  /** Every record at this snapshot, for whole-archive scans. */
  all(): ArchiveSourceRecord[] {
    return [...this.records.values()];
  }

  /** The successor claim a record's build output carries; undefined when the
   * copy holds none or holds one this reader cannot make sense of — the
   * trusted publisher stays the authority either way. */
  supersedes(record: ArchiveSourceRecord): string | undefined {
    try {
      return supersedesClaim(record.buildOutput ?? {});
    } catch {
      return undefined;
    }
  }

  packageNames(record: ArchiveSourceRecord): { concepts: string[]; proofs: string[] } {
    const output = record.buildOutput;
    return {
      concepts: stringList(output?.requiredByConcepts),
      proofs: stringList(output?.requiredByProofs),
    };
  }

  statements(record: ArchiveSourceRecord): string[] {
    const concepts = Array.isArray(record.buildOutput?.concepts) ? record.buildOutput.concepts : [];
    const statements: string[] = [];
    for (const concept of concepts) {
      if (!isObject(concept) || !Array.isArray(concept.statements)) continue;
      for (const statement of concept.statements) {
        if (isObject(statement) && typeof statement.id === "string") statements.push(statement.id);
      }
    }
    return [...new Set(statements)].sort();
  }

  capture(record: ArchiveSourceRecord): PublishedCapture | undefined {
    const value = record.buildOutput?.capture;
    if (!isObject(value) || typeof value.registryBlob !== "string") return undefined;
    if (
      value.formatVersion !== 1 ||
      typeof value.digest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(value.digest) ||
      typeof value.sourceCommit !== "string" ||
      typeof value.leanToolchain !== "string" ||
      typeof value.mathlibCommit !== "string" ||
      !Array.isArray(value.files)
    ) return undefined;
    const files = value.files.flatMap((file) =>
      isObject(file) &&
      typeof file.path === "string" &&
      safeCapturePath(file.path) &&
      typeof file.bytes === "number" &&
      Number.isSafeInteger(file.bytes) &&
      file.bytes >= 0 &&
      typeof file.sha256 === "string" &&
      /^[0-9a-f]{64}$/u.test(file.sha256)
        ? [{ path: file.path, bytes: file.bytes, sha256: file.sha256 }]
        : [],
    );
    if (
      files.length !== value.files.length ||
      files.length > MAX_CAPTURE_FILES ||
      new Set(files.map((file) => file.path)).size !== files.length
    )
      return undefined;
    const totalBytes = files.reduce((total, file) => total + file.bytes, 0);
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_CAPTURE_BYTES) return undefined;
    // Fail closed: consumers fetch captures only through a ghcr digest
    // address whose digest equals the record's own capture digest. A tag or
    // foreign reference can never enter the resolved dependency set.
    const reference = parseCaptureBlobReference(value.registryBlob);
    if (reference === undefined || reference.digest !== value.digest) return undefined;
    return {
      formatVersion: 1,
      digest: value.digest,
      sourceCommit: value.sourceCommit,
      leanToolchain: value.leanToolchain,
      mathlibCommit: value.mathlibCommit,
      files,
      registryBlob: value.registryBlob,
    };
  }
}

/** Fetch the pinned lax-database snapshot — a trusted host-side step with the
 * same hardened git environment as source fetching (source/fetch.ts). */
export async function fetchArchiveSnapshot(
  archiveSha: string,
  jobDir: string,
  limits: ValidationLimits,
): Promise<ArchiveSnapshot> {
  const root = path.join(jobDir, "archive");
  const repository = `https://github.com/${DATABASE_REPOSITORY}`;
  try {
    await fetchGitCheckout(repository, archiveSha, root, limits.fetchTimeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`could not fetch pinned lax-database snapshot: ${message}`);
  }
  return new ArchiveSnapshot(fs.realpathSync(root), archiveSha);
}

function loadRecordDirectory(root: string, id: string): ArchiveSourceRecord {
  const record = readJson(path.join(root, id, "record.json"));
  const buildOutput = readJson(path.join(root, id, "build-output.json"));
  if (!isObject(record) || record.id !== id || record.specVersion !== "1")
    throw new Error(`${id}/record.json is malformed`);
  if (!["init", "draft", "registered", "deleted"].includes(String(record.state)))
    throw new Error(`${id}/record.json has an invalid state`);
  let source;
  if (record.state === "draft" || record.state === "registered") {
    if (!isObject(record.source)) throw new Error(`${id}/record.json has no source triple`);
    if (
      typeof record.source.repository !== "string" ||
      typeof record.source.commit !== "string" ||
      typeof record.source.folder !== "string"
    ) throw new Error(`${id}/record.json source triple is malformed`);
    source = {
      repository: validateRepositoryUrl(record.source.repository),
      commit: validateCommit(record.source.commit),
      folder: validateFolder(record.source.folder),
    };
  }
  if (!isObject(buildOutput) || buildOutput.id !== id || buildOutput.specVersion !== "1")
    throw new Error(`${id}/build-output.json is malformed`);
  return {
    id,
    state: record.state as ArchiveSourceRecord["state"],
    ...(source === undefined ? {} : { source }),
    buildOutput,
    owners: readOwners(root, id),
  };
}

/**
 * Owner ids for the supersedes ownership check, which degrades to a warning
 * without them. Read leniently: a partial or hand-built copy without owner
 * lists must not fail unrelated dependency resolution, and the trusted
 * publisher repeats the check against the real database regardless.
 */
function readOwners(root: string, id: string): number[] {
  try {
    const value = readJson(path.join(root, id, "owner-list.json"));
    if (!isObject(value) || !Array.isArray(value.owners)) return [];
    return value.owners.flatMap((owner) =>
      isObject(owner) &&
      typeof owner.githubId === "number" &&
      Number.isSafeInteger(owner.githubId) &&
      owner.githubId > 0
        ? [owner.githubId]
        : [],
    );
  } catch {
    return [];
  }
}

function safeCapturePath(value: string): boolean {
  if (value === "" || value.includes("\\") || path.posix.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== ".." && !normalized.startsWith("../");
}

function readJson(filename: string): unknown {
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size > MAX_ARCHIVE_FILE_BYTES) throw new Error(`${filename} is not a bounded regular file`);
  return JSON.parse(fs.readFileSync(filename, "utf8")) as unknown;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...new Set(value)].sort()
    : [];
}
