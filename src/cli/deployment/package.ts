import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
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
const archive = path.join(vendorDirectory, filename);
execFileSync("tar", ["-xzf", archive, "-C", vendorDirectory]);
// Only the extracted tree ships in the CLI tarball; keeping the pack archive
// next to it would double the vendored payload.
fs.rmSync(archive);
fs.renameSync(path.join(vendorDirectory, "package"), runtimeDirectory);
const bundleSha256 = directoryDigest(runtimeDirectory);
fs.writeFileSync(
  metadataFile,
  `${JSON.stringify({ repository: lock.repository, revision: lock.revision, bundleSha256 }, null, 2)}\n`,
);
console.log(`Packaged page-builder ${lock.revision} (bundle ${bundleSha256}).`);
