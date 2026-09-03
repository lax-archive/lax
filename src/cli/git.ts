import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { SourceLocation } from "../shared/types.js";
import { validateCommit, validateRepositoryUrl, ValidationError } from "../shared/validation.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function normalizeRepositoryUrl(value: string): string {
  let normalized = value.trim();
  const scp = /^git@([^/:]+):(.+)$/u.exec(normalized);
  if (scp !== null) {
    normalized = `https://${scp[1]!.toLowerCase()}/${scp[2]}`;
  } else {
    try {
      const url = new URL(normalized);
      if (
        url.protocol === "ssh:" &&
        url.username === "git" &&
        url.password === "" &&
        url.port === "" &&
        url.search === "" &&
        url.hash === ""
      ) {
        normalized = `https://${url.hostname.toLowerCase()}${url.pathname}`;
      } else if (url.protocol === "https:" && url.username !== "" && url.password === "") {
        // Bitbucket commonly includes a harmless username in HTTPS clone URLs.
        // The public validation fetch never needs it, so keep credentials out of
        // the submitted source triple.
        url.username = "";
        normalized = url.toString();
      }
    } catch {
      // The canonical validator below supplies the user-facing failure.
    }
  }
  normalized = normalized.replace(/\/+$/u, "").replace(/\.git$/u, "");
  return validateRepositoryUrl(normalized);
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
    // Local validation needs a stable repository identity for sibling paths,
    // but unlike submit it does not require a remote yet.
  }
  return {
    repository,
    commit: validateCommit(git(root, ["rev-parse", "HEAD"])),
    folder: repositoryFolder(root, folder),
  };
}

/** Derive the immutable source triple submitted to the issue workflow. */
export function deriveSubmittedSource(folder: string, allowDirty = false): SourceLocation {
  const root = repositoryRoot(folder);
  if (!allowDirty && git(root, ["status", "--porcelain"]) !== "") {
    throw new Error(
      "the worktree is dirty — commit your changes, or pass --allow-dirty to submit the committed HEAD without them",
    );
  }
  const commit = validateCommit(git(root, ["rev-parse", "HEAD"]));
  const repository = originUrl(root);
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
    if (error instanceof ValidationError) throw error;
    throw new Error("the repository has no usable supported `origin` remote — add one and push");
  }
}
