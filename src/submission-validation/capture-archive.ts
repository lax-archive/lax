import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CaptureManifest } from "./contracts.js";
import { ValidationError } from "../shared/validation.js";

const BLOCK_BYTES = 512;
const MAX_CAPTURE_FILES = 100_000;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Verify an untrusted deterministic USTAR capture without extracting or
 * executing any of its content.
 */
export function verifyCaptureArchive(filename: string, manifest: CaptureManifest): void {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CAPTURE_BYTES) {
    throw new ValidationError("capture.tar must be a non-empty regular file no larger than 2 GiB");
  }
  if (stat.size % BLOCK_BYTES !== 0) throw new ValidationError("capture.tar is not block-aligned USTAR");
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  if (expected.size !== manifest.files.length || expected.size === 0) {
    throw new ValidationError("capture manifest must contain unique non-empty file inventory");
  }
  const seen = new Set<string>();
  const expectedDirectories = directorySet(manifest.files.map((file) => file.path));
  const seenDirectories = new Set<string>();
  const descriptor = fs.openSync(filename, "r");
  const header = Buffer.alloc(BLOCK_BYTES);
  let offset = 0;
  let zeroBlocks = 0;
  let totalBytes = 0;
  let entries = 0;
  try {
    while (offset < stat.size) {
      readExactly(descriptor, header, offset);
      offset += BLOCK_BYTES;
      if (header.every((byte) => byte === 0)) {
        zeroBlocks += 1;
        if (zeroBlocks >= 2) break;
        continue;
      }
      if (zeroBlocks !== 0) throw new ValidationError("capture.tar has data after an end marker");
      entries += 1;
      if (entries > MAX_CAPTURE_FILES * 2) {
        throw new ValidationError("capture.tar contains too many entries");
      }
      verifyHeaderChecksum(header);
      if (field(header, 257, 6) !== "ustar" || field(header, 263, 2) !== "00") {
        throw new ValidationError("capture.tar must use the USTAR format without extensions");
      }
      const entryPath = archivePath(header);
      const type = header[156];
      const size = octal(header, 124, 12, "entry size");
      if (field(header, 157, 100) !== "") {
        throw new ValidationError(`capture.tar entry ${entryPath} has an unexpected link target`);
      }
      if (type === 53) {
        if (size !== 0 || !entryPath.endsWith("/")) {
          throw new ValidationError(`capture directory ${entryPath} is malformed`);
        }
        if (!expectedDirectories.has(entryPath) || seenDirectories.has(entryPath)) {
          throw new ValidationError(`capture.tar contains unexpected or duplicate directory ${entryPath}`);
        }
        seenDirectories.add(entryPath);
      } else if (type === 0 || type === 48) {
        if (entryPath.endsWith("/")) throw new ValidationError(`capture file ${entryPath} is malformed`);
        const expectedFile = expected.get(entryPath);
        if (expectedFile === undefined) {
          throw new ValidationError(`capture.tar contains unmanifested file ${entryPath}`);
        }
        if (seen.has(entryPath)) throw new ValidationError(`capture.tar contains duplicate file ${entryPath}`);
        if (size !== expectedFile.bytes) {
          throw new ValidationError(`capture file ${entryPath} has the wrong size`);
        }
        totalBytes += size;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_CAPTURE_BYTES) {
          throw new ValidationError("capture.tar file content exceeds 2 GiB");
        }
        if (hashRange(descriptor, offset, size) !== expectedFile.sha256) {
          throw new ValidationError(`capture file ${entryPath} has the wrong digest`);
        }
        seen.add(entryPath);
      } else {
        throw new ValidationError(`capture.tar contains unsupported entry type ${type}`);
      }
      offset += padded(size);
      if (offset > stat.size) throw new ValidationError("capture.tar entry exceeds the archive boundary");
    }
    if (zeroBlocks < 2) throw new ValidationError("capture.tar has no complete end marker");
    while (offset < stat.size) {
      readExactly(descriptor, header, offset);
      if (!header.every((byte) => byte === 0)) {
        throw new ValidationError("capture.tar has non-zero trailing data");
      }
      offset += BLOCK_BYTES;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  if (seen.size !== expected.size) {
    const missing = manifest.files.find((file) => !seen.has(file.path));
    throw new ValidationError(`capture.tar is missing manifest file ${missing?.path ?? "unknown"}`);
  }
}

function archivePath(header: Buffer): string {
  const name = field(header, 0, 100);
  const prefix = field(header, 345, 155);
  const raw = prefix === "" ? name : `${prefix}/${name}`;
  const stripped = raw.startsWith("./") ? raw.slice(2) : raw;
  const normalized = stripped.endsWith("/") ? stripped.slice(0, -1) : stripped;
  if (normalized === "") return "./";
  if (
    stripped.includes("\\") ||
    path.posix.isAbsolute(stripped) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.endsWith("/") ||
    path.posix.normalize(normalized) !== normalized ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) throw new ValidationError(`capture.tar contains unsafe path ${JSON.stringify(raw)}`);
  return stripped.endsWith("/") ? `${normalized}/` : normalized;
}

function verifyHeaderChecksum(header: Buffer): void {
  const expected = octal(header, 148, 8, "header checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index]!;
  }
  if (actual !== expected) throw new ValidationError("capture.tar has an invalid header checksum");
}

function field(buffer: Buffer, start: number, length: number): string {
  const value = buffer.subarray(start, start + length);
  const end = value.indexOf(0);
  const selected = end === -1 ? value : value.subarray(0, end);
  if (end !== -1 && value.subarray(end).some((byte) => byte !== 0)) {
    throw new ValidationError("capture.tar header text has non-zero bytes after its terminator");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(selected);
  } catch {
    throw new ValidationError("capture.tar header contains malformed UTF-8 text");
  }
}

function octal(buffer: Buffer, start: number, length: number, label: string): number {
  const encoded = buffer.subarray(start, start + length).toString("ascii");
  const match = /^([0-7]+)(?:\0[\0 ]*| +)$/u.exec(encoded);
  if (match === null) throw new ValidationError(`capture.tar ${label} is not canonical octal`);
  const value = Number.parseInt(match[1]!, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new ValidationError(`capture.tar ${label} is out of range`);
  return value;
}

function hashRange(descriptor: number, start: number, length: number): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = start;
  let remaining = length;
  while (remaining > 0) {
    const requested = Math.min(remaining, buffer.length);
    const bytes = fs.readSync(descriptor, buffer, 0, requested, offset);
    if (bytes === 0) throw new ValidationError("capture.tar ended inside a file");
    hash.update(buffer.subarray(0, bytes));
    offset += bytes;
    remaining -= bytes;
  }
  return hash.digest("hex");
}

function readExactly(descriptor: number, buffer: Buffer, position: number): void {
  let read = 0;
  while (read < buffer.length) {
    const bytes = fs.readSync(descriptor, buffer, read, buffer.length - read, position + read);
    if (bytes === 0) throw new ValidationError("capture.tar ended in a header block");
    read += bytes;
  }
}

function padded(size: number): number {
  return Math.ceil(size / BLOCK_BYTES) * BLOCK_BYTES;
}

function directorySet(files: string[]): Set<string> {
  const directories = new Set(["./"]);
  for (const filename of files) {
    const parts = filename.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(`${parts.slice(0, index).join("/")}/`);
    }
  }
  return directories;
}
