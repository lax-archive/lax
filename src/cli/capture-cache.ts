// The verified capture cache on a reader's machine: a record's published
// capture — the digest-addressed tar the trusted pipeline sealed from the
// record's packages, sources and build products — pulled anonymously from
// the registry, held to the recorded digest, extracted with every member a
// regular file or directory inside the tree, and held on every reuse to an
// inventory written from the verified tar. `lax generate-prooftree` reads the
// captured lib trees; `lax certify --run` copies the captured *sources* out
// and builds them (cli/certify-run.ts), never the build products.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PublishedCapture } from "../submission-validation/contracts.js";
import { isObject } from "../shared/validation.js";
import { laxHome } from "./auth.js";

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024 * 1024;

/** Test seam (never set in production): LAX_CAPTURE_REGISTRY_URL points the
 * pull at a local fake registry (test/fake-ghcr.ts), read per call as
 * cli/papers-cache.ts reads it; unset means the real ghcr origin. */
function registryOrigin(): string {
  const value = process.env.LAX_CAPTURE_REGISTRY_URL;
  return value === undefined ? "https://ghcr.io" : new URL(value).origin;
}

/**
 * The cache an older CLI kept under `~/.lax/prooftree-captures`, in the
 * same `<id>/<digest>` layout: moved into place when there is no cache yet
 * (each tree is held to its inventory on reuse, like any other), removed
 * when there is — a capture can be up to 2 GiB, and nothing else reads it.
 */
function migrateLegacyCaptures(): void {
  const legacy = path.join(laxHome(), "prooftree-captures");
  if (!fs.existsSync(legacy)) return;
  const target = path.join(laxHome(), "captures");
  if (fs.existsSync(target)) fs.rmSync(legacy, { recursive: true, force: true });
  else fs.renameSync(legacy, target);
}

/**
 * The verified tree of a record's capture, downloaded on a miss: under
 * `~/.lax/captures/<id>/<digest>`, written only by this module and never
 * mounted into any sandbox — a consumer that builds from it copies out of it
 * (`lax certify --run`) or reads its lib trees (`lax generate-prooftree`).
 * A cached tree is held to its inventory on every reuse, and one that
 * fails is refused. `announce` is called once before a download.
 */
export async function materializeCapture(id: string, capture: PublishedCapture, announce: () => void = () => undefined): Promise<string> {
  if (capture.registryBlob === undefined) throw new Error(`${id}'s capture names no registry blob`);
  migrateLegacyCaptures();
  const parent = path.join(laxHome(), "captures", id);
  const target = path.join(parent, capture.digest);
  const inventoryPath = captureInventoryPath(target);
  if (fs.existsSync(target)) {
    // Reuse verifies content, not just shape (codex review 2026-10-03,
    // finding 3): a spec-1 record declares its files; a spec-2 record
    // declares a count, so the inventory this CLI wrote from the verified
    // tar at download is what the cached tree is held to. A cache without
    // one (an older CLI's) is thrown away and downloaded again.
    const expected = capture.files !== undefined
      ? declaredInventory(capture)
      : readCaptureInventory(inventoryPath);
    if (expected !== undefined) {
      verifyCapture(target, capture, expected);
      return target;
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(parent, `${capture.digest}.tmp-`));
  const archive = path.join(staging, "capture.tar");
  const extracted = path.join(staging, "content");
  try {
    announce();
    await downloadRegistryBlob(capture.registryBlob, archive);
    if (sha256File(archive) !== capture.digest) throw new Error(`${id} capture archive digest mismatch`);
    extractCapture(archive, extracted);
    verifyCapture(extracted, capture, capture.files === undefined ? undefined : declaredInventory(capture));
    // the per-file inventory of what the digest-verified tar held, written
    // before the tree is put in place so a tree without one never exists
    if (capture.files === undefined) writeCaptureInventory(inventoryPath, captureInventory(extracted));
    fs.renameSync(extracted, target);
    return target;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** One cached file as an inventory records it. */
export interface CachedFile {
  bytes: number;
  sha256: string;
}

function declaredInventory(capture: PublishedCapture): Map<string, CachedFile> {
  return new Map((capture.files ?? []).map((file) => [file.path, { bytes: file.bytes, sha256: file.sha256 }]));
}

/** The sidecar beside a cached capture tree: `<tree>.files.json`. */
export function captureInventoryPath(target: string): string {
  return `${target}.files.json`;
}

/** The per-file digests of an extracted tree, by capture-relative path. */
export function captureInventory(root: string): Map<string, CachedFile> {
  const files = new Map<string, CachedFile>();
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("capture contains a symlink");
      if (entry.isDirectory()) walk(filename);
      else if (entry.isFile()) {
        files.set(path.relative(root, filename).split(path.sep).join("/"), {
          bytes: fs.statSync(filename).size,
          sha256: sha256File(filename),
        });
      } else throw new Error("capture contains a special entry");
    }
  };
  walk(root);
  return files;
}

export function writeCaptureInventory(inventoryPath: string, files: ReadonlyMap<string, CachedFile>): void {
  const staged = `${inventoryPath}.tmp-${process.pid}`;
  const body = JSON.stringify({ inventoryVersion: 1, files: [...files].map(([filePath, file]) => ({ path: filePath, ...file })) });
  fs.writeFileSync(staged, `${body}\n`, { mode: 0o600 });
  fs.renameSync(staged, inventoryPath);
}

/** The inventory beside a cached tree, or undefined when there is none or
 * it is unreadable — either way the tree is not reused. */
export function readCaptureInventory(inventoryPath: string): Map<string, CachedFile> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
  } catch {
    return undefined;
  }
  if (!isObject(parsed) || parsed.inventoryVersion !== 1 || !Array.isArray(parsed.files)) return undefined;
  const files = new Map<string, CachedFile>();
  for (const entry of parsed.files) {
    if (
      !isObject(entry) ||
      typeof entry.path !== "string" ||
      !Number.isSafeInteger(entry.bytes) ||
      typeof entry.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(entry.sha256) ||
      files.has(entry.path)
    ) return undefined;
    files.set(entry.path, { bytes: entry.bytes as number, sha256: entry.sha256 });
  }
  return files;
}

async function downloadRegistryBlob(reference: string, destination: string): Promise<void> {
  const match = /^ghcr\.io\/([a-z0-9._/-]+)@sha256:([0-9a-f]{64})$/u.exec(reference);
  if (match === null) throw new Error("capture registryBlob is not a canonical GHCR digest reference");
  const repository = match[1]!;
  const digest = match[2]!;
  const scope = `repository:${repository}:pull`;
  const registry = registryOrigin();
  const tokenResponse = await fetch(
    `${registry}/token?service=ghcr.io&scope=${encodeURIComponent(scope)}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!tokenResponse.ok) throw new Error(`GHCR token request failed with HTTP ${tokenResponse.status}`);
  const tokenValue = await tokenResponse.json() as { token?: unknown };
  if (typeof tokenValue.token !== "string" || tokenValue.token === "") {
    throw new Error("GHCR token response is malformed");
  }
  const response = await fetch(
    `${registry}/v2/${repository}/blobs/sha256:${digest}`,
    {
      redirect: "follow",
      headers: { authorization: `Bearer ${tokenValue.token}` },
      signal: AbortSignal.timeout(10 * 60_000),
    },
  );
  if (!response.ok || response.body === null) throw new Error(`GHCR blob download failed with HTTP ${response.status}`);
  const final = new URL(response.url);
  if (
    final.origin !== registry &&
    (final.protocol !== "https:" ||
      !["ghcr.io", "pkg-containers.githubusercontent.com"].includes(final.hostname) ||
      final.username !== "" ||
      final.password !== "")
  ) throw new Error("GHCR blob redirect leaves the allowed public HTTPS locations");
  await writeResponse(response, destination);
}

async function writeResponse(response: Response, destination: string): Promise<void> {
  if (response.body === null) throw new Error("capture response has no body");
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_CAPTURE_BYTES) throw new Error("capture exceeds 2 GiB");
  const reader = response.body.getReader();
  const handle = fs.openSync(destination, "wx", 0o600);
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_CAPTURE_BYTES) throw new Error("capture exceeds 2 GiB");
      fs.writeSync(handle, value);
    }
  } finally {
    fs.closeSync(handle);
  }
}

function extractCapture(archive: string, destination: string): void {
  const listing = execFileSync("tar", ["-tvf", archive], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  for (const line of listing.split("\n").filter(Boolean)) {
    if (line[0] !== "-" && line[0] !== "d") throw new Error("capture contains a link or special entry");
  }
  const names = execFileSync("tar", ["-tf", archive], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  for (const entry of names.split("\n").filter(Boolean)) {
    const normalized = path.posix.normalize(entry.replace(/^\.\//u, ""));
    if (path.posix.isAbsolute(entry) || normalized === ".." || normalized.startsWith("../") || entry.includes("\\")) {
      throw new Error("capture contains an escaping path");
    }
  }
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  execFileSync("tar", ["-xf", archive, "-C", destination], { stdio: ["ignore", "ignore", "pipe"] });
}

/**
 * Hold a capture tree to what is known of it: every file against `expected`
 * (a spec-1 record's declared inventory, or the sidecar inventory written at
 * download for a spec-2 record) when there is one, the member count alone
 * otherwise (a spec-2 tree fresh out of a digest-verified tar), and on both
 * that only regular files are there.
 */
export function verifyCapture(root: string, capture: PublishedCapture, expected: ReadonlyMap<string, CachedFile> | undefined): void {
  const seen = new Set<string>();
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("cached capture contains a symlink");
      if (entry.isDirectory()) walk(filename);
      else if (entry.isFile()) {
        const relative = path.relative(root, filename).split(path.sep).join("/");
        if (expected !== undefined) {
          const specification = expected.get(relative);
          if (specification === undefined) throw new Error(`cached capture has unexpected file ${relative}`);
          const stat = fs.statSync(filename);
          if (stat.size !== specification.bytes || sha256File(filename) !== specification.sha256) {
            throw new Error(`cached capture file failed verification: ${relative}`);
          }
        }
        seen.add(relative);
      } else throw new Error("cached capture contains a special entry");
    }
  };
  walk(root);
  if (expected !== undefined && seen.size !== expected.size) throw new Error("cached capture is missing declared files");
  if (capture.fileCount !== undefined && seen.size !== capture.fileCount) {
    throw new Error("cached capture does not hold the declared number of files");
  }
}

function sha256File(filename: string): string {
  const hash = createHash("sha256");
  const handle = fs.openSync(filename, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest("hex");
}
