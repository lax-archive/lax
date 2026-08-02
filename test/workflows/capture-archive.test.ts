import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyCaptureArchive } from "../../src/submission-validation/capture-archive.js";
import type { CaptureManifest } from "../../src/submission-validation/contracts.js";
import { cleanupTemporary, temporary } from "../support/submission-validation.js";

afterEach(cleanupTemporary);

describe("untrusted capture archive verification", () => {
  it("accepts an exact USTAR file inventory", () => {
    const body = Buffer.from("abc", "utf8");
    const filename = writeTar([{ name: "concepts/Lax42.olean", body }]);
    expect(() => verifyCaptureArchive(filename, manifest(body))).not.toThrow();
  });

  it("rejects unmanifested, missing, changed, unsafe, and non-regular entries", () => {
    const body = Buffer.from("abc", "utf8");
    const expected = manifest(body);
    expect(() => verifyCaptureArchive(
      writeTar([{ name: "concepts/Lax42.olean", body }, { name: "extra", body }]),
      expected,
    )).toThrow("unmanifested file");
    expect(() => verifyCaptureArchive(writeTar([{ name: "other", body }]), expected)).toThrow();
    expect(() => verifyCaptureArchive(
      writeTar([{ name: "concepts/Lax42.olean", body: Buffer.from("abd") }]),
      expected,
    )).toThrow("wrong digest");
    expect(() => verifyCaptureArchive(writeTar([{ name: "../escape", body }]), expected)).toThrow("unsafe path");
    expect(() => verifyCaptureArchive(
      writeTar([{ name: "concepts/Lax42.olean", body: Buffer.alloc(0), type: "2" }]),
      expected,
    )).toThrow("unsupported entry type");
  });

  it("rejects corrupt headers and trailing data", () => {
    const body = Buffer.from("abc", "utf8");
    const filename = writeTar([{ name: "concepts/Lax42.olean", body }]);
    const corrupt = fs.readFileSync(filename);
    corrupt[0] = 88;
    fs.writeFileSync(filename, corrupt);
    expect(() => verifyCaptureArchive(filename, manifest(body))).toThrow("invalid header checksum");

    const trailing = writeTar([{ name: "concepts/Lax42.olean", body }]);
    fs.appendFileSync(trailing, Buffer.alloc(512, 1));
    expect(() => verifyCaptureArchive(trailing, manifest(body))).toThrow("non-zero trailing data");
  });
});

function manifest(body: Buffer): CaptureManifest {
  return {
    formatVersion: 1,
    digest: "d".repeat(64),
    sourceCommit: "1".repeat(40),
    leanToolchain: "leanprover/lean4:v4.30.0",
    mathlibCommit: "3".repeat(40),
    files: [{
      path: "concepts/Lax42.olean",
      bytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
    }],
  };
}

function writeTar(entries: Array<{ name: string; body: Buffer; type?: string }>): string {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "ascii");
    writeOctal(header, 100, 8, 0o444);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, entry.body.length);
    writeOctal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = (entry.type ?? "0").charCodeAt(0);
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    const encoded = `${checksum.toString(8).padStart(6, "0")}\0 `;
    header.write(encoded, 148, 8, "ascii");
    blocks.push(header, entry.body, Buffer.alloc((512 - (entry.body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  const filename = path.join(temporary("capture-tar-"), "capture.tar");
  fs.writeFileSync(filename, Buffer.concat(blocks));
  return filename;
}

function writeOctal(buffer: Buffer, start: number, length: number, value: number): void {
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  buffer.write(encoded, start, length, "ascii");
}
