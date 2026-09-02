// Trusted, host-side source fetching (ported from the deleted in-container
// runtime/fetch-source.mjs when the custom image died — the stock sandbox
// image carries no git, and fetching a *validated* canonical URL is a trusted
// pre-sandbox step anyway). Every check carries over: canonical
// supported-host URL narrowing, full 40-hex commit, HOME isolation,
// https-only git protocol, and the rev-parse assertion that the checkout
// really is the requested immutable commit. The checkout is then inspected
// repo-wide: symlinks and non-regular entries are rejected before anything
// reads it.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ValidationLimits } from "../config.js";
import type { SourceLocation } from "../../shared/types.js";
import { validateCommit, validateRepositoryUrl } from "../../shared/validation.js";

export interface FetchedSource {
  repositoryRoot: string;
  submissionRoot: string;
}

/** Runs one git command in the fetch workspace and reports exit code + output. */
export type GitRunner = (args: string[]) => Promise<{ code: number; output: string }>;

// Cap on how deep the progressive-deepening fallback digs behind the remote
// branch tips before giving up. Submitted commits are normally at or near a
// tip, so this is generous; the point of the cap is that an
// attacker-controlled repository cannot make us walk millions of commits of
// fabricated history. Together with the per-job fetch deadline (every git
// call shares it) and the post-checkout file/size inspection, it bounds the
// total work a hostile remote can cost us.
const MAX_FALLBACK_DEPTH = 8192;

/**
 * Fetch one commit of a public supported repository into `destination` with an
 * isolated git environment: no inherited HOME or git config, https protocol
 * only, no terminal prompts, and a final `rev-parse HEAD` equality assertion.
 */
export async function fetchGitCheckout(
  repository: string,
  commit: string,
  destination: string,
  timeoutMs: number,
): Promise<void> {
  validateRepositoryUrl(repository);
  validateCommit(commit);
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
  const git: GitRunner = (args) =>
    runGit(args, destination, env, Math.max(1, deadline - Date.now()));
  await checkoutRemoteCommit(git, repository, commit);
}

/**
 * The git sequence behind {@link fetchGitCheckout}, parameterized over the
 * runner so tests can drive it with real git against local fixture remotes:
 * try the cheap unadvertised-SHA fetch first; when the host refuses it, fetch
 * the ref tips and progressively deepen (geometrically, capped at `maxDepth`
 * total commits behind the tips) until the requested commit is present. Ends
 * with a checkout and a `rev-parse HEAD` equality assertion, so whatever the
 * fetch path, only the exact requested commit can come out.
 */
export async function checkoutRemoteCommit(
  git: GitRunner,
  repository: string,
  commit: string,
  maxDepth = MAX_FALLBACK_DEPTH,
): Promise<void> {
  if ((await git(["init", "--quiet"])).code !== 0) throw new Error("could not initialize the fetch workspace");
  if ((await git(["remote", "add", "origin", repository])).code !== 0) {
    throw new Error("could not configure the fetch remote");
  }
  const direct = await git(["fetch", "--quiet", "--depth", "1", "origin", commit]);
  if (direct.code !== 0) {
    // The host refused the unadvertised-SHA fetch. Fetch the branch tips,
    // then deepen until the commit shows up (or a bound is hit — the
    // checkout below then reports the failure).
    if ((await git(["fetch", "--quiet", "--depth", "1", "origin"])).code !== 0) {
      throw new Error("repository or commit could not be fetched anonymously");
    }
    await deepenUntilPresent(git, commit, maxDepth);
  }
  if ((await git(["-c", "advice.detachedHead=false", "checkout", "--quiet", commit])).code !== 0) {
    throw new Error("requested commit is not present in the fetched repository");
  }
  const resolved = await git(["rev-parse", "HEAD"]);
  if (resolved.code !== 0 || resolved.output.trim() !== commit) {
    throw new Error("checkout did not resolve to the requested immutable commit");
  }
}

/**
 * Deepens the shallow tip-only fetch until `commit` is present locally, the
 * history is complete (the commit is simply absent), the depth cap is
 * reached, or a fetch fails (including hitting the shared deadline). Never
 * throws: the caller's checkout is the single authority on absence.
 */
async function deepenUntilPresent(git: GitRunner, commit: string, maxDepth: number): Promise<void> {
  let depth = 1;
  let step = 32;
  while ((await git(["cat-file", "-e", `${commit}^{commit}`])).code !== 0) {
    if (depth >= maxDepth) return;
    const shallow = await git(["rev-parse", "--is-shallow-repository"]);
    if (shallow.code !== 0 || shallow.output.trim() !== "true") return;
    const deepenBy = Math.min(step, maxDepth - depth);
    if ((await git(["fetch", "--quiet", `--deepen=${deepenBy}`, "origin"])).code !== 0) return;
    depth += deepenBy;
    step *= 2;
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
