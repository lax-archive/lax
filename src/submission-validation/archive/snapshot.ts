import fs from "node:fs";
import path from "node:path";
import { DATABASE_REPOSITORY } from "../../shared/constants.js";
import type { ContainerRunner } from "../sandbox/container.js";
import type { ValidationLimits } from "../config.js";
import type { ArchiveSourceRecord, PublishedCapture } from "../contracts.js";
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
    if (!isObject(value) || typeof value.downloadUrl !== "string") return undefined;
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
    let downloadUrl: URL;
    try {
      downloadUrl = new URL(value.downloadUrl);
    } catch {
      return undefined;
    }
    if (
      downloadUrl.protocol !== "https:" ||
      downloadUrl.username !== "" ||
      downloadUrl.password !== "" ||
      !["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"].includes(downloadUrl.hostname)
    ) return undefined;
    return {
      formatVersion: 1,
      digest: value.digest,
      sourceCommit: value.sourceCommit,
      leanToolchain: value.leanToolchain,
      mathlibCommit: value.mathlibCommit,
      files,
      downloadUrl: downloadUrl.toString(),
    };
  }
}

export async function fetchArchiveSnapshot(
  archiveSha: string,
  jobDir: string,
  runner: ContainerRunner,
  limits: ValidationLimits,
): Promise<ArchiveSnapshot> {
  const root = path.join(jobDir, "archive");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const repository = `https://github.com/${DATABASE_REPOSITORY}`;
  const result = await runner.run({
    label: "fetch-archive",
    args: ["node", "/opt/lax-runtime/bin/fetch-source.mjs", repository, archiveSha, "/job/archive"],
    mounts: [{ source: jobDir, target: "/job", writable: true }],
    network: true,
    timeoutMs: limits.fetchTimeoutMs,
    maxOutputBytes: limits.maxOutputBytes,
  });
  if (result.code !== 0) throw new Error(`could not fetch pinned lax-database snapshot: ${result.output.trim()}`);
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
  };
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
