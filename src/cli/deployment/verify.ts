import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  archiveFile,
  directoryDigest,
  metadataFile,
  readLock,
  runtimeDirectory,
} from "./shared.js";

const lock = readLock();
if (!fs.existsSync(archiveFile) || !fs.existsSync(metadataFile) || !fs.existsSync(runtimeDirectory)) {
  throw new Error("packaged page-builder and metadata are required");
}
const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8")) as {
  repository?: string;
  revision?: string;
  sha256?: string;
  bundleSha256?: string;
};
const sha256 = createHash("sha256").update(fs.readFileSync(archiveFile)).digest("hex");
const bundleSha256 = directoryDigest(runtimeDirectory);
if (
  metadata.repository !== lock.repository ||
  metadata.revision !== lock.revision ||
  metadata.sha256 !== sha256 ||
  metadata.bundleSha256 !== bundleSha256
) {
  throw new Error("packaged page-builder metadata does not match its lock or bytes");
}
const entries = execFileSync("tar", ["-tzf", archiveFile], { encoding: "utf8" });
if (!entries.includes("package/dist/") || !entries.includes("package/package.json")) {
  throw new Error("page-builder package is missing its compiled distribution");
}
for (const relative of [
  "package.json",
  "dist/sitegen/generate.js",
  "dist/sitegen/assets.js",
  "assets/site",
  "content/landing.md",
  "content/contributing.md",
]) {
  if (!fs.existsSync(path.join(runtimeDirectory, relative))) {
    throw new Error(`page-builder runtime bundle is missing ${relative}`);
  }
}
console.log(`Verified bundled page-builder revision ${lock.revision}.`);
