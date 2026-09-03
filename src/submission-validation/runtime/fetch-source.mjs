import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { validateSourceRepositoryUrl } from "./source-repository.mjs";

const [repository, commit, destination] = process.argv.slice(2);
if (repository === undefined || commit === undefined || destination === undefined) {
  console.error("usage: fetch-source.mjs <repository> <commit> <destination>");
  process.exit(2);
}
try {
  validateSourceRepositoryUrl(repository);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
if (!/^[0-9a-f]{40}$/u.test(commit)) {
  console.error("commit must be a full lowercase SHA");
  process.exit(2);
}
if (!path.isAbsolute(destination) || destination === "/") {
  console.error("destination must be a specific absolute path");
  process.exit(2);
}

fs.mkdirSync(destination, { recursive: true });
const env = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: "/tmp/lax-fetch-home",
  GIT_ALLOW_PROTOCOL: "https",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

function git(args, quiet = false) {
  const result = spawnSync("git", args, {
    cwd: destination,
    env,
    encoding: "utf8",
    stdio: quiet ? ["ignore", "ignore", "pipe"] : ["ignore", "pipe", "pipe"],
  });
  if (!quiet && result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status ?? 1;
}

if (git(["init", "--quiet"]) !== 0 || git(["remote", "add", "origin", repository]) !== 0) process.exit(1);
let status = git(["fetch", "--quiet", "--depth", "1", "origin", commit]);
if (status !== 0) status = git(["fetch", "--quiet", "--depth", "1", "origin"]);
if (status !== 0) {
  console.error("repository or commit could not be fetched anonymously");
  process.exit(1);
}
if (git(["-c", "advice.detachedHead=false", "checkout", "--quiet", commit]) !== 0) {
  console.error("requested commit is not present in the fetched repository");
  process.exit(1);
}
const resolved = spawnSync("git", ["rev-parse", "HEAD"], { cwd: destination, env, encoding: "utf8" });
if (resolved.status !== 0 || resolved.stdout.trim() !== commit) {
  console.error("checkout did not resolve to the requested immutable commit");
  process.exit(1);
}
