import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DATABASE_REPOSITORY } from "../shared/constants.js";
import { laxHome } from "./auth.js";

export function databaseDirectory(): string {
  return path.join(laxHome(), "lax-database");
}

export type DatabaseRefreshResult = "refreshed" | "failed" | "missing";

export type DatabaseFreshness =
  | { status: "current"; local: string; remote: string }
  | { status: "stale"; local: string; remote: string }
  | { status: "missing" }
  | { status: "unreachable"; local?: string }
  | { status: "invalid" };

export function databaseRepositoryUrl(): string {
  return (
    process.env.LAX_DATABASE_URL ??
    process.env.LAX_DB_URL ??
    `https://github.com/${DATABASE_REPOSITORY}.git`
  );
}

export function updateDatabase(): void {
  const target = databaseDirectory();
  const url = databaseRepositoryUrl();
  console.log(`Refreshing ${target} from ${url}.`);
  fs.mkdirSync(laxHome(), { recursive: true });
  migrateLegacyDatabase(target);
  if (!fs.existsSync(path.join(target, ".git"))) {
    if (fs.existsSync(target)) {
      throw new Error(`${target} exists but is not a git clone; move it aside and retry`);
    }
    execFileSync("git", ["clone", "--filter=blob:none", url, target], { stdio: "inherit" });
  } else {
    execFileSync("git", ["-C", target, "remote", "set-url", "origin", url], {
      stdio: "ignore",
    });
    execFileSync("git", ["-C", target, "pull", "--ff-only"], { stdio: "inherit" });
  }
  console.log(`lax-database is current at ${target}`);
}

/** Quiet best-effort refresh used before local safety decisions. */
export function tryRefreshDatabase(): DatabaseRefreshResult {
  const target = databaseDirectory();
  if (!fs.existsSync(path.join(target, ".git"))) return "missing";
  try {
    execFileSync("git", ["-C", target, "pull", "--ff-only", "--quiet"], {
      stdio: "ignore",
      timeout: 30_000,
    });
    return "refreshed";
  } catch {
    return "failed";
  }
}

/** Compare the checkout with the public repository without changing it. */
export function databaseFreshness(): DatabaseFreshness {
  const target = databaseDirectory();
  if (!fs.existsSync(path.join(target, ".git"))) return { status: "missing" };
  let local: string;
  try {
    local = git(["-C", target, "rev-parse", "HEAD"]);
  } catch {
    return { status: "invalid" };
  }
  try {
    const remote = git(["ls-remote", databaseRepositoryUrl(), "HEAD"]).split("\t")[0]!;
    if (!/^[0-9a-f]{40}$/u.test(remote)) return { status: "unreachable", local };
    return { status: remote === local ? "current" : "stale", local, remote };
  } catch {
    return { status: "unreachable", local };
  }
}

export async function databaseFreshnessAsync(): Promise<DatabaseFreshness> {
  const target = databaseDirectory();
  if (!fs.existsSync(path.join(target, ".git"))) return { status: "missing" };
  let local: string;
  try {
    local = git(["-C", target, "rev-parse", "HEAD"]);
  } catch {
    return { status: "invalid" };
  }
  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        ["ls-remote", databaseRepositoryUrl(), "HEAD"],
        { encoding: "utf8", timeout: 30_000 },
        (error, stdout) => error === null ? resolve(stdout) : reject(error),
      );
    });
    const remote = output.trim().split("\t")[0]!;
    if (!/^[0-9a-f]{40}$/u.test(remote)) return { status: "unreachable", local };
    return { status: remote === local ? "current" : "stale", local, remote };
  } catch {
    return { status: "unreachable", local };
  }
}

function migrateLegacyDatabase(target: string): void {
  if (fs.existsSync(target)) return;
  for (const name of ["database", "db"]) {
    const legacy = path.join(laxHome(), name);
    if (!fs.existsSync(legacy)) continue;
    fs.renameSync(legacy, target);
    console.log(`moved the existing database checkout from ${legacy} to ${target}`);
    return;
  }
}

function git(args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 30_000,
  }).trim();
}
