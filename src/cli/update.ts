import { execFile, execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { syncDatabase } from "./database.js";
import * as ui from "./ui.js";
import { updateWebsiteRenderer } from "./website-renderer.js";

const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };

/**
 * Upgrade the CLI, then refresh the archive and Website renderer. Each owns a
 * separate report because the work is strictly sequential.
 */
export async function updateCli(): Promise<void> {
  const verbose = ui.isVerbose();
  // With `--verbose` npm writes to the terminal itself, and a row redrawing over
  // that transcript would eat lines out of it: there the install runs first and
  // the row reports a finished result.
  if (verbose) await installLatest();
  const steps = new ui.Steps();
  steps.add("cli", "Updating lax");
  try {
    // The install is tens of seconds, which may not look like a hang.
    if (!verbose) await installLatest();
    steps.settle("cli", versionRow(installedVersion()));
  } catch (error) {
    // The row is the report, the thrown error carries npm's own words; `finally`
    // commits the row before the error is printed either way.
    steps.settle("cli", {
      status: "fail",
      label: "lax not updated",
      detail: "npm could not install it",
    });
    throw error;
  } finally {
    steps.finish();
  }
  await syncDatabase();
  let websiteCommit: string | undefined;
  if (verbose) websiteCommit = await updateWebsiteRenderer({ verbose: true });
  const renderer = new ui.Steps();
  renderer.add("renderer", "Website renderer");
  try {
    if (!verbose) websiteCommit = await updateWebsiteRenderer();
    renderer.settle("renderer", { label: "Website renderer is current" });
  } catch (error) {
    renderer.settle("renderer", {
      status: "fail",
      label: "Website renderer not updated",
      detail: "download or install failed",
    });
    throw error;
  } finally {
    renderer.finish();
  }
  ui.verbose(`website renderer ${websiteCommit ?? "unknown"}`);
}

/**
 * Where the update took this machine, always as `before → after`, even when the
 * two are the same version. It is the one question `lax update` exists to
 * answer, and "up to date" without a number leaves the author checking
 * `lax --version` afterwards to find out what they are running.
 *
 * The `after` is measured rather than assumed: `npm install` reports success
 * when it reinstalls the version already present, so an arrow drawn from the
 * registry's `latest` would be a claim about what npm was asked to do rather
 * than about what it did.
 */
export function versionRow(installed: string | undefined): ui.StepOutcome {
  if (installed === undefined) {
    // npm installed something and then would not say what. Rare, and not the
    // author's problem to fix — but a row must not invent the number it is for.
    return {
      status: "warn",
      label: "Updated lax",
      detail: `${version} → npm did not say which version it installed`,
    };
  }
  return {
    label: installed === version ? "lax is up to date" : "Updated lax",
    detail: `${version} → ${installed}`,
  };
}

/**
 * `lax update` always asks the network what `latest` is. Three flags, not one,
 * because each closes a different way npm answers from disk instead:
 *
 * - `--prefer-online` forces the staleness check. It is npm's default-off
 *   (`prefer-online=false`), and without it npm resolves the `latest` tag from
 *   its cached packument and only revalidates once the registry's max-age
 *   (~5 min) has passed — so an update in the minutes after a release
 *   reinstalls the version already present and exits 0.
 * - `--no-prefer-offline` and `--no-offline` override the same two settings
 *   turned on in the author's `~/.npmrc`, where `offline` would refuse the
 *   network outright and serve whatever the cache holds.
 *
 * Command-line flags beat npmrc, so this is the whole of it: there is no
 * configuration of npm under which `lax update` installs a cached version.
 */
export const INSTALL_ARGS = [
  "install",
  "--global",
  "--prefer-online",
  "--no-prefer-offline",
  "--no-offline",
  "lax-archive@latest",
];

/**
 * npm's install transcript is a page of dependency bookkeeping the author did
 * not ask for, so on success it is captured and dropped. It survives in the
 * error, because a global install that fails says why nowhere else — and under
 * `--verbose` it goes to the terminal as npm wrote it.
 */
export async function installLatest(): Promise<void> {
  const args = INSTALL_ARGS;
  if (ui.isVerbose()) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("npm", args, { stdio: "inherit" });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`npm install --global lax-archive@latest exited with ${code ?? "a signal"}`));
      });
    });
    return;
  }
  try {
    await promisify(execFile)("npm", args, {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 10 * 60_000,
    });
  } catch (error) {
    throw new Error(`npm could not install lax-archive@latest\n${transcript(error)}`);
  }
}

/**
 * The globally installed version, read back after the install. This process is
 * still running the *old* code — its own `package.json` cannot answer — so the
 * only honest source is npm's view of what is on disk now. `undefined` is the
 * one case the row cannot state a number for, and it says so rather than
 * guessing.
 */
function installedVersion(): string | undefined {
  try {
    const listed = JSON.parse(
      execFileSync("npm", ["ls", "--global", "--depth=0", "--json", "lax-archive"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 60_000,
      }),
    ) as { dependencies?: Record<string, { version?: unknown }> };
    const found = listed.dependencies?.["lax-archive"]?.version;
    return typeof found === "string" ? found : undefined;
  } catch {
    return undefined;
  }
}

/** What npm actually said, from wherever it said it. */
function transcript(error: unknown): string {
  const { stdout, stderr } = error as { stdout?: string; stderr?: string };
  const said = `${stdout ?? ""}${stderr ?? ""}`.trim();
  if (said !== "") return said;
  return error instanceof Error ? error.message : String(error);
}
