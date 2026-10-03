// The certificate bundle as bytes: the five generated files in one
// deterministic ustar archive, written in process. A capture is sealed by
// the container's `tar` because it is gigabytes; a bundle is a few kilobytes
// of text, and writing the archive here gives both pipelines — the trusted
// container path and the local `lax build` — the same bytes for the same
// files, with no `tar` on any PATH involved. The layout is plain POSIX ustar:
// one regular-file member per bundle file in BUNDLE_FILES order (which is
// byte order), mode 0644, uid/gid 0, mtime 0, two zero blocks, 10240-byte
// blocking — what `tar -xf` and a ustar reader both accept.

import { createHash } from "node:crypto";
import { BUNDLE_FILES, type BundleFile } from "./generate.js";

const BLOCK = 512;
const RECORD = 10_240;

function octal(value: number, width: number): Buffer {
  const text = value.toString(8).padStart(width - 1, "0");
  if (text.length > width - 1) throw new Error("ustar field overflow");
  return Buffer.from(`${text}\0`, "latin1");
}

function header(name: string, size: number): Buffer {
  const block = Buffer.alloc(BLOCK);
  const nameBytes = Buffer.from(name, "utf8");
  // ustar splits a long name into a 155-byte prefix and a 100-byte name at
  // a slash; the capture's paths (`concepts/package/<module path>.lean`)
  // fit the name field almost always, the prefix covers the rest
  if (nameBytes.length > 100) {
    const split = name.lastIndexOf("/", 155);
    const prefix = Buffer.from(name.slice(0, split), "utf8");
    const rest = Buffer.from(name.slice(split + 1), "utf8");
    if (split <= 0 || prefix.length > 155 || rest.length > 100) throw new Error(`tar member name too long: ${name}`);
    rest.copy(block, 0);
    prefix.copy(block, 345);
  } else nameBytes.copy(block, 0);
  octal(0o644, 8).copy(block, 100);
  octal(0, 8).copy(block, 108);
  octal(0, 8).copy(block, 116);
  octal(size, 12).copy(block, 124);
  octal(0, 12).copy(block, 136);
  Buffer.from("        ", "latin1").copy(block, 148); // checksum placeholder: eight spaces
  block[156] = 0x30; // '0': regular file
  Buffer.from("ustar\0", "latin1").copy(block, 257);
  Buffer.from("00", "latin1").copy(block, 263);
  octal(0, 8).copy(block, 329);
  octal(0, 8).copy(block, 337);
  let checksum = 0;
  for (const byte of block) checksum += byte;
  Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "latin1").copy(block, 148);
  return block;
}

/** The archive of these files and its sha256 (bare hex). */
export function sealBundle(files: Readonly<Record<BundleFile, string>>): { tar: Buffer; digest: string } {
  return sealTar(BUNDLE_FILES.map((name) => ({ name, content: Buffer.from(files[name], "utf8") })));
}

/**
 * A ustar archive of these members, in the order given, and its sha256.
 * The caller orders them; the bundle uses BUNDLE_FILES order, the
 * `references` layer (captures/seal.ts) path order.
 */
export function sealTar(members: ReadonlyArray<{ name: string; content: Buffer }>): { tar: Buffer; digest: string } {
  const parts: Buffer[] = [];
  for (const { name, content } of members) {
    parts.push(header(name, content.length), content);
    const padding = (BLOCK - (content.length % BLOCK)) % BLOCK;
    if (padding > 0) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(2 * BLOCK));
  const length = parts.reduce((total, part) => total + part.length, 0);
  const blocked = (RECORD - (length % RECORD)) % RECORD;
  if (blocked > 0) parts.push(Buffer.alloc(blocked));
  const tar = Buffer.concat(parts);
  return { tar, digest: createHash("sha256").update(tar).digest("hex") };
}

/** The members of a bundle tar written by `sealBundle`, in order, for a
 * reader that holds the bytes and wants the files back without `tar`. */
export function readBundle(tar: Buffer): Map<string, string> {
  const members = new Map<string, string>();
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    const prefix = block.subarray(345, 500).toString("utf8").replace(/\0.*$/su, "");
    const name = (prefix === "" ? "" : `${prefix}/`) + block.subarray(0, 100).toString("utf8").replace(/\0.*$/su, "");
    const size = parseInt(block.subarray(124, 136).toString("latin1").replace(/\0.*$/su, "").trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + BLOCK + size > tar.length)
      throw new Error("malformed bundle tar");
    members.set(name, tar.subarray(offset + BLOCK, offset + BLOCK + size).toString("utf8"));
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return members;
}
