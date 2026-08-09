import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CONTROL_REPOSITORY } from "../shared/constants.js";
import { GitHubClient, GitHubError, repositoryPath } from "../shared/github.js";
import { elanHome, toolchainBinDir } from "../submission-validation/host/leanenv.js";
import { run } from "../submission-validation/host/proc.js";
import { installElan } from "../submission-validation/host/setup.js";
import { ensureLocalWarm, warmDir, warmReady } from "../submission-validation/host/warmstore.js";
import { LEAN_TOOLCHAIN, MATHLIB_REV } from "../submission-validation/pins.js";
import { credentialsFile, githubAppUserToken, laxHome, readGitHubAppCredentials } from "./auth.js";
import { databaseDirectory, updateDatabaseQuietly } from "./database.js";
import { LoadingBlock } from "./loading.js";
import { issueNumberFromFolder } from "./manifest.js";
import { registeredSubmissions } from "./registry.js";

const execFileAsync = promisify(execFile);

interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  fix?: string;
}

/**
 * The binary a lax command would actually run for `tool`.
 *
 * elan and lake are resolved in the lax-owned locations first: doctor installs
 * elan under `elanHome()` with `--no-modify-path`, and elan installs lake under
 * `toolchainBinDir()`, so on a machine provisioned by `lax doctor` neither is on
 * PATH — while every build path already runs them from exactly these paths
 * (leanenv.ts). Probing PATH alone made the preflight refuse to build with a
 * toolchain the CLI had just installed and was about to use. Anything else, and
 * either of these when lax has not installed it, is a plain PATH lookup.
 */
function toolBinary(tool: string): string {
  const owned =
    tool === "elan"
      ? path.join(elanHome(), "bin", "elan")
      : tool === "lake"
        ? path.join(toolchainBinDir(), "lake")
        : undefined;
  return owned !== undefined && fs.existsSync(owned) ? owned : tool;
}

/** The blocking probe, kept for the callers that only want a yes/no before
 * running a command (`lax build`'s preflight, the missing-tool hint in
 * main.ts). The report uses `toolVersionAsync`. */
export function toolVersion(tool: string): string | undefined {
  try {
    return execFileSync(toolBinary(tool), ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).split("\n")[0]!.trim();
  } catch {
    return undefined;
  }
}

async function toolVersionAsync(tool: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(toolBinary(tool), ["--version"], { encoding: "utf8" });
    return stdout.split("\n")[0]!.trim();
  } catch {
    return undefined;
  }
}

const MARK = { ok: "✓", warn: "!", fail: "✗" } as const;

/** The fix line for a gap `--dry` reported instead of closing. */
const WOULD_INSTALL = "run `lax doctor` without --dry to install it";

/**
 * elan, plus the install that provisions it.
 *
 * The one prerequisite a fresh machine cannot talk itself out of: no elan, no
 * toolchain, and no `lax build`. Installing it here is what makes `npm i -g
 * lax-archive && lax doctor` a complete setup on a bare container rather than a
 * list of things to go and do — it runs the pinned bootstrap script
 * (`ELAN_COMMIT`), the same one the trusted VM setup runs, into `elanHome()`
 * and nowhere else. `--no-modify-path` means the user's shell still will not
 * find `elan`; `toolBinary()` is why nothing in lax needs it to.
 */
async function elanCheck(block: LoadingBlock, key: string, dry: boolean): Promise<Check> {
  // The elan under `elanHome()` and no other: `toolchainDir()` hangs off it, so
  // an elan somewhere else on PATH is one whose toolchains lax would never find
  // — the very state the lake check below reports as "no elan to provide it".
  const elanBin = path.join(elanHome(), "bin", "elan");
  const present = fs.existsSync(elanBin);
  if (!present && dry) {
    return { name: "elan", status: "fail", detail: `none at ${elanBin}`, fix: WOULD_INSTALL };
  }
  if (!present) {
    block.relabel(key, "elan — installing it, which takes a moment the first time");
    block.begin(key);
    const install = await installElan(elanBin, { echo: false });
    block.relabel(key, "elan");
    if (!install.ok) {
      return { name: "elan", status: "fail", detail: install.reason, fix: installHint("elan") };
    }
  }
  const version = await toolVersionAt(elanBin);
  if (version === undefined) {
    return {
      name: "elan",
      status: "fail",
      detail: `${elanBin} does not run`,
      fix: installHint("elan"),
    };
  }
  return {
    name: "elan",
    status: "ok",
    detail: present ? version : `${version} — installed just now at ${elanBin}`,
  };
}

/**
 * The lake that `lax build` actually runs, plus the install that provisions it.
 *
 * A bare `lake --version` goes through elan's shim, which has to resolve *some*
 * toolchain: with no `lean-toolchain` file in scope it takes `elan default`
 * (`stable`) and downloads that — a toolchain no lax build ever touches, while
 * the pinned one stays missing. The real pipeline never goes near the shims; it
 * puts the pinned toolchain's bin first on PATH (leanenv.ts) and runs those
 * binaries directly, so that is the lake worth reporting, and the pinned
 * toolchain is the one worth installing.
 */
async function lakeCheck(block: LoadingBlock, key: string, dry: boolean): Promise<Check> {
  const elanBin = path.join(elanHome(), "bin", "elan");
  if (!fs.existsSync(elanBin)) {
    return {
      name: "lake",
      status: "fail",
      detail: "no elan to provide it",
      fix: dry ? WOULD_INSTALL : installHint("elan"),
    };
  }
  if (!fs.existsSync(path.join(toolchainBinDir(), "lean")) && dry) {
    return {
      name: "lake",
      status: "fail",
      detail: `${LEAN_TOOLCHAIN} is not installed`,
      fix: WOULD_INSTALL,
    };
  }
  if (!fs.existsSync(path.join(toolchainBinDir(), "lean"))) {
    block.relabel(key, `lake — installing ${LEAN_TOOLCHAIN}, which takes minutes the first time`);
    block.begin(key);
    const install = await run(elanBin, ["toolchain", "install", LEAN_TOOLCHAIN], os.homedir(), {
      echo: false,
    });
    block.relabel(key, "lake");
    if (install.code !== 0) {
      return {
        name: "lake",
        status: "fail",
        detail: `could not install ${LEAN_TOOLCHAIN} (exit ${install.code})`,
        fix: `run \`elan toolchain install ${LEAN_TOOLCHAIN}\` to see the full transcript`,
      };
    }
  }
  const version = await toolVersionAt(path.join(toolchainBinDir(), "lake"));
  return version === undefined
    ? {
        name: "lake",
        status: "fail",
        detail: `${LEAN_TOOLCHAIN} has no working lake`,
        fix: `reinstall it: \`elan toolchain uninstall ${LEAN_TOOLCHAIN}\` then \`lax doctor\``,
      }
    : { name: "lake", status: "ok", detail: version };
}

async function toolVersionAt(bin: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(bin, ["--version"], { encoding: "utf8" });
    return stdout.split("\n")[0]!.trim();
  } catch {
    return undefined;
  }
}

/**
 * Every check runs concurrently and spins on its own line until it answers.
 * The probes behind them (two GitHub calls, `git ls-remote`, statfs, a
 * `git ls-files` per submission, an elan bootstrap, and a `lake --version` that
 * can have elan install a whole toolchain) add up to minutes in the worst case;
 * running them in sequence made that the sum rather than the maximum, and a
 * report that only printed on completion made the wait look like a hang.
 *
 * The one ordering that has to survive the concurrency is the Lean chain, and
 * it is a chain because each link provisions the next: the elan check installs
 * elan, `lake --version` then has it install the pinned toolchain, the check
 * that only reads the installed state follows, and the warm mathlib store —
 * which that toolchain builds — comes last.
 *
 * `dry` turns all of that off: the five checks that write something — elan, the
 * toolchain, the warm store, the database clone, and the credentials refresh
 * behind `github auth` — report the gap and its fix instead of closing it.
 * Nothing else here ever wrote, so a dry run leaves the machine byte-for-byte
 * as it found it, and the report is otherwise the same report. It still exits 1
 * on a ✗, which is what makes it usable as a check in a script.
 */
export async function doctor(opts: { dry?: boolean } = {}): Promise<number> {
  const dry = opts.dry === true;
  const checks: Check[] = [];
  const block = new LoadingBlock(process.stdout, { indent: "  " });
  const settle = (key: string, ...found: Array<Check | undefined>): void => {
    const lines: string[] = [];
    for (const check of found) {
      if (check === undefined) continue;
      checks.push(check);
      lines.push(`  ${MARK[check.status]} ${check.name}: ${check.detail}`);
      if (check.fix !== undefined && check.status !== "ok") lines.push(`      → ${check.fix}`);
    }
    block.settle(key, lines);
  };

  const submissions = registeredSubmissions();
  // Declared in report order; they settle in whatever order they finish.
  const keys = [
    "platform", "node", "git", "npm", "elan", "lake", "github auth",
    "database clone", "lean toolchain", "mathlib store", "website renderer", "disk",
  ];
  for (const key of keys) block.add(key, key);
  if (submissions.length > 0) {
    block.add("submissions", submissions.length === 1 ? "1 submission" : `${submissions.length} submissions`);
  }
  // The Lean chain is the one part that cannot fan out, so say what each of
  // its rows is queued behind rather than spinning as if it were working.
  block.waiting("lake", "waiting for elan");
  block.waiting("lean toolchain", "waiting for lake");
  block.waiting("mathlib store", "waiting for lake");

  if (dry) console.log("lax doctor: --dry — reporting only; nothing is installed or refreshed");
  const ticker = setInterval(() => { block.render(); }, 100);
  try {
    settle("platform", platformCheck());
    settle("node", nodeCheck());
    settle("website renderer", pageBuilderCheck());
    await Promise.all([
      (async () => { settle("git", await toolCheck("git")); })(),
      (async () => { settle("npm", await toolCheck("npm")); })(),
      (async () => {
        block.begin("elan");
        settle("elan", await elanCheck(block, "elan", dry));
        block.begin("lake");
        settle("lake", await lakeCheck(block, "lake", dry));
        // Only now does this read a settled state: while the toolchain was
        // installing it would have reported the half-built directory elan is
        // in the middle of creating.
        settle("lean toolchain", toolchainCheck());
        // Last, and behind the toolchain it builds with: the store is the one
        // check that can run for tens of minutes.
        settle("mathlib store", await warmStoreCheck(block, "mathlib store", dry));
      })(),
      (async () => { settle("github auth", await githubCheck(dry)); })(),
      (async () => { settle("database clone", await databaseCheck(block, "database clone", dry)); })(),
      (async () => { settle("disk", await diskCheck()); })(),
      (async () => {
        if (submissions.length === 0) return;
        let done = 0;
        const found = await pooled(submissions, 4, async (root) => {
          const check = await submissionCheck(root);
          done += 1;
          block.progress("submissions", `${done}/${submissions.length}`);
          return check;
        });
        settle("submissions", ...found);
      })(),
    ]);
  } finally {
    clearInterval(ticker);
    block.finish();
  }

  const failures = checks.filter((check) => check.status === "fail").length;
  if (failures > 0) {
    console.error(`lax doctor: ${failures} problem${failures === 1 ? "" : "s"} found`);
    return 1;
  }
  console.log(
    checks.some((check) => check.status === "warn")
      ? "lax doctor: ready (notes above)"
      : "lax doctor: everything is ready",
  );
  return 0;
}

function platformCheck(): Check {
  const platform = os.platform();
  return platform === "linux" || platform === "darwin"
    ? { name: "platform", status: "ok", detail: platform }
    : { name: "platform", status: "fail", detail: platform, fix: "use Linux, macOS, or WSL" };
}

function nodeCheck(): Check {
  const major = Number(process.versions.node.split(".")[0]);
  return {
    name: "node",
    status: major >= 20 ? "ok" : "fail",
    detail: `v${process.versions.node}`,
    ...(major >= 20 ? {} : { fix: "install Node.js 20 or newer — https://nodejs.org" }),
  };
}

async function toolCheck(tool: string): Promise<Check> {
  const version = await toolVersionAsync(tool);
  return version === undefined
    ? { name: tool, status: "fail", detail: "not found", fix: installHint(tool) }
    : { name: tool, status: "ok", detail: version };
}

/** Run `limit` of `items` at a time — a long registry should not put a
 * `git ls-files` per submission on the machine at once. */
async function pooled<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await run(items[index]!);
      }
    }),
  );
  return results;
}

/** Filesystem capacity is best-effort: an unreadable mount reports nothing. */
async function diskCheck(): Promise<Check | undefined> {
  try {
    const target = fs.existsSync(laxHome()) ? laxHome() : os.homedir();
    const stats = await fs.promises.statfs(target);
    const free = (stats.bavail * stats.bsize) / 2 ** 30;
    return {
      name: "disk",
      status: free < 10 ? "warn" : "ok",
      detail: `${free.toFixed(0)} GB free at ${target}`,
      ...(free < 10 ? { fix: "the validation runtime and Lean build need roughly 10 GB free" } : {}),
    };
  } catch {
    return undefined;
  }
}

async function githubCheck(dry: boolean): Promise<Check> {
  let token: string;
  try {
    // A refresh is a change on both sides — a new credentials.json here and a
    // rotated `ghr_` on GitHub, which invalidates the one on disk — so --dry
    // reads the stored token and reports rather than renewing it. The GETs
    // below stay: reading GitHub changes nothing.
    token = await githubAppUserToken({ refresh: !dry });
  } catch (error) {
    // Not every failure here is a missing login — a stored login whose refresh
    // GitHub answers with a 500 also lands here, and "no login found" would
    // send the author off to re-run `lax login` for an outage.
    return {
      name: "github auth",
      status: "fail",
      detail: error instanceof Error ? error.message : "no login found",
      fix: "run `lax login`",
    };
  }
  const source =
    process.env.LAX_GITHUB_APP_USER_TOKEN !== undefined
      ? "LAX_GITHUB_APP_USER_TOKEN"
      : credentialsFile();
  try {
    const github = GitHubClient.forGitHubAppUser(token);
    const user = await github.request<{ login: string }>(
      "GET",
      "/user",
      undefined,
      { timeoutMs: 10_000 },
    );
    try {
      await github.request(
        "GET",
        `${repositoryPath(CONTROL_REPOSITORY)}/issues?per_page=1`,
        undefined,
        { timeoutMs: 10_000 },
      );
    } catch (error) {
      if (error instanceof GitHubError && (error.status === 403 || error.status === 404)) {
        return {
          name: "github auth",
          status: "fail",
          detail: `credentials do not authorize the current ${CONTROL_REPOSITORY} repository`,
          fix: "run `lax logout`, `lax update`, then `lax login` again",
        };
      }
      throw error;
    }
    const client =
      process.env.LAX_GITHUB_APP_USER_TOKEN !== undefined
        ? "environment App token"
        : `GitHub App ${readGitHubAppCredentials().clientId}`;
    return { name: "github auth", status: "ok", detail: `${user.login} (${client}; ${source})` };
  } catch (error) {
    return error instanceof GitHubError && (error.status === 401 || error.status === 403)
      ? {
          name: "github auth",
          status: "fail",
          detail: `GitHub rejected the token from ${source}`,
          fix: "run `lax login` again",
        }
      : {
          name: "github auth",
          status: "warn",
          detail: `token found at ${source}; GitHub could not be reached`,
        };
  }
}

/** Doctor does not just report the clone's age, it brings it up to date — a
 * stale database is a problem doctor can simply end, and every local build and
 * `lax serve` reads it. Only a checkout it must not touch, or an unreachable
 * remote, comes back as a note. */
async function databaseCheck(block: LoadingBlock, key: string, dry: boolean): Promise<Check> {
  const directory = databaseDirectory();
  const cloning = !fs.existsSync(path.join(directory, ".git"));
  if (dry) {
    // Reporting what is on disk is all a read-only run can honestly say: the
    // clone's freshness is a question only a fetch answers, and a fetch writes.
    return cloning
      ? {
          name: "database clone",
          status: "warn",
          detail: `none at ${directory}`,
          fix: "run `lax pull-db` (or `lax doctor` without --dry) to clone it",
        }
      : {
          name: "database clone",
          status: "ok",
          detail: `${directory} (not refreshed — --dry)`,
        };
  }
  block.relabel(key, cloning ? "database clone — cloning lax-database" : "database clone — updating");
  const update = await updateDatabaseQuietly();
  block.relabel(key, "database clone");
  if (update.status === "invalid") return {
    name: "database clone",
    status: "warn",
    detail: `${directory} is not a usable git clone`,
    fix: "move it aside and run `lax pull-db`",
  };
  if (update.status === "failed") return {
    name: "database clone",
    status: "warn",
    detail: cloning
      ? `none at ${directory}; lax-database could not be cloned`
      : `${directory} (left as it is — lax-database could not be reached)`,
    ...(cloning ? { fix: "run `lax pull-db` once you are online" } : {}),
  };
  const detail: Record<typeof update.status, string> = {
    cloned: "cloned just now",
    updated: "updated just now",
    current: "up to date",
  };
  return { name: "database clone", status: "ok", detail: `${directory} (${detail[update.status]})` };
}

function toolchainCheck(): Check {
  const binDir = toolchainBinDir();
  return fs.existsSync(binDir)
    ? { name: "lean toolchain", status: "ok", detail: `${LEAN_TOOLCHAIN} at ${binDir}` }
    : {
        name: "lean toolchain",
        status: "warn",
        detail: `${LEAN_TOOLCHAIN} is not installed yet`,
        fix: "elan installs it automatically on the first `lax build`",
      };
}

/**
 * The warm mathlib workspace, plus the build that provisions it.
 *
 * The last piece of the machine doctor only reported: `npm i -g lax-archive
 * && lax doctor` installed elan, the toolchain and the database clone, then
 * left the largest and slowest dependency to whichever `lax init` or `lax
 * build` came first — a setup that exits 0 on a machine that still cannot
 * build anything, with the gap reported as a note rather than a gap. Building
 * it here is what makes those two commands the whole setup they claim to be.
 *
 * It is also the one check that costs tens of minutes and gigabytes, so it
 * stays last in the Lean chain, and it reports its stage on the spinner row
 * instead of through the store's own console notices, which would scribble
 * over the live block.
 */
async function warmStoreCheck(block: LoadingBlock, key: string, dry: boolean): Promise<Check> {
  const ws = warmDir();
  if (warmReady(ws)) return { name: "mathlib store", status: "ok", detail: ws };
  if (dry) {
    return { name: "mathlib store", status: "fail", detail: `none at ${ws}`, fix: WOULD_INSTALL };
  }
  // Nothing to build it with: the lake check above already reported that gap
  // and its fix, so this row names the dependency rather than spending a
  // gigabyte download on a `lake` that is missing or, worse, some other
  // elan's shim resolving a toolchain no lax build uses.
  if (!fs.existsSync(path.join(toolchainBinDir(), "lean"))) {
    return {
      name: "mathlib store",
      status: "fail",
      detail: `none at ${ws}; no ${LEAN_TOOLCHAIN} to build it with`,
      fix: "close the lake problem above, then run `lax doctor` again",
    };
  }
  block.begin(key);
  const warm = await ensureLocalWarm({
    echo: false,
    onStage: (stage) => {
      block.relabel(
        key,
        stage === "building"
          ? "mathlib store — downloading and building mathlib, tens of minutes the first time"
          : "mathlib store — sealing the store read-only, a few quiet minutes",
      );
    },
  });
  block.relabel(key, "mathlib store");
  return warm === undefined
    ? {
        name: "mathlib store",
        status: "fail",
        detail: `could not be built at ${ws}`,
        fix:
          "usually the network or free disk (the store needs roughly 10 GB); rerun `lax doctor`, " +
          "or `lax build --build-from-source` to compile mathlib locally instead",
      }
    : { name: "mathlib store", status: "ok", detail: `${ws} — built just now` };
}

function pageBuilderCheck(): Check {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "vendor", "page-builder"),
    path.resolve(here, "..", "..", ".build", "page-builder", "source"),
  ];
  const root = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "dist", "sitegen", "generate.js")),
  );
  return root === undefined
    ? {
        name: "website renderer",
        status: "fail",
        detail: "the pinned lax-website bundle is missing",
        fix: "reinstall the CLI package",
      }
    : { name: "website renderer", status: "ok", detail: root };
}

/**
 * Local-only health of one registered submission (`lax init`/`lax build`
 * record them; see registry.ts): pins, seeded Lake files, hardlink-farm-era
 * leftovers, and git hygiene. Deliberately no network and no subprocess
 * beyond a local `git ls-files`, so a long registry cannot stall the report.
 */
async function submissionCheck(root: string): Promise<Check> {
  const name = `submission ${path.basename(root)}`;
  const problems: string[] = [];
  const fixes = new Set<string>();
  try {
    issueNumberFromFolder(root);
  } catch {
    problems.push("manifest.yaml is missing a valid lax-N id");
  }
  for (const kind of ["concepts", "proofs"] as const) {
    const pkg = path.join(root, kind);
    if (!fs.existsSync(path.join(pkg, "lakefile.toml"))) {
      problems.push(`${kind}/lakefile.toml is missing`);
      continue;
    }
    const toolchain = tryRead(path.join(pkg, "lean-toolchain"))?.trim();
    if (toolchain !== LEAN_TOOLCHAIN) {
      problems.push(`${kind}/lean-toolchain is ${toolchain ?? "missing"} (pins want ${LEAN_TOOLCHAIN})`);
      fixes.add("update the toolchain and mathlib pins to the current archive pins");
    }
    if (tryRead(path.join(pkg, "lakefile.toml"))?.includes(MATHLIB_REV) !== true) {
      problems.push(`${kind}/lakefile.toml pins a different mathlib than the archive`);
      fixes.add("update the toolchain and mathlib pins to the current archive pins");
    }
    // The seeded overrides are what keeps a bare `lake build` from cloning
    // mathlib; validate their targets so a pin bump (new warm store) or a
    // deleted store surfaces here instead of as a surprise download.
    const overrides = tryRead(path.join(pkg, ".lake", "package-overrides.json"));
    let overrideNames: string[] = [];
    if (overrides === undefined) {
      problems.push(`${kind}/ has no package overrides — a bare \`lake build\` would download mathlib`);
      fixes.add("run `lax build`");
    } else {
      try {
        const parsed = JSON.parse(overrides) as { packages: Array<{ name: string; dir: string }> };
        overrideNames = parsed.packages.map((pkgEntry) => pkgEntry.name);
        // Lake resolves a relative override dir against the package root, so
        // probe it the same way: our own entries are absolute, but an author
        // may add a relative one (it then survives the package being copied),
        // and probing that against the process cwd invents dead entries.
        const dead = parsed.packages
          .map((pkgEntry) => ({ ...pkgEntry, dir: path.resolve(pkg, pkgEntry.dir) }))
          .filter((pkgEntry) => !fs.existsSync(pkgEntry.dir));
        // A warm store is `<warm root>/<pins>/.lake/packages/<name>`, so the
        // store of a dead entry is three levels up. Only entries below the
        // warm root are ours to blame on a pin bump or a deleted store.
        const warmRoot = path.dirname(warmDir());
        const stores = new Set(
          dead
            .filter((pkgEntry) => pkgEntry.dir.startsWith(warmRoot + path.sep))
            .map((pkgEntry) => path.dirname(path.dirname(path.dirname(pkgEntry.dir)))),
        );
        if (stores.size > 0) {
          problems.push(`${kind}/ package overrides point at a missing mathlib store (${[...stores].join(", ")})`);
          fixes.add("run `lax build`");
        }
        const strays = dead.filter((pkgEntry) => !pkgEntry.dir.startsWith(warmRoot + path.sep));
        if (strays.length > 0) {
          // Not a `lax build` problem — that regenerates the file from the
          // pins alone and would silently drop the entry instead of fixing it.
          problems.push(
            `${kind}/ package overrides point at missing folders (${strays.map((pkgEntry) => `${pkgEntry.name} → ${pkgEntry.dir}`).join(", ")})`,
          );
          fixes.add("point each listed override at an existing folder, or delete the entry");
        }
      } catch {
        problems.push(`${kind}/ package overrides are not valid JSON`);
        fixes.add("run `lax build`");
      }
    }
    const packagesDir = path.join(pkg, ".lake", "packages");
    const staleNames = (overrideNames.length > 0 ? overrideNames : ["mathlib"]).filter((dep) =>
      fs.existsSync(path.join(packagesDir, dep)),
    );
    if (staleNames.length > 0 || fs.existsSync(path.join(packagesDir, ".lax-warm-generation"))) {
      problems.push(
        `${kind}/.lake/packages holds mathlib-closure clones from the pre-overrides era (${staleNames.join(", ") || ".lax-warm-generation"})`,
      );
      fixes.add("delete the listed clones — the overrides make them dead weight");
    }
  }
  for (const tracked of await trackedGeneratedFiles(root)) {
    problems.push(`${tracked} is tracked in git but must stay generated`);
    fixes.add("`git rm --cached` it and add it to .gitignore");
  }
  if (problems.length === 0) return { name, status: "ok", detail: root };
  return {
    name,
    status: "warn",
    detail: problems.join("; "),
    fix: [...fixes].join("; "),
  };
}

function tryRead(filename: string): string | undefined {
  try {
    return fs.readFileSync(filename, "utf8");
  } catch {
    return undefined;
  }
}

/** Generated Lake files git-tracked under the submission — static validation
 * rejects them at submission time, so doctor flags them early. Best-effort:
 * outside a git repository there is nothing to check. */
async function trackedGeneratedFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files"], {
      cwd: root,
      encoding: "utf8",
    });
    return stdout
      .split("\n")
      .filter((line) =>
        /(^|\/)(lake-manifest\.json|package-overrides\.json|build-output\.json)$/.test(line) ||
        /(^|\/)\.lake\//.test(line),
      );
  } catch {
    return [];
  }
}

export function installHint(tool: string): string {
  if (tool === "git")
    return "install git (macOS: `xcode-select --install`; Debian/Ubuntu: `apt install git`)";
  if (tool === "docker") return "install and start Docker — https://docs.docker.com/get-docker/";
  if (tool === "npm") return "npm ships with Node.js 20 or newer — https://nodejs.org";
  if (tool === "elan" || tool === "lake")
    return "install elan (ships lake) — https://leanprover-community.github.io/get_started.html";
  return `install ${tool} and make it available on PATH`;
}
