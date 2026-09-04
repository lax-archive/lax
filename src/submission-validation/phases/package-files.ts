import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { infrastructureFailure, resourceLimitFailure } from "../failures.js";
import type { FindingCollector } from "../findings.js";

/**
 * What git holds under the submission root.
 *
 * Both sides of the trust boundary run the same static validation, but they
 * point it at different trees: the workflow validates a fresh checkout of the
 * submitted commit, where every file on disk is tracked, and `lax build`
 * validates the author's working directory, where an editor's leavings sit
 * beside the sources. Only git can tell those apart, so the phases ask it
 * once, up front, instead of believing whatever `readdir` happens to return.
 */
export interface SubmissionTree {
  /**
   * Every tracked path under the submission root, in git's order, relative to
   * that root and `/`-separated — the submission as the archive will receive
   * it, and on the trusted path everything there is.
   */
  readonly tracked: readonly string[];
  /**
   * Whether the submission's ignore rules cover this relative path, or a
   * folder above it.
   *
   * Only an untracked file can be ignored: `git ls-files --others` never
   * reports a tracked path, however exactly a rule matches it. So no ignore
   * line can hide a committed file from validation — this narrows what the
   * archive sees by nothing at all, and what the local build sees by the
   * author's own leavings.
   */
  ignores(relative: string): boolean;
}

/**
 * Ask git what it holds under the submission root.
 *
 * The invocation is hermetic on purpose: this runs on submitted source, so
 * neither the machine's system config nor a user's global config may change
 * what validation sees. What is left is the ignore files inside the tree,
 * which is the point — they travel with the commit, so the author's statement
 * about which files are theirs and which are their editor's reads the same for
 * everyone who clones the repository.
 */
export function readSubmissionTree(root: string): SubmissionTree {
  let tracked: string[];
  let ignored: string[];
  try {
    tracked = list(root, ["ls-files", "-z", "--", "."]);
    // `--directory` collapses an ignored folder into one entry instead of
    // naming everything under it, which keeps the answer small even when the
    // folder is a `.lake` holding a whole mathlib clone.
    ignored = list(root, [
      "ls-files",
      "-z",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "--",
      ".",
    ]).map((entry) => (entry.endsWith("/") ? entry.slice(0, -1) : entry));
  } catch (error) {
    const message = `could not inspect the submitted git tree: ${(error as Error).message}`;
    if (error instanceof Error && /(?:timed? out|ETIMEDOUT)/iu.test(error.message)) {
      throw resourceLimitFailure(message);
    }
    throw infrastructureFailure(message);
  }
  // A collapsed folder stands for everything inside it, so a path is ignored
  // when it is one of the entries git reported or sits under one.
  const ignoredPaths = new Set(ignored);
  return {
    tracked,
    ignores: (relative) => ancestry(relative).some((entry) => ignoredPaths.has(entry)),
  };
}

/**
 * Reject undeclared files that could otherwise become package build inputs —
 * among the files the submission actually carries, which is what `submitted()`
 * below settles.
 */
export function checkPackageFiles(
  packageDir: string,
  kind: "concepts" | "proofs",
  packageName: string,
  tree: SubmissionTree,
  findings: FindingCollector,
): void {
  if (!fs.existsSync(packageDir)) return;
  const allowedRoot = new Set(["lakefile.toml", "lean-toolchain", "lake-manifest.json", `${packageName}.lean`]);
  for (const entry of fs.readdirSync(packageDir, { withFileTypes: true })) {
    if (entry.name === ".lake") {
      if (!entry.isDirectory()) findings.violate("unexpected-files", `${kind}/.lake must be a directory`);
      continue;
    }
    const relative = `${kind}/${entry.name}`;
    if (!submitted(relative, tree)) continue;
    if (entry.name === packageName) {
      if (!entry.isDirectory()) findings.violate("unexpected-files", `${relative} must be a directory`);
      else checkModuleTree(path.join(packageDir, entry.name), relative, tree, findings);
    } else if (!allowedRoot.has(entry.name)) {
      findings.violate("unexpected-files", `unexpected package file: ${relative}`);
    } else if (!entry.isFile()) {
      findings.violate("unexpected-files", `${relative} must be a regular file`);
    }
  }
}

/** Copy only declared Lake and Lean inputs; generated and auxiliary files are omitted. */
export function copyPackageInputs(source: string, destination: string, packageName: string): void {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const name of ["lakefile.toml", "lean-toolchain", `${packageName}.lean`]) {
    const filename = path.join(source, name);
    if (fs.existsSync(filename)) fs.cpSync(filename, path.join(destination, name), { dereference: false });
  }
  const modules = path.join(source, packageName);
  if (fs.existsSync(modules)) {
    fs.cpSync(modules, path.join(destination, packageName), {
      recursive: true,
      dereference: false,
      filter: (filename) => {
        if (filename === modules) return true;
        const entry = fs.lstatSync(filename);
        return entry.isDirectory() || (entry.isFile() && filename.endsWith(".lean"));
      },
    });
  }
}

/**
 * Whether an entry on disk is part of the submission — the one place the two
 * trust paths differ.
 *
 * The workflow validates a checkout, where every file is tracked and nothing
 * can be ignored, so this answers yes to every entry: undeclared files stay a
 * violation there, exactly as before. `lax build` validates the author's
 * working directory, where a `.DS_Store`, an editor's `.swp` or a scratch
 * folder sits beside the sources and none of it will ever reach the archive.
 * Failing the local build on those refused a commit the archive would have
 * accepted, and the obvious fix — gitignoring them — did nothing, because the
 * walk asked only the filesystem.
 *
 * An entry that is merely uncommitted is still checked, and still theirs to
 * answer for: `lax submit` refuses a dirty worktree, so an unignored file that
 * never made it into the commit stops the submit rather than slipping past it.
 */
function submitted(relative: string, tree: SubmissionTree): boolean {
  return !tree.ignores(relative);
}

function checkModuleTree(
  directory: string,
  relative: string,
  tree: SubmissionTree,
  findings: FindingCollector,
): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    const childRelative = `${relative}/${entry.name}`;
    if (!submitted(childRelative, tree)) continue;
    if (entry.isDirectory()) checkModuleTree(child, childRelative, tree, findings);
    else if (!entry.isFile() || !entry.name.endsWith(".lean"))
      findings.violate("unexpected-files", `unexpected package file: ${childRelative}`);
  }
}

function list(root: string, args: readonly string[]): string[] {
  const output = execFileSync("git", ["-C", root, ...args], {
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
    },
  }).toString();
  // `-z` rather than the default listing: git quotes any path outside ASCII,
  // and a quoted name would match no entry `readdir` ever returns.
  return output.split("\0").filter((entry) => entry !== "");
}

/** A path and every folder above it, inside the submission root. */
function ancestry(entry: string): string[] {
  const steps = [entry];
  for (let slash = entry.lastIndexOf("/"); slash > 0; slash = entry.lastIndexOf("/", slash - 1)) {
    steps.push(entry.slice(0, slash));
  }
  return steps;
}
