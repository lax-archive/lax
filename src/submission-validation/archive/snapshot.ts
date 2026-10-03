import fs from "node:fs";
import path from "node:path";
import { supersedesClaim } from "../../shared/archive-schema.js";
import { DATABASE_REPOSITORY } from "../../shared/constants.js";
import { fetchGitCheckout } from "../source/fetch.js";
import type { ValidationLimits } from "../config.js";
import {
  parseCaptureBlobReference,
  type ArchiveSourceRecord,
  type PublishedCapture,
  type ValidationRuntimeIdentity,
} from "../contracts.js";
import { environment as environmentById, environmentOfPins, type ArchiveEnvironment } from "../environments.js";
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

  /** The concept and proof ids a record's build output offers cards for —
   * what a dependent's paper may mark. Read leniently, like `statements`. */
  cardIds(record: ArchiveSourceRecord): { concepts: string[]; proofs: string[] } {
    const ids = (value: unknown): string[] => {
      const entries = Array.isArray(value) ? value : [];
      const result: string[] = [];
      for (const entry of entries) {
        if (isObject(entry) && typeof entry.id === "string") result.push(entry.id);
      }
      return [...new Set(result)].sort();
    };
    return {
      concepts: ids(record.buildOutput?.concepts),
      proofs: ids(record.buildOutput?.proofs),
    };
  }

  /**
   * The environment a record was built in: by its capture's pins when the
   * record stores them (spec 1), else by the row its manifest names (spec 2,
   * recorded-shape.ts). Undefined when neither names an admitted
   * environment — a record this CLI is too old to know.
   */
  environmentOf(record: ArchiveSourceRecord): ArchiveEnvironment | undefined {
    const capture = this.capture(record);
    if (capture?.leanToolchain !== undefined && capture.mathlibCommit !== undefined)
      return environmentOfPins(capture.leanToolchain, capture.mathlibCommit);
    const id = this.environmentIdOf(record);
    return id === undefined ? undefined : environmentById(id);
  }

  /** The environment id a record's manifest names (`inputs.manifest.leanVersion`). */
  environmentIdOf(record: ArchiveSourceRecord): string | undefined {
    const inputs = record.buildOutput?.inputs;
    const manifest = isObject(inputs) && isObject(inputs.manifest) ? inputs.manifest : undefined;
    return typeof manifest?.leanVersion === "string" ? manifest.leanVersion : undefined;
  }

  /**
   * Whether a record was built in the run's environment — the island rule
   * (phases/resolution.ts): by the capture's pins against the runtime's
   * when the record stores them (spec 1), else by the row its manifest
   * names against the runtime's environment (spec 2).
   */
  inEnvironment(record: ArchiveSourceRecord, runtime: ValidationRuntimeIdentity): boolean {
    const capture = this.capture(record);
    if (capture === undefined) return false;
    if (capture.leanToolchain !== undefined || capture.mathlibCommit !== undefined)
      return capture.leanToolchain === runtime.leanToolchain && capture.mathlibCommit === runtime.mathlibCommit;
    return this.environmentIdOf(record) === runtime.environment;
  }

  capture(record: ArchiveSourceRecord): PublishedCapture | undefined {
    const value = record.buildOutput?.capture;
    if (!isObject(value) || typeof value.registryBlob !== "string") return undefined;
    // the pins are stored by a spec-1 record and absent from a spec-2 one;
    // present, they must both be there and be strings
    const storesPins = value.leanToolchain !== undefined || value.mathlibCommit !== undefined;
    if (
      value.formatVersion !== 1 ||
      typeof value.digest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(value.digest) ||
      typeof value.sourceCommit !== "string" ||
      (storesPins && (typeof value.leanToolchain !== "string" || typeof value.mathlibCommit !== "string"))
    ) return undefined;
    // a spec-2 record stores the tar's size, its member count, and the
    // `references` layer instead of the per-file inventory (recorded-shape.ts)
    if (!Array.isArray(value.files)) {
      const references = value.references;
      if (
        !Number.isSafeInteger(value.bytes) || (value.bytes as number) <= 0 || (value.bytes as number) > MAX_CAPTURE_BYTES ||
        !Number.isSafeInteger(value.fileCount) || (value.fileCount as number) <= 0 || (value.fileCount as number) > MAX_CAPTURE_FILES ||
        !isObject(references) ||
        typeof references.digest !== "string" || !/^[0-9a-f]{64}$/u.test(references.digest) ||
        !Number.isSafeInteger(references.bytes) || (references.bytes as number) <= 0 ||
        typeof references.registryBlob !== "string"
      ) return undefined;
      const reference = parseCaptureBlobReference(value.registryBlob);
      if (reference === undefined || reference.digest !== value.digest) return undefined;
      const referencesAddress = parseCaptureBlobReference(references.registryBlob);
      if (referencesAddress === undefined || referencesAddress.digest !== references.digest) return undefined;
      return {
        formatVersion: 1,
        digest: value.digest,
        sourceCommit: value.sourceCommit,
        ...(storesPins
          ? { leanToolchain: value.leanToolchain as string, mathlibCommit: value.mathlibCommit as string }
          : {}),
        bytes: value.bytes as number,
        fileCount: value.fileCount as number,
        references: { digest: references.digest, bytes: references.bytes as number, registryBlob: references.registryBlob },
        registryBlob: value.registryBlob,
      };
    }
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
      ...(storesPins
        ? { leanToolchain: value.leanToolchain as string, mathlibCommit: value.mathlibCommit as string }
        : {}),
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
  const createdAt = archiveTimestamp(record.createdAt, `${id}/record.json createdAt`);
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
    createdAt,
    ...(source === undefined ? {} : { source }),
    buildOutput,
    owners: readOwners(root, id),
  };
}

/** The Archive schema's canonical timestamp shape, repeated here because the
 * read-only validation snapshot intentionally parses only the fields it uses. */
function archiveTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u.test(value)) {
    throw new Error(`${label} is not a UTC timestamp without fractional seconds`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().replace(".000Z", "Z") !== value) {
    throw new Error(`${label} is not a real timestamp`);
  }
  return value;
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
