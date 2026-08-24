import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { SourceLocation } from "../shared/types.js";
import { validateCommit, validateRepositoryUrl } from "../shared/validation.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function normalizeRepositoryUrl(value: string): string {
  let normalized = value.trim();
  const scp = /^git@github\.com:([^/]+)\/(.+)$/u.exec(normalized);
  const ssh = /^ssh:\/\/git@github\.com\/([^/]+)\/(.+)$/u.exec(normalized);
  if (scp !== null) normalized = `https://github.com/${scp[1]}/${scp[2]}`;
  if (ssh !== null) normalized = `https://github.com/${ssh[1]}/${ssh[2]}`;
  normalized = normalized.replace(/\/+$/u, "").replace(/\.git$/u, "");
  return validateRepositoryUrl(normalized);
}

/**
 * The author's name as Git knows it, for a scaffold that has no GitHub handle
 * to use — `lax init --offline` never signs in. Undefined when Git has no
 * `user.name` configured, which leaves the manifest's author list empty rather
 * than inventing a name for it.
 */
export function gitAuthorName(folder: string): string | undefined {
  // The folder itself may not exist yet — a scaffold asks before it writes —
  // and `user.name` can be set per repository, so the question is asked from
  // the nearest directory that does exist.
  let cwd = path.resolve(folder);
  while (!fs.existsSync(cwd)) {
    const parent = path.dirname(cwd);
    if (parent === cwd) return undefined;
    cwd = parent;
  }
  try {
    const name = git(cwd, ["config", "--get", "user.name"]);
    return name === "" ? undefined : name;
  } catch {
    return undefined;
  }
}

export function repositoryRoot(folder: string): string {
  const root = path.resolve(folder);
  try {
    return fs.realpathSync(git(root, ["rev-parse", "--show-toplevel"]));
  } catch {
    throw new Error(`${root} is not inside a git repository`);
  }
}

export function repositoryFolder(toplevel: string, folder: string): string {
  const relative = path.relative(fs.realpathSync(toplevel), fs.realpathSync(path.resolve(folder)));
  if (relative === "") return ".";
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${folder} is outside the git repository`);
  }
  return relative.split(path.sep).join("/");
}

/** Derive a source triple from a local folder without requiring a clean/pushed checkout. */
export function deriveLocalSource(folder: string): SourceLocation {
  const root = repositoryRoot(folder);
  let repository = "https://github.com/local/local";
  try {
    repository = originUrl(root);
  } catch {
    // Local validation still needs a stable repository identity in the
    // request, but unlike submit it does not require a remote yet.
  }
  return {
    repository,
    commit: validateCommit(git(root, ["rev-parse", "HEAD"])),
    folder: repositoryFolder(root, folder),
  };
}

/**
 * Derive the immutable source triple submitted to the issue workflow.
 *
 * `force` drops every precondition this function checks — the author has said
 * the trusted workflow is the verdict they want. The `origin` URL stays
 * required even then: it is not a check but half of the triple, and there is no
 * honest value to invent for it.
 */
export function deriveSubmittedSource(
  folder: string,
  options: { allowDirty?: boolean; force?: boolean } = {},
): SourceLocation {
  const root = repositoryRoot(folder);
  const force = options.force ?? false;
  if (!force && options.allowDirty !== true && git(root, ["status", "--porcelain"]) !== "") {
    throw new Error(
      "the worktree is dirty — commit your changes, or pass --allow-dirty to submit the committed HEAD without them",
    );
  }
  const commit = validateCommit(git(root, ["rev-parse", "HEAD"]));
  const repository = originUrl(root);
  if (force) return { repository, commit, folder: repositoryFolder(root, folder) };
  try {
    git(root, ["fetch", "--quiet", "origin"]);
  } catch {
    throw new Error("`git fetch origin` failed — the remote must be reachable");
  }
  const containing = git(root, [
    "for-each-ref",
    "--format=%(refname)",
    "--contains",
    commit,
    "refs/remotes/origin/",
  ]);
  if (containing === "") {
    let branch = "HEAD";
    try {
      branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    } catch {
      // Keep the detached-HEAD hint.
    }
    const hint =
      branch === "HEAD"
        ? "`git push origin HEAD:<branch>`"
        : `\`git push origin ${branch}\``;
    throw new Error(`HEAD is not present on origin — push it first with ${hint}`);
  }
  return { repository, commit, folder: repositoryFolder(root, folder) };
}

function originUrl(root: string): string {
  try {
    return normalizeRepositoryUrl(git(root, ["remote", "get-url", "origin"]));
  } catch (error) {
    if (error instanceof Error && error.message.includes("canonical public HTTPS")) throw error;
    throw new Error("the repository has no usable GitHub `origin` remote — add one and push");
  }
}
