import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [archive, destination] = process.argv.slice(2);
if (archive === undefined || destination === undefined || !path.isAbsolute(archive) || !path.isAbsolute(destination)) process.exit(2);
const listing = spawnSync("tar", ["-tvf", archive], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
if (listing.status !== 0) {
  console.error("capture is not a readable tar archive");
  process.exit(1);
}
for (const line of listing.stdout.split("\n").filter(Boolean)) {
  if (line[0] !== "-" && line[0] !== "d") {
    console.error("capture contains a link or special filesystem entry");
    process.exit(1);
  }
}
const names = spawnSync("tar", ["-tf", archive], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
if (names.status !== 0) process.exit(1);
for (const entry of names.stdout.split("\n").filter(Boolean)) {
  const normalized = path.posix.normalize(entry.replace(/^\.\//u, ""));
  if (path.posix.isAbsolute(entry) || normalized === ".." || normalized.startsWith("../") || entry.includes("\\")) {
    console.error("capture contains an escaping path");
    process.exit(1);
  }
}
fs.mkdirSync(destination, { recursive: true });
const extracted = spawnSync(
  "tar",
  ["--extract", "--file", archive, "--directory", destination, "--no-same-owner", "--no-same-permissions"],
  { encoding: "utf8", maxBuffer: 1024 * 1024 },
);
if (extracted.status !== 0) {
  console.error(extracted.stderr || "capture extraction failed");
  process.exit(1);
}
