import { TextDecoder } from "node:util";
import {
  COMMIT_PATTERN,
  HANDLE_PATTERN,
  LEGACY_SUBMISSION_ID_PATTERN,
  MAX_FOLDER_BYTES,
  MAX_FOLDER_SEGMENTS,
  SUBMISSION_ID_PATTERN,
} from "./constants.js";
import type { GitHubIdentity, SourceLocation } from "./types.js";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Collect independent validation failures, then reject once before any mutation. */
export class ValidationCollector {
  private readonly messages: string[] = [];

  add(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    for (const line of message.split("\n")) {
      const normalized = line.replace(/^-\s*/u, "").trim();
      if (normalized !== "" && !this.messages.includes(normalized)) this.messages.push(normalized);
    }
  }

  capture<T>(operation: () => T): T | undefined {
    try {
      return operation();
    } catch (error) {
      this.add(error);
      return undefined;
    }
  }

  async captureAsync<T>(operation: () => Promise<T>): Promise<T | undefined> {
    try {
      return await operation();
    } catch (error) {
      this.add(error);
      return undefined;
    }
  }

  throwIfAny(): void {
    if (this.messages.length > 0) throw new ValidationError(this.messages.join("\n- "));
  }
}

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ValidationError("input is not valid UTF-8");
  }
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Normalize a submission title exactly once before validating its limits. */
export function normalizeTitle(raw: string): string {
  const problems = new ValidationCollector();
  if (utf8Bytes(raw) > 512) problems.add("title exceeds 512 UTF-8 bytes");
  if (hasUnpairedSurrogate(raw)) problems.add("title contains an unpaired surrogate");
  if (/\r|\n|\u2028|\u2029/u.test(raw)) problems.add("title must be one line");
  for (const char of [...raw]) {
    if (!/^[\p{L}\p{M}\p{N}\p{Zs}\p{P}\p{S}]$/u.test(char)) {
      problems.add("title contains a control or formatting character");
      break;
    }
  }
  const title = raw.normalize("NFC").trim().replace(/\p{Zs}+/gu, " ");
  const scalars = [...title];
  if (scalars.length === 0) problems.add("title must not be empty");
  if (scalars.length > 200) problems.add("title exceeds 200 Unicode characters");
  if (utf8Bytes(title) > 512) problems.add("normalized title exceeds 512 UTF-8 bytes");
  problems.throwIfAny();
  return title;
}

export function validateSubmissionId(value: string): string {
  if (!SUBMISSION_ID_PATTERN.test(value)) {
    throw new ValidationError(`submission id must match lax-<positive decimal>, got ${value}`);
  }
  return value;
}

/** Accept a source-facing legacy LaxN id and return the canonical lax-N spelling. */
export function normalizeSubmissionId(value: string): string {
  if (SUBMISSION_ID_PATTERN.test(value)) return value;
  const legacy = LEGACY_SUBMISSION_ID_PATTERN.exec(value);
  if (legacy !== null) return `lax-${legacy[1]}`;
  throw new ValidationError(
    `submission id must match lax-<positive decimal> or Lax<positive decimal>, got ${value}`,
  );
}

export function submissionId(issueNumber: number): string {
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    throw new ValidationError("issue number must be a positive integer");
  }
  return `lax-${issueNumber}`;
}

export function validateIdentity(value: unknown, label = "GitHub identity"): GitHubIdentity {
  if (!isObject(value)) throw new ValidationError(`${label} is missing`);
  const githubId = value.githubId;
  const handle = value.handle;
  const problems = new ValidationCollector();
  if (!Number.isSafeInteger(githubId) || (githubId as number) <= 0) {
    problems.add(`${label} has an invalid numeric account id`);
  }
  if (typeof handle !== "string" || !HANDLE_PATTERN.test(handle)) {
    problems.add(`${label} has an invalid handle`);
  }
  problems.throwIfAny();
  return { githubId: githubId as number, handle: handle as string };
}

export function validateRepositoryUrl(raw: unknown): string {
  if (typeof raw !== "string") throw new ValidationError("repository must be an HTTPS GitHub URL");
  const problems = new ValidationCollector();
  if (utf8Bytes(raw) > 2_048)
    problems.add("repository must be an HTTPS GitHub URL of at most 2,048 bytes");
  if (/\p{Cc}/u.test(raw)) problems.add("repository URL contains a control character");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.add("repository is not a valid URL");
    problems.throwIfAny();
    throw new Error("unreachable URL validation state");
  }
  if (
    !raw.startsWith("https://github.com/") ||
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.port !== ""
  ) {
    problems.add("repository must be a canonical public HTTPS GitHub URL");
  }
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(url.pathname);
  if (match === null || match[2]!.endsWith(".git")) {
    problems.add("repository must have the form https://github.com/owner/repository");
  }
  problems.throwIfAny();
  if (match === null) throw new Error("unreachable repository path validation state");
  return `https://github.com/${match![1]}/${match![2]}`;
}

export function validateCommit(raw: unknown): string {
  if (typeof raw !== "string" || !COMMIT_PATTERN.test(raw)) {
    throw new ValidationError("commit must be a full lowercase 40-character SHA");
  }
  return raw;
}

export function validateFolder(raw: unknown): string {
  if (typeof raw !== "string") throw new ValidationError("folder must be a string");
  const problems = new ValidationCollector();
  if (utf8Bytes(raw) > MAX_FOLDER_BYTES)
    problems.add(`folder must be at most ${MAX_FOLDER_BYTES} UTF-8 bytes`);
  if (raw === ".") {
    problems.throwIfAny();
    return raw;
  }
  if (raw === "" || raw.startsWith("/") || raw.includes("\\") || raw.includes("\0")) {
    problems.add("folder must be a relative POSIX path");
  }
  const segments = raw.split("/");
  if (
    segments.length > MAX_FOLDER_SEGMENTS ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    problems.add(`folder must contain 1-${MAX_FOLDER_SEGMENTS} non-empty segments without . or ..`);
  }
  if (segments.some((segment) => /[\u0000-\u001f\u007f]/u.test(segment))) {
    problems.add("folder contains a control character");
  }
  problems.throwIfAny();
  return segments.join("/");
}

export function validateSource(value: unknown): SourceLocation {
  if (!isObject(value)) throw new ValidationError("submit argument must be a JSON object");
  const problems = new ValidationCollector();
  problems.capture(() => requireExactKeys(value, ["repository", "commit", "folder"], "submit argument"));
  const repository = problems.capture(() => validateRepositoryUrl(value.repository));
  const commit = problems.capture(() => validateCommit(value.commit));
  const folder = problems.capture(() => validateFolder(value.folder));
  problems.throwIfAny();
  return {
    repository: repository!,
    commit: commit!,
    folder: folder!,
  };
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function requireExactKeys(
  value: Record<string, unknown>,
  expected: string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new ValidationError(`${label} must contain exactly: ${expected.join(", ")}`);
  }
}

export function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ValidationError(`${label} is not valid JSON`);
  }
}
