import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { buildRoot, readLock, sourceDirectory } from "./shared.js";

const lock = readLock();
fs.rmSync(buildRoot, { recursive: true, force: true });
fs.mkdirSync(buildRoot, { recursive: true });
execFileSync("git", ["clone", "--filter=blob:none", "--no-checkout", lock.repository, sourceDirectory], {
  stdio: "inherit",
});
execFileSync("git", ["-C", sourceDirectory, "fetch", "--depth", "1", "origin", lock.revision], {
  stdio: "inherit",
});
execFileSync("git", ["-C", sourceDirectory, "checkout", "--detach", lock.revision], {
  stdio: "inherit",
});
const resolved = execFileSync("git", ["-C", sourceDirectory, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
if (resolved !== lock.revision) throw new Error(`page-builder resolved to ${resolved}, expected ${lock.revision}`);
console.log(`Fetched lax-website page-builder at ${resolved}.`);
