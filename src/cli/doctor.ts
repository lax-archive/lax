import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GitHubClient, GitHubError } from "../shared/github.js";
import { configuredRuntime } from "../submission-validation/config.js";
import { credentialsFile, githubAppUserToken, laxHome, readGitHubAppCredentials } from "./auth.js";
import { databaseDirectory, databaseFreshness } from "./database.js";

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

export async function doctor(): Promise<number> {
  const checks: Check[] = [];
  const platform = os.platform();
  checks.push(
    platform === "linux" || platform === "darwin"
      ? { name: "platform", status: "ok", detail: platform }
      : {
          name: "platform",
          status: "fail",
          detail: platform,
          fix: "use Linux, macOS, or WSL",
        },
  );

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "node",
    status: nodeMajor >= 20 ? "ok" : "fail",
    detail: `v${process.versions.node}`,
    ...(nodeMajor >= 20 ? {} : { fix: "install Node.js 20 or newer — https://nodejs.org" }),
  });
  for (const tool of ["git", "npm"] as const) {
    const version = toolVersion(tool);
    checks.push(
      version === undefined
        ? { name: tool, status: "fail", detail: "not found", fix: installHint(tool) }
        : { name: tool, status: "ok", detail: version },
    );
  }

  const dockerVersion = toolVersion("docker");
  if (dockerVersion === undefined) {
    checks.push({
      name: "docker",
      status: "fail",
      detail: "not found",
      fix: "install and start Docker; `lax build` uses the pinned validation runtime",
    });
  } else {
    try {
      const server = execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      }).trim();
      checks.push({ name: "docker", status: "ok", detail: `${dockerVersion}; server ${server}` });
    } catch {
      checks.push({
        name: "docker",
        status: "fail",
        detail: `${dockerVersion}; daemon is unavailable`,
        fix: "start Docker",
      });
    }
  }

  checks.push(await githubCheck());
  checks.push(databaseCheck());
  checks.push(runtimeCheck(dockerVersion !== undefined));
  checks.push(pageBuilderCheck());
  try {
    const target = fs.existsSync(laxHome()) ? laxHome() : os.homedir();
    const stats = fs.statfsSync(target);
    const free = (stats.bavail * stats.bsize) / 2 ** 30;
    checks.push({
      name: "disk",
      status: free < 10 ? "warn" : "ok",
      detail: `${free.toFixed(0)} GB free at ${target}`,
      ...(free < 10 ? { fix: "the validation runtime and Lean build need roughly 10 GB free" } : {}),
    });
  } catch {
    // Filesystem capacity is best-effort.
  }

  const mark = { ok: "✓", warn: "!", fail: "✗" } as const;
  for (const check of checks) {
    console.log(`  ${mark[check.status]} ${check.name}: ${check.detail}`);
    if (check.fix !== undefined && check.status !== "ok") console.log(`      → ${check.fix}`);
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
    const user = await GitHubClient.forGitHubAppUser(token).request<{ login: string }>(
      "GET",
      "/user",
      undefined,
      { timeoutMs: 10_000 },
    );
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
    fix: "run `lax update-db` before building or serving",
  };
  if (freshness.status === "invalid") return {
    name: "database clone",
    status: "warn",
    detail: `${directory} is not a usable git clone`,
    fix: "move it aside and run `lax update-db`",
  };
  if (freshness.status === "stale") return {
    name: "database clone",
    status: "warn",
    detail: `${directory} is behind lax-database`,
    fix: "run `lax update-db`",
  };
  if (freshness.status === "unreachable") return {
    name: "database clone",
    status: "warn",
    detail: `${directory} (freshness not verified — GitHub unreachable)`,
  };
  return { name: "database clone", status: "ok", detail: `${directory} (up to date)` };
}

function runtimeCheck(dockerPresent: boolean): Check {
  let runtime;
  try {
    runtime = configuredRuntime();
  } catch (error) {
    return {
      name: "validation runtime",
      status: "fail",
      detail: (error as Error).message,
      fix:
        "set LAX_VALIDATION_IMAGE to the published immutable @sha256 image, or run " +
        "`lax build --build-from-source`",
    };
  }
  if (!dockerPresent) {
    return { name: "validation runtime", status: "warn", detail: runtime.image };
  }
  try {
    execFileSync("docker", ["image", "inspect", runtime.image], {
      stdio: "ignore",
      timeout: 10_000,
    });
    return { name: "validation runtime", status: "ok", detail: runtime.image };
  } catch {
    return {
      name: "validation runtime",
      status: "warn",
      detail: `${runtime.image} is not downloaded`,
      fix: `run \`docker pull ${runtime.image}\``,
    };
  }
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

export function installHint(tool: string): string {
  if (tool === "git")
    return "install git (macOS: `xcode-select --install`; Debian/Ubuntu: `apt install git`)";
  if (tool === "docker") return "install and start Docker — https://docs.docker.com/get-docker/";
  if (tool === "npm") return "npm ships with Node.js 20 or newer — https://nodejs.org";
  return `install ${tool} and make it available on PATH`;
}
