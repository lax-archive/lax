import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  archiveFile,
  directoryDigest,
  metadataFile,
  readLock,
  sourceDirectory,
  runtimeDirectory,
  vendorDirectory,
} from "./shared.js";

const lock = readLock();
if (!fs.existsSync(path.join(sourceDirectory, "package.json"))) {
  throw new Error("page-builder source is missing; run page-builder:fetch first");
}
fs.rmSync(vendorDirectory, { recursive: true, force: true });
fs.mkdirSync(vendorDirectory, { recursive: true });
execFileSync("npm", ["ci"], { cwd: sourceDirectory, stdio: "inherit" });
execFileSync("npm", ["run", "build"], { cwd: sourceDirectory, stdio: "inherit" });
const packed = execFileSync(
  "npm",
  ["pack", "--ignore-scripts", "--pack-destination", vendorDirectory, "--json"],
  {
    cwd: sourceDirectory,
    encoding: "utf8",
  },
);
const result = JSON.parse(packed) as Array<{ filename: string }>;
const filename = result[0]?.filename;
if (filename === undefined) throw new Error("npm pack did not produce a page-builder archive");
fs.renameSync(path.join(vendorDirectory, filename), archiveFile);
const sha256 = createHash("sha256").update(fs.readFileSync(archiveFile)).digest("hex");
execFileSync("tar", ["-xzf", archiveFile, "-C", vendorDirectory]);
fs.renameSync(path.join(vendorDirectory, "package"), runtimeDirectory);
const bundleSha256 = directoryDigest(runtimeDirectory);
fs.writeFileSync(
  metadataFile,
  `${JSON.stringify({ repository: lock.repository, revision: lock.revision, sha256, bundleSha256 }, null, 2)}\n`,
);
console.log(`Packaged page-builder ${lock.revision} (${sha256}, bundle ${bundleSha256}).`);
