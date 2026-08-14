import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
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
import { issueNumberFromFolder } from "./manifest.js";
import { registeredSubmissions } from "./registry.js";
import * as ui from "./ui.js";
import { websiteRendererIsReady } from "./website-renderer.js";

const execFileAsync = promisify(execFile);

/**
 * One probe's answer, in the shape a row is built from.
 *
 * `label` is what the author calls the thing, not what we call the check: a
 * check that only ever appears when it is broken is read by whoever has to fix
 * it. `fact` is the opposite — the words a healthy check contributes to the row
 * it shares with its group, where its own name is not worth a line.
 */
interface Check {
  label: string;
  status: ui.Status;
  /** The one line the author reads first. */
  detail: string;
  /** Anything else that had to be said, a line each under the detail. */
  more?: readonly string[];
  /** The imperative, a line each. Commands in backticks come out bold. */
  fix?: readonly string[];
  /** What the collapsed group row shows for this check while it passes. */
  fact?: string;
  /** The path, id or client behind the check: a `--verbose` concern. */
  internal?: string;
}

/** doctor's labels are one word each — `Lax`, `Account`, `lax-50` — so its
 * details sit further left than a command report's. */
const LABEL_WIDTH = 20;

/** `v4.30.0` out of `leanprover/lean4:v4.30.0`: the pin as the author reads it. */
const TOOLCHAIN_VERSION = LEAN_TOOLCHAIN.slice(LEAN_TOOLCHAIN.indexOf(":") + 1);

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

/** The fix line for a gap `--dry` reported instead of closing. */
const WOULD_INSTALL = "run `lax doctor` without --dry to install it";

/**
 * The version the author would put in a bug report, read the way main.ts reads
 * it. Best-effort: a package.json we cannot read is not a problem with the
 * machine, and the rest of the row is still worth printing.
 */
function cliVersion(): string | undefined {
  try {
    const pkg = createRequire(import.meta.url)("../../package.json") as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}

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
async function elanCheck(dry: boolean, working: (text: string) => void): Promise<Check> {
  // The elan under `elanHome()` and no other: `toolchainDir()` hangs off it, so
  // an elan somewhere else on PATH is one whose toolchains lax would never find
  // — the very state the lake check below reports as "no elan to provide it".
  const elanBin = path.join(elanHome(), "bin", "elan");
  const present = fs.existsSync(elanBin);
  if (!present && dry) {
    return {
      label: "elan",
      status: "fail",
      detail: `nothing at ${ui.tilde(elanBin)}`,
      fix: [WOULD_INSTALL],
    };
  }
  if (!present) {
    working("installing elan, a moment the first time");
    const install = await installElan(elanBin, { echo: false });
    if (!install.ok) {
      return { label: "elan", status: "fail", detail: install.reason, fix: [installHint("elan")] };
    }
  }
  const version = await toolVersionAt(elanBin);
  if (version === undefined) {
    return {
      label: "elan",
      status: "fail",
      detail: `${ui.tilde(elanBin)} does not run`,
      fix: [installHint("elan")],
    };
  }
  return {
    label: "elan",
    status: "ok",
    detail: version,
    fact: shortElan(version),
    internal: `${version} at ${elanBin}`,
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
async function lakeCheck(dry: boolean, working: (text: string) => void): Promise<Check> {
  const elanBin = path.join(elanHome(), "bin", "elan");
  if (!fs.existsSync(elanBin)) {
    return {
      label: "Lake",
      status: "fail",
      detail: "no elan to provide it",
      fix: [dry ? WOULD_INSTALL : installHint("elan")],
    };
  }
  if (!fs.existsSync(path.join(toolchainBinDir(), "lean")) && dry) {
    return {
      label: "Lake",
      status: "fail",
      detail: `${TOOLCHAIN_VERSION} is not installed`,
      fix: [WOULD_INSTALL],
    };
  }
  if (!fs.existsSync(path.join(toolchainBinDir(), "lean"))) {
    working(`installing ${TOOLCHAIN_VERSION}, a few minutes the first time`);
    const install = await run(elanBin, ["toolchain", "install", LEAN_TOOLCHAIN], os.homedir(), {
      echo: false,
    });
    if (install.code !== 0) {
      return {
        label: "Lake",
        status: "fail",
        detail: `could not install ${TOOLCHAIN_VERSION} (exit ${install.code})`,
        fix: [`run \`elan toolchain install ${LEAN_TOOLCHAIN}\` to see the full transcript`],
      };
    }
  }
  const version = await toolVersionAt(path.join(toolchainBinDir(), "lake"));
  return version === undefined
    ? {
        label: "Lake",
        status: "fail",
        detail: `${TOOLCHAIN_VERSION} has no working lake`,
        fix: [`reinstall it: \`elan toolchain uninstall ${LEAN_TOOLCHAIN}\` then \`lax doctor\``],
      }
    : { label: "Lake", status: "ok", detail: version, fact: shortLake(version) };
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
 * `Lake version 5.0.0 (Lean version 4.30.0)` → `v4.30.0 · lake 5.0.0`: the two
 * numbers an author would compare against a pin, Lean's first because that is
 * the one they think in. A banner we do not recognise survives whole — a tool
 * that ran is a tool that ran, whatever it chose to print.
 */
function shortLake(raw: string): string {
  const lean = /Lean version ([^\s)]+)/u.exec(raw)?.[1];
  const lake = /Lake version (\S+)/u.exec(raw)?.[1];
  if (lean === undefined && lake === undefined) return raw;
  return [lean === undefined ? undefined : `v${lean}`, lake === undefined ? undefined : `lake ${lake}`]
    .filter((part) => part !== undefined)
    .join(" · ");
}

/** `elan 3.1.1 (a1b2c3d 2026-01-01)` → `elan 3.1.1`; same fallback. */
function shortElan(raw: string): string {
  const version = /^elan (\S+)/u.exec(raw)?.[1];
  return version === undefined ? raw : `elan ${version}`;
}

/**
 * Eight rows, plus one per registered submission, whatever the machine turns
 * out to be — and every probe behind them running at once.
 *
 * The probes (two GitHub calls, `git ls-remote`, statfs, a `git ls-files` per
 * submission, an elan bootstrap, and a `lake --version` that can have elan
 * install a whole toolchain) add up to minutes in the worst case; running them
 * in sequence made that the sum rather than the maximum, and a report that only
 * printed on completion made the wait look like a hang.
 *
 * The one ordering that has to survive the concurrency is the Lean chain, and
 * it is a chain because each link provisions the next: the elan check installs
 * elan, `lake --version` then has it install the pinned toolchain, the check
 * that only reads the installed state follows, and the warm mathlib store —
 * which that toolchain builds — comes last.
 *
 * `dry` turns all of that off: the five checks that write something — elan, the
 * toolchain, the mathlib store, the archive clone, and the credentials refresh
 * behind `Account` — report the gap and its fix instead of closing it. Nothing
 * else here ever wrote, so a dry run leaves the machine byte-for-byte as it
 * found it, and the report is otherwise the same report. It still exits 1 on a
 * ✗, which is what makes it usable as a check in a script.
 */
export async function doctor(opts: { dry?: boolean } = {}): Promise<number> {
  const dry = opts.dry === true;
  /** Every check the verdict counts and `--verbose` reports the internals of. */
  const found: Check[] = [];
  const record = (...checks: readonly Check[]): readonly Check[] => {
    found.push(...checks);
    return checks;
  };

  ui.title("Checking your setup");
  if (dry) {
    ui.faint("Reporting only — nothing is installed or refreshed.");
    ui.blank();
  }

  // The one command whose rows genuinely all run at once, so the one that
  // spins every row rather than only the row it is on.
  const steps = new ui.Steps({ labelWidth: LABEL_WIDTH, concurrent: true });
  const settle = (key: string, check: Check | undefined): void => {
    // A probe with nothing to say (an unreadable mount) leaves no row behind.
    if (check === undefined) {
      steps.settle(key, { hidden: true });
      return;
    }
    record(check);
    steps.settle(key, {
      label: check.label,
      status: check.status,
      detail: check.detail,
      under: underLines(check),
    });
  };

  // Declared in report order; they settle in whatever order they finish.
  steps.add("lax", "Lax");
  steps.add("lean", "Lean");
  steps.add("git", "Git");
  steps.add("account", "Account");
  steps.add("archive", "Archive");
  steps.add("mathlib", "Mathlib");
  steps.add("disk", "Disk");
  // The registry is known before any probing starts, so every submission gets
  // its row up front, under the id the author calls it by.
  const submissions = registeredSubmissions().map((root, index) => ({
    root,
    key: `submission:${index}`,
    label: submissionLabel(root),
  }));
  for (const submission of submissions) steps.add(submission.key, submission.label);
  // mathlib is the one row that genuinely queues behind another, so say what it
  // is waiting for rather than spinning as if it were working.
  steps.waiting("mathlib", "waiting for Lean");

  try {
    await Promise.all([
      (async () => {
        // Is the lax install healthy: four checks, one row, and npm the only one
        // of them the row has to wait for.
        const platform = platformCheck();
        const node = nodeCheck();
        const renderer = pageBuilderCheck();
        const npm = await toolCheck("npm", "npm");
        settleGroup(
          steps,
          "lax",
          [cliVersion(), factOf(node), factOf(platform)],
          record(platform, node, npm, renderer),
        );
      })(),
      (async () => {
        settle("git", await toolCheck("git", "Git", /^git version (\S+)/u));
      })(),
      (async () => {
        // The row's own detail while it provisions something, with its clock
        // restarted so the time on it measures that install rather than the
        // probes in front of it.
        const working = (text: string): void => {
          steps.begin("lean");
          steps.detail("lean", text);
        };
        const elan = await elanCheck(dry, working);
        const lake = await lakeCheck(dry, working);
        // Only now does this read a settled state: while the toolchain was
        // installing it would have reported the half-built directory elan is in
        // the middle of creating.
        const toolchain = toolchainCheck();
        // Every link runs — each one is what proves the link above it worked —
        // but the report stops at the first that broke: with no elan, "no elan
        // to provide it" and "the toolchain is not installed yet" are the same
        // sentence a second and a third time.
        const chain = [elan, lake, toolchain];
        const broken = chain.find((check) => check.status !== "ok");
        settleGroup(
          steps,
          "lean",
          [factOf(lake), factOf(elan)],
          record(...(broken === undefined ? chain : [broken])),
        );
        // Last, and behind the toolchain that builds it: the store is the one
        // check that can run for tens of minutes.
        steps.begin("mathlib");
        settle("mathlib", await warmStoreCheck(steps, dry));
      })(),
      (async () => {
        settle("account", await githubCheck(dry));
      })(),
      (async () => {
        settle(
          "archive",
          await databaseCheck(dry, (text) => {
            steps.detail("archive", text);
          }),
        );
      })(),
      (async () => {
        settle("disk", await diskCheck());
      })(),
      (async () => {
        await pooled(submissions, 4, async (submission) => {
          settle(submission.key, await submissionCheck(submission.root, submission.label));
        });
      })(),
    ]);
  } finally {
    steps.finish();
  }

  // The paths, ids and clients the rows deliberately left out, lined up under
  // the column the details were in — the same report with its internals put
  // back, in the order the answers arrived.
  const column = ui.detailColumn(LABEL_WIDTH).length - ui.INDENT.length;
  const internals = found.filter((check) => check.internal !== undefined);
  if (ui.isVerbose() && internals.length > 0) ui.blank();
  for (const check of internals) ui.verbose(`${check.label.padEnd(column)}${check.internal!}`);

  const problems = found.filter((check) => check.status === "fail").length;
  const notes = found.filter((check) => check.status === "warn").length;
  if (problems === 0 && notes === 0) {
    ui.verdict("Everything is ready.");
    ui.done();
    return 0;
  }
  // A count, not a sentence: the rows above already said what and how to fix it.
  ui.verdict(
    [
      ...(problems > 0 ? [ui.plural(problems, "problem")] : []),
      ...(notes > 0 ? [ui.plural(notes, "note")] : []),
    ].join(" · "),
  );
  ui.done();
  return problems > 0 ? 1 : 0;
}

/**
 * A row several checks share — `Lax` over platform/node/npm/renderer, `Lean`
 * over elan/lake/toolchain.
 *
 * "Is my lax install healthy" is one question from the author's side, so while
 * every check behind it passes the group is a single row carrying only the facts
 * worth seeing (`0.1.23 · node v22.11.0 · linux`). The first check that does not
 * pass takes the row over — its label, its status, its detail, its fix — because
 * a collapsed row can only ever mean "healthy"; anything else broken in the same
 * group follows on the lines below it, so a second, independent failure is never
 * swallowed by the first.
 */
function settleGroup(
  steps: ui.Steps,
  key: string,
  facts: readonly (string | undefined)[],
  checks: readonly Check[],
): void {
  // Problems before notes, so the row that stands in for the group carries the
  // worst mark in it.
  const broken = [
    ...checks.filter((check) => check.status === "fail"),
    ...checks.filter((check) => check.status === "warn"),
  ];
  const [first, ...rest] = broken;
  if (first === undefined) {
    const detail = facts.filter((fact) => fact !== undefined && fact !== "").join(" · ");
    steps.settle(key, detail === "" ? { hidden: true } : { detail });
    return;
  }
  steps.settle(key, {
    label: first.label,
    status: first.status,
    detail: first.detail,
    under: [
      ...underLines(first),
      ...rest.flatMap((check) => [`${check.label} · ${check.detail}`, ...underLines(check)]),
    ],
  });
}

function factOf(check: Check): string | undefined {
  return check.status === "ok" ? check.fact : undefined;
}

/**
 * What goes under a row: whatever else it had to say, then the fix. Commands
 * are bold rather than backticked — the author is meant to type them, and a
 * terminal has no code voice.
 */
function underLines(check: Check): readonly string[] {
  const fixes = check.status === "ok" ? [] : (check.fix ?? []);
  return [
    ...(check.more ?? []),
    ...fixes.map((fix) => `→ ${fix.replace(/`([^`]+)`/gu, (_, command: string) => ui.cmd(command))}`),
  ];
}

function platformCheck(): Check {
  const platform = os.platform();
  // The one place the whole environment is written down, for a bug report: the
  // rows themselves only carry it while the install is healthy.
  const internal = `lax ${cliVersion() ?? "unknown"} on node ${process.versions.node}, ${platform} ${os.arch()}`;
  return platform === "linux" || platform === "darwin"
    ? { label: "Platform", status: "ok", detail: platform, fact: platform, internal }
    : {
        label: "Platform",
        status: "fail",
        detail: platform,
        fix: ["use Linux, macOS, or WSL"],
        internal,
      };
}

function nodeCheck(): Check {
  const major = Number(process.versions.node.split(".")[0]);
  const version = `v${process.versions.node}`;
  return major >= 20
    ? { label: "Node", status: "ok", detail: version, fact: `node ${version}` }
    : {
        label: "Node",
        status: "fail",
        detail: version,
        fix: ["install Node.js 20 or newer — https://nodejs.org"],
      };
}

/** A tool lax runs by name. `shorten` cuts its `--version` banner down to the
 * number the author reads. */
async function toolCheck(tool: string, label: string, shorten?: RegExp): Promise<Check> {
  const version = await toolVersionAsync(tool);
  if (version === undefined) {
    return { label, status: "fail", detail: "not found", fix: [installHint(tool)] };
  }
  const short = shorten === undefined ? version : (shorten.exec(version)?.[1] ?? version);
  return { label, status: "ok", detail: short, fact: short };
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
      label: "Disk",
      status: free < 10 ? "warn" : "ok",
      detail: `${free.toFixed(0)} GB free`,
      ...(free < 10
        ? { fix: ["the validation runtime and Lean build need roughly 10 GB free"] }
        : {}),
      internal: `${free.toFixed(1)} GB free at ${target}`,
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
    // Not every failure here is a missing login — an expired one the CLI cannot
    // renew lands here too, and "no login found" would describe neither. The
    // messages carry their own "; run `lax login`" tail, which is the fix
    // line's job.
    // These messages are paragraphs — an outage explains itself — so the row
    // takes the first clause and the rest goes under it rather than off the
    // right edge of the terminal.
    const message = error instanceof Error ? error.message : "no login found";
    const [headline, ...rest] = message.replace(/;\s*run `[^`]+`.*$/u, "").split(" — ");
    return {
      label: "Account",
      status: "fail",
      detail: headline ?? message,
      more: rest,
      fix: ["run `lax login`"],
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
          label: "Account",
          status: "fail",
          detail: "these credentials are for a different archive",
          fix: ["run `lax logout`, `lax update`, then `lax login` again"],
        };
      }
      throw error;
    }
    const client =
      process.env.LAX_GITHUB_APP_USER_TOKEN !== undefined
        ? "environment App token"
        : `GitHub App ${readGitHubAppCredentials().clientId}`;
    return {
      label: "Account",
      status: "ok",
      detail: user.login,
      internal: `${user.login} (${client}; ${source})`,
    };
  } catch (error) {
    return error instanceof GitHubError && (error.status === 401 || error.status === 403)
      ? {
          label: "Account",
          status: "fail",
          detail: "GitHub rejected your login",
          fix: ["run `lax login` again"],
          internal: `the token came from ${source}`,
        }
      : {
          label: "Account",
          status: "warn",
          detail: "signed in; GitHub could not be reached",
          internal: `the token came from ${source}`,
        };
  }
}

/** Doctor does not just report the clone's age, it brings it up to date — a
 * stale archive is a problem doctor can simply end, and every local build and
 * `lax serve` reads it. Only a checkout it must not touch, or an unreachable
 * remote, comes back as a note. The path stays off the happy path: it is the
 * first thing said when something is wrong with it, and nothing when it is not. */
async function databaseCheck(dry: boolean, working: (text: string) => void): Promise<Check> {
  const directory = databaseDirectory();
  const where = ui.tilde(directory);
  const cloning = !fs.existsSync(path.join(directory, ".git"));
  if (dry) {
    // Reporting what is on disk is all a read-only run can honestly say: the
    // clone's freshness is a question only a fetch answers, and a fetch writes.
    return cloning
      ? {
          label: "Archive",
          status: "warn",
          detail: `none at ${where}`,
          fix: ["run `lax doctor` without --dry to download it"],
          internal: directory,
        }
      : {
          label: "Archive",
          status: "ok",
          detail: "not refreshed (--dry)",
          internal: directory,
        };
  }
  working(cloning ? "downloading" : "updating");
  const update = await updateDatabaseQuietly();
  if (update.status === "invalid") {
    return {
      label: "Archive",
      status: "warn",
      detail: `${where} is not a usable git clone`,
      fix: ["move it aside, then run `lax doctor` again"],
      internal: directory,
    };
  }
  if (update.status === "failed") {
    return {
      label: "Archive",
      status: "warn",
      detail: cloning
        ? `none at ${where} — the archive could not be reached`
        : `${where} left as it is — the archive could not be reached`,
      ...(cloning ? { fix: ["run `lax doctor` again once you are online"] } : {}),
      internal: `${directory}: ${update.detail}`,
    };
  }
  const detail: Record<typeof update.status, string> = {
    cloned: "cloned just now",
    updated: "updated just now",
    current: "up to date",
  };
  return { label: "Archive", status: "ok", detail: detail[update.status], internal: directory };
}

function toolchainCheck(): Check {
  const binDir = toolchainBinDir();
  return fs.existsSync(binDir)
    ? {
        label: "Lean toolchain",
        status: "ok",
        detail: TOOLCHAIN_VERSION,
        internal: `${LEAN_TOOLCHAIN} at ${binDir}`,
      }
    : {
        label: "Lean toolchain",
        status: "warn",
        detail: `${TOOLCHAIN_VERSION} is not installed yet`,
        fix: ["elan installs it automatically on the first `lax build`"],
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
 * stays last in the Lean chain, and it says which half of that it is in on its
 * own row rather than through the store's console notices, which would say it
 * in paragraphs over the top of the report.
 */
async function warmStoreCheck(steps: ui.Steps, dry: boolean): Promise<Check> {
  const ws = warmDir();
  if (warmReady(ws)) return { label: "Mathlib", status: "ok", detail: "ready", internal: ws };
  if (dry) {
    return {
      label: "Mathlib",
      status: "fail",
      detail: "not downloaded yet",
      fix: [WOULD_INSTALL],
      internal: ws,
    };
  }
  // Nothing to build it with: the Lean row above already reported that gap and
  // its fix, so this row names the dependency rather than spending a gigabyte
  // download on a `lake` that is missing or, worse, some other elan's shim
  // resolving a toolchain no lax build uses.
  if (!fs.existsSync(path.join(toolchainBinDir(), "lean"))) {
    return {
      label: "Mathlib",
      status: "fail",
      detail: `no ${TOOLCHAIN_VERSION} to build it with`,
      fix: ["close the Lean problem above, then run `lax doctor` again"],
      internal: ws,
    };
  }
  steps.begin("mathlib");
  const warm = await ensureLocalWarm({
    echo: false,
    onStage: (stage) => {
      steps.detail(
        "mathlib",
        stage === "building"
          ? "downloading and building mathlib, tens of minutes the first time"
          : "sealing the store read-only, a few quiet minutes",
      );
    },
  });
  return warm === undefined
    ? {
        label: "Mathlib",
        status: "fail",
        detail: "could not be built",
        fix: [
          "usually the network or free disk (the store needs roughly 10 GB);",
          "rerun `lax doctor`, or `lax build --build-from-source` to compile",
          "mathlib locally instead",
        ],
        internal: ws,
      }
    : { label: "Mathlib", status: "ok", detail: "built just now", internal: ws };
}

function pageBuilderCheck(): Check {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "vendor", "page-builder"),
    path.resolve(here, "..", "..", ".build", "page-builder", "source"),
  ];
  const root = candidates.find((candidate) => websiteRendererIsReady(candidate));
  return root === undefined
    ? {
        label: "Website renderer",
        status: "fail",
        detail: "the bundle that draws the pages is missing",
        fix: ["reinstall the CLI package"],
      }
    : { label: "Website renderer", status: "ok", detail: "ready", internal: root };
}

/** The id the author calls a registered folder by. A folder whose manifest has
 * lost its id still gets a row — the check behind it is the one that says so. */
function submissionLabel(root: string): string {
  try {
    return `lax-${issueNumberFromFolder(root)}`;
  } catch {
    return path.basename(root);
  }
}

/**
 * Local-only health of one registered submission (`lax init`/`lax build`
 * record them; see registry.ts): pins, seeded Lake files, hardlink-farm-era
 * leftovers, and git hygiene. Deliberately no network and no subprocess
 * beyond a local `git ls-files`, so a long registry cannot stall the report.
 */
async function submissionCheck(root: string, label: string): Promise<Check> {
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
  // A healthy submission is its folder and nothing else; a broken one leads with
  // its first problem and lists the rest under it, one to a line, because the
  // joined form ran to three hundred characters.
  if (problems.length === 0) {
    return { label, status: "ok", detail: ui.tilde(root), internal: root };
  }
  return {
    label,
    status: "warn",
    detail: problems[0]!,
    more: problems.slice(1),
    fix: [...fixes],
    internal: root,
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
