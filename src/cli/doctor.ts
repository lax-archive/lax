import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTROL_REPOSITORY } from "../shared/constants.js";
import { GitHubClient, GitHubError, repositoryPath } from "../shared/github.js";
import { toolchainBinDir } from "../submission-validation/host/leanenv.js";
import { warmDir, warmReady } from "../submission-validation/host/warmstore.js";
import { LEAN_TOOLCHAIN, MATHLIB_REV } from "../submission-validation/pins.js";
import { credentialsFile, githubAppUserToken, laxHome, readGitHubAppCredentials } from "./auth.js";
import { databaseDirectory, databaseFreshness } from "./database.js";
import { issueNumberFromFolder } from "./manifest.js";
import { registeredSubmissions } from "./registry.js";

interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  fix?: string;
}

export function toolVersion(tool: string): string | undefined {
  try {
    return execFileSync(tool, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).split("\n")[0]!.trim();
  } catch {
    return undefined;
  }
}

const MARK = { ok: "✓", warn: "!", fail: "✗" } as const;

/**
 * Every check is its own thunk and its line is printed the moment that check
 * returns: the probes behind them (docker, two GitHub calls, `git ls-remote`,
 * statfs) add up to a minute in the worst case, and buffering the report until
 * the end made the whole minute look like a hang.
 */
export async function doctor(): Promise<number> {
  const checks: Check[] = [];
  const emit = (check: Check | undefined): void => {
    if (check === undefined) return;
    checks.push(check);
    console.log(`  ${MARK[check.status]} ${check.name}: ${check.detail}`);
    if (check.fix !== undefined && check.status !== "ok") console.log(`      → ${check.fix}`);
  };

  emit(platformCheck());
  emit(nodeCheck());
  for (const tool of ["git", "npm", "elan", "lake"] as const) emit(toolCheck(tool));
  emit(await githubCheck());
  emit(databaseCheck());
  emit(toolchainCheck());
  emit(warmStoreCheck());
  emit(pageBuilderCheck());
  emit(diskCheck());
  for (const root of registeredSubmissions()) emit(submissionCheck(root));

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

function toolCheck(tool: string): Check {
  const version = toolVersion(tool);
  return version === undefined
    ? { name: tool, status: "fail", detail: "not found", fix: installHint(tool) }
    : { name: tool, status: "ok", detail: version };
}

/** Filesystem capacity is best-effort: an unreadable mount reports nothing. */
function diskCheck(): Check | undefined {
  try {
    const target = fs.existsSync(laxHome()) ? laxHome() : os.homedir();
    const stats = fs.statfsSync(target);
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

async function githubCheck(): Promise<Check> {
  let token: string;
  try {
    token = await githubAppUserToken();
  } catch {
    return {
      name: "github auth",
      status: "fail",
      detail: "no login found",
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

function databaseCheck(): Check {
  const directory = databaseDirectory();
  const freshness = databaseFreshness();
  if (freshness.status === "missing") return {
    name: "database clone",
    status: "warn",
    detail: `none at ${directory}`,
    fix: "run `lax pull-db` before building or serving",
  };
  if (freshness.status === "invalid") return {
    name: "database clone",
    status: "warn",
    detail: `${directory} is not a usable git clone`,
    fix: "move it aside and run `lax pull-db`",
  };
  if (freshness.status === "stale") return {
    name: "database clone",
    status: "warn",
    detail: `${directory} is behind lax-database`,
    fix: "run `lax pull-db`",
  };
  if (freshness.status === "unreachable") return {
    name: "database clone",
    status: "warn",
    detail: `${directory} (freshness not verified — GitHub unreachable)`,
  };
  return { name: "database clone", status: "ok", detail: `${directory} (up to date)` };
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

function warmStoreCheck(): Check {
  const ws = warmDir();
  return warmReady(ws)
    ? { name: "mathlib store", status: "ok", detail: ws }
    : {
        name: "mathlib store",
        status: "warn",
        detail: `none at ${ws}`,
        fix: "the first `lax build` builds it once (downloads gigabytes)",
      };
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
function submissionCheck(root: string): Check {
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
        const dead = parsed.packages.find((pkgEntry) => !fs.existsSync(pkgEntry.dir));
        if (dead !== undefined) {
          problems.push(`${kind}/ package overrides point at a missing mathlib store (${path.dirname(path.dirname(path.dirname(dead.dir)))})`);
          fixes.add("run `lax build`");
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
  for (const tracked of trackedGeneratedFiles(root)) {
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
function trackedGeneratedFiles(root: string): string[] {
  try {
    const listing = execFileSync("git", ["ls-files"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return listing
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
