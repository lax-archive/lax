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

/** The most a bundle member may hold: a Challenge is a few KB, a manifest
 * of a large closure a few hundred. The publisher's own cap on the tar is
 * 16 MiB (capture-store.ts). */
const MAX_MEMBER_BYTES = 16 * 1024 * 1024;

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
  Buffer.from(`${headerChecksum(block).toString(8).padStart(6, "0")}\0 `, "latin1").copy(block, 148);
  return block;
}

/** The ustar checksum: every header byte summed with the checksum field
 * itself read as eight spaces. */
function headerChecksum(block: Buffer): number {
  let checksum = 0;
  for (const [index, byte] of block.entries()) checksum += index >= 148 && index < 156 ? 0x20 : byte;
  return checksum;
}

/** The archive of these files and its sha256 (bare hex). */
export function sealBundle(files: Readonly<Record<BundleFile, string>>): { tar: Buffer; digest: string } {
  return sealTar(BUNDLE_FILES.map((name) => ({ name, content: Buffer.from(files[name], "utf8") })));
}

/**
 * A ustar archive of these members, in the order given, and its sha256.
 * The caller orders them; the bundle uses BUNDLE_FILES order, the
 * `references` layer (captures/seal.ts) byte order of the names.
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

/** A field of a ustar header: NUL-terminated, the rest ignored. */
function field(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
}

function malformed(what: string): never {
  throw new Error(`malformed bundle tar: ${what}`);
}

/**
 * The members of a tar written by `sealTar`, in order, for a reader that
 * holds the bytes and wants the files back without `tar`. Strict, since the
 * bytes may be a download: every header must carry the ustar magic and a
 * valid checksum and describe a regular file with a sane size; names are
 * unique and plain (no NUL, no leading `/`, no `..` component); the archive
 * ends with two zero blocks, followed by zero padding to the 10240-byte
 * record and nothing else. Anything else is refused rather than read.
 */
export function readBundle(tar: Buffer): Map<string, string> {
  const members = new Map<string, string>();
  let offset = 0;
  let terminated = false;
  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) {
      // the end: a second zero block, then only zero padding
      if (offset + 2 * BLOCK > tar.length) malformed("a single zero block ends the archive");
      if (!tar.subarray(offset + BLOCK).every((byte) => byte === 0)) malformed("data after the end-of-archive blocks");
      terminated = true;
      break;
    }
    if (field(block, 257, 6) !== "ustar" || block.subarray(263, 265).toString("latin1") !== "00") malformed("not a ustar header");
    const recorded = parseInt(block.subarray(148, 156).toString("latin1").replace(/\0.*$/su, "").trim(), 8);
    if (recorded !== headerChecksum(block)) malformed("header checksum");
    const typeflag = block[156];
    if (typeflag !== 0x30 && typeflag !== 0) malformed("a member that is not a regular file");
    const sizeText = block.subarray(124, 136).toString("latin1").replace(/\0.*$/su, "").trim();
    if (!/^[0-7]+$/u.test(sizeText)) malformed("member size");
    const size = parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || size > MAX_MEMBER_BYTES) malformed("member size");
    const prefix = field(block, 345, 155);
    const name = (prefix === "" ? "" : `${prefix}/`) + field(block, 0, 100);
    if (name === "" || name.startsWith("/") || name.split("/").some((part) => part === "..")) malformed(`member name ${JSON.stringify(name)}`);
    if (members.has(name)) malformed(`duplicate member ${name}`);
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (offset + BLOCK + padded > tar.length) malformed("truncated member");
    const content = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    if (!tar.subarray(offset + BLOCK + size, offset + BLOCK + padded).every((byte) => byte === 0)) malformed("member padding");
    members.set(name, content.toString("utf8"));
    offset += BLOCK + padded;
  }
  if (!terminated) malformed("no end-of-archive blocks");
  if (tar.length % RECORD !== 0) malformed("not blocked to 10240 bytes");
  return members;
}
