import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { DATABASE_REPOSITORY, SUBMISSION_ID_PATTERN } from "../shared/constants.js";
import { laxHome } from "./auth.js";
import * as ui from "./ui.js";

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

/**
 * Bring this machine's copy of the archive up to date and report it as one
 * settled row.
 *
 * A refresh is one fact, so it gets one line rather than a step list, and the
 * line says the two things an author can act on: whether the copy is current
 * and how much of the archive is in it. The commit that moved, the remote it
 * came from, and git's own transcript are internals and stay verbose — which is
 * also why the work runs through `updateDatabaseQuietly`: a clone's progress
 * bar written straight to the terminal would tear the redrawn row apart.
 */
export async function syncDatabase(): Promise<void> {
  const target = databaseDirectory();
  const cloning = !fs.existsSync(path.join(target, ".git"));
  // Counted before the update, so the delta is the update's own doing. A first
  // clone has nothing to compare against, which is why this is undefined rather
  // than zero: everything it downloads is the copy, not an increment to it.
  const before = cloning ? undefined : countDatabaseRecords();
  ui.verbose(`refreshing ${target} from ${databaseRepositoryUrl()}`);
  const steps = new ui.Steps();
  steps.add("archive", cloning ? "Cloning the archive" : "Archive");
  // Git's transcript and the failure the command dies of are both held until the
  // live region is gone: written into a redraw they would be eaten by it, and
  // the row is the thing the author reads first anyway.
  let transcript: string | undefined;
  let failure: Error | undefined;
  try {
    const update = await updateDatabaseQuietly();
    if (update.status === "failed") transcript = update.detail;
    switch (update.status) {
      case "invalid":
        steps.settle("archive", {
          status: "fail",
          label: "Archive",
          detail: `${ui.tilde(target)} is not a git clone`,
          under: [`Move it aside, then run ${ui.cmd("lax sync")} again.`],
        });
        failure = new Error(`${target} exists but is not a git clone; move it aside and retry`);
        break;
      case "failed":
        // With nothing on disk there is no archive to work with, so this is the
        // command failing. An existing copy is still what every local build,
        // preview and preflight reads, so there the only news is that it did
        // not move.
        steps.settle("archive", {
          status: before === undefined ? "fail" : "warn",
          label: before === undefined ? "Archive" : "Archive not updated",
          detail: "could not be reached",
          under: [
            ...(before === undefined ? [] : [`Your copy is unchanged — ${submissions(before)}.`]),
            `Check your connection, then run ${ui.cmd("lax sync")}.`,
          ],
        });
        if (before === undefined) {
          failure = new Error(`the archive could not be downloaded: ${update.detail}`);
        }
        break;
      // The three states that leave a usable copy behind: cloned, updated,
      // already current.
      default: {
        const after = countDatabaseRecords();
        const added = before === undefined ? 0 : after - before;
        steps.settle("archive", {
          label:
            update.status === "cloned"
              ? "Archive downloaded"
              : update.status === "updated"
                ? "Archive updated"
                : "Archive up to date",
          // `+3` is the part an author reads first, and it is a claim: it is
          // there only when records genuinely arrived.
          detail: added > 0 ? `+${ui.count(added)} · ${submissions(after)}` : submissions(after),
        });
      }
    }
  } finally {
    // The row spins on an interval, which holds the event loop open: a throw
    // that skipped this would hang the CLI rather than exit it.
    steps.finish();
  }
  if (transcript !== undefined) ui.verbose(transcript);
  if (failure !== undefined) throw failure;
}

/**
 * How many submissions this machine's copy of the archive holds. A record
 * directory per submission is the archive's own layout, so counting them is the
 * one number worth printing about a refresh — and `lax serve` and `lax doctor`
 * describe the same copy.
 */
export function countDatabaseRecords(): number {
  try {
    return fs
      .readdirSync(databaseDirectory(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SUBMISSION_ID_PATTERN.test(entry.name)).length;
  } catch {
    return 0;
  }
}

/** `1,204 submissions`: the archive as a size, which is what an author asked
 * about, rather than as a commit. */
function submissions(value: number): string {
  return `${ui.count(value)} ${value === 1 ? "submission" : "submissions"}`;
}

export type DatabaseUpdate =
  | { status: "cloned" | "updated" | "current" }
  | { status: "invalid" }
  | { status: "failed"; detail: string };

/**
 * Bring the local checkout in line with the public repository.
 *
 * This inherits no stdio and prints nothing: every caller — `lax doctor`,
 * `lax sync`, `lax update` — runs it underneath a live spinner, and a git
 * transcript written straight to the terminal would tear the redrawn region
 * apart. Failure is reported rather than thrown: an offline author still wants
 * the rest of the report, and the caller decides whether a copy left as it is
 * is fatal.
 */
export async function updateDatabaseQuietly(): Promise<DatabaseUpdate> {
  const target = databaseDirectory();
  const url = databaseRepositoryUrl();
  try {
    fs.mkdirSync(laxHome(), { recursive: true });
    migrateLegacyDatabase(target);
    if (!fs.existsSync(path.join(target, ".git"))) {
      if (fs.existsSync(target)) return { status: "invalid" };
      await gitAsync(["clone", "--filter=blob:none", "--quiet", url, target]);
      return { status: "cloned" };
    }
    const before = await gitAsync(["-C", target, "rev-parse", "HEAD"]);
    await gitAsync(["-C", target, "remote", "set-url", "origin", url]);
    await gitAsync(["-C", target, "pull", "--ff-only", "--quiet"]);
    const after = await gitAsync(["-C", target, "rev-parse", "HEAD"]);
    return { status: before === after ? "current" : "updated" };
  } catch (error) {
    return { status: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
}

async function gitAsync(args: string[]): Promise<string> {
  const { stdout } = await promisify(execFile)("git", args, {
    encoding: "utf8",
    timeout: 120_000,
  });
  return stdout.trim();
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

/** Compare the checkout with the public repository without changing it. The
 * `git ls-remote` in here is one of the slow probes `lax doctor` runs, so it
 * must not block the event loop the spinner turns on. */
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
    // A rename the author never asked for and cannot act on: true, and verbose.
    ui.verbose(`moved the existing database checkout from ${legacy} to ${target}`);
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
