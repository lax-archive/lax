// Trusted, host-side source fetching (ported from the deleted in-container
// runtime/fetch-source.mjs when the custom image died — the stock sandbox
// image carries no git, and fetching a *validated* canonical URL is a trusted
// pre-sandbox step anyway). Every check carries over: canonical
// https://github.com URL narrowing, full 40-hex commit, HOME isolation,
// https-only git protocol, and the rev-parse assertion that the checkout
// really is the requested immutable commit. The checkout is then inspected
// repo-wide: symlinks and non-regular entries are rejected before anything
// reads it.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ValidationLimits } from "../config.js";
import type { SourceLocation } from "../../shared/types.js";

export interface FetchedSource {
  repositoryRoot: string;
  submissionRoot: string;
}

/**
 * Fetch one commit of a public GitHub repository into `destination` with an
 * isolated git environment: no inherited HOME or git config, https protocol
 * only, no terminal prompts, and a final `rev-parse HEAD` equality assertion.
 */
export async function fetchGitCheckout(
  repository: string,
  commit: string,
  destination: string,
  timeoutMs: number,
): Promise<void> {
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("repository is not a canonical public GitHub URL");
  }
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("commit must be a full lowercase SHA");
  }
  if (!path.isAbsolute(destination) || destination === "/") {
    throw new Error("destination must be a specific absolute path");
  }
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  // an exact environment, not an overlay: nothing of the invoking user's git
  // identity, credential helpers, or config can influence the fetch
  const home = path.join(destination, "..", ".lax-fetch-home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    GIT_ALLOW_PROTOCOL: "https",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const deadline = Date.now() + timeoutMs;
  const git = (args: string[]): Promise<{ code: number; output: string }> =>
    runGit(args, destination, env, Math.max(1, deadline - Date.now()));

  if ((await git(["init", "--quiet"])).code !== 0) throw new Error("could not initialize the fetch workspace");
  if ((await git(["remote", "add", "origin", repository])).code !== 0) {
    throw new Error("could not configure the fetch remote");
  }
  let fetched = await git(["fetch", "--quiet", "--depth", "1", "origin", commit]);
  if (fetched.code !== 0) fetched = await git(["fetch", "--quiet", "--depth", "1", "origin"]);
  if (fetched.code !== 0) {
    throw new Error("repository or commit could not be fetched anonymously");
  }
  if ((await git(["-c", "advice.detachedHead=false", "checkout", "--quiet", commit])).code !== 0) {
    throw new Error("requested commit is not present in the fetched repository");
  }
  const resolved = await git(["rev-parse", "HEAD"]);
  if (resolved.code !== 0 || resolved.output.trim() !== commit) {
    throw new Error("checkout did not resolve to the requested immutable commit");
  }
}

function runGit(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const sink = (chunk: Buffer): void => {
      if (output.length < 1024 * 1024) output += chunk.toString("utf8");
    };
    child.stdout.on("data", sink);
    child.stderr.on("data", sink);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) resolve({ code: 124, output: `${output}\n[fetch timed out]` });
      else resolve({ code: code ?? 1, output });
    });
  });
}

export async function fetchSource(
  source: SourceLocation,
  jobDir: string,
  limits: ValidationLimits,
): Promise<FetchedSource> {
  const repositoryRoot = path.join(jobDir, "source");
  await fetchGitCheckout(source.repository, source.commit, repositoryRoot, limits.fetchTimeoutMs);
  const submissionRoot = containedDirectory(repositoryRoot, source.folder);
  inspectCheckout(repositoryRoot);
  return { repositoryRoot: fs.realpathSync(repositoryRoot), submissionRoot };
}

export function containedDirectory(base: string, folder: string): string {
  const baseReal = fs.realpathSync(base);
  const lexical = path.resolve(baseReal, folder);
  if (lexical !== baseReal && !lexical.startsWith(`${baseReal}${path.sep}`)) {
    throw new Error("submission folder escapes the repository");
  }
  let real: string;
  try {
    real = fs.realpathSync(lexical);
  } catch {
    throw new Error(`repository has no submission folder ${folder}`);
  }
  if (real !== lexical || !fs.statSync(real).isDirectory()) {
    throw new Error("submission folder must be a plain directory and may not traverse a symlink");
  }
  return real;
}

function inspectCheckout(root: string): void {
  const maxFiles = 100_000;
  const maxBytes = 2 * 1024 * 1024 * 1024;
  let files = 0;
  let bytes = 0;
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".lake") continue;
      const current = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`repository contains a symlink, which is not accepted: ${path.relative(root, current)}`);
      }
      if (entry.isDirectory()) walk(current);
      else if (entry.isFile()) {
        files += 1;
        bytes += fs.statSync(current).size;
        if (files > maxFiles) throw new Error(`repository contains more than ${maxFiles} files`);
        if (bytes > maxBytes) throw new Error("repository checkout exceeds 2 GiB");
      } else {
        throw new Error(`repository contains a non-regular entry: ${path.relative(root, current)}`);
      }
    }
  };
  walk(root);
}
