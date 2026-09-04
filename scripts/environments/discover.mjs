#!/usr/bin/env node
// Which mathlib releases are candidates for admission as archive environments.
//
//   node scripts/environments/discover.mjs            # every new candidate
//   node scripts/environments/discover.mjs v4.34.0    # just this one
//
// Prints a JSON matrix on stdout and a human summary on stderr:
//   {"include":[{"id":"v4.34.0","leanToolchain":"…","mathlibCommit":"…"}]}
//
// Step 1 of `.github/workflows/environments.yml` (history/environments-plan.md,
// "Admission: environments.yml"). It reads mathlib and nothing else: no App
// key, no database, no author code.
//
// The rules, in order:
//   * only `vX.Y.0` release tags — not patch releases, not release candidates
//     (Jan's decision, recorded in the plan);
//   * at or above the floor, the oldest admitted environment: the warm store
//     relies on package-overrides and artifact-cache behaviour older Lake
//     versions do not have;
//   * at or above ADMISSION_START, so releases that came out before admission
//     existed stay backlog — nobody needs them and each costs a run;
//   * not already in the table, which only grows;
//   * and the tag's own `lean-toolchain` must be `leanprover/lean4:<tag>`,
//     read at the commit the tag resolved to and never at the tag name: tags
//     are mutable and the recorded commit is not.

import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTable, REPOSITORY_ROOT } from "./table.mjs";

/**
 * The oldest release admission will consider.
 *
 * Stage 3 of history/environments-plan.md landed on ADMISSION_START_DATE, when
 * mathlib's newest `vX.Y.0` tag was this one; the plan's decision is to go
 * forward only, so v4.31.0 and v4.32.0 stay backlog. This is that date
 * expressed as the version that carried it — moving it is a deliberate edit,
 * never a side effect of a run.
 */
export const ADMISSION_START = "v4.33.0";
export const ADMISSION_START_DATE = "2026-09-04";

const RELEASE_TAG = /^v4\.\d+\.0$/u;
const TAG_REF = /^([0-9a-f]{40})\s+refs\/tags\/(\S+?)(\^\{\})?$/u;

/** Compare two `vX.Y.Z` strings numerically. */
export function compareVersions(left, right) {
  const parts = (value) => value.slice(1).split(".").map(Number);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

/**
 * The tag names worth a test run, oldest first. Pure: `tags` is whatever
 * `git ls-remote` listed, `known` the ids already in the table, and `floor`
 * the oldest admitted environment (the table's first entry by default).
 */
export function candidateTags(tags, { known = [], floor, startAt = ADMISSION_START } = {}) {
  const admitted = new Set(known);
  const oldest = floor ?? [...admitted].sort(compareVersions)[0];
  const kept = new Set();
  for (const tag of tags) {
    if (!RELEASE_TAG.test(tag)) continue;
    if (oldest !== undefined && compareVersions(tag, oldest) < 0) continue;
    if (compareVersions(tag, startAt) < 0) continue;
    if (admitted.has(tag)) continue;
    kept.add(tag);
  }
  return [...kept].sort(compareVersions);
}

/**
 * `git ls-remote --tags` output as a tag → commit map. An annotated tag's
 * peeled `^{}` line wins, since that is the commit the tag denotes.
 */
export function parseLsRemote(output) {
  const commits = new Map();
  for (const line of output.split("\n")) {
    const match = TAG_REF.exec(line.trim());
    if (match === null) continue;
    const [, commit, tag, peeled] = match;
    if (peeled !== undefined || !commits.has(tag)) commits.set(tag, commit);
  }
  return commits;
}

/** The `lean-toolchain` a tag must carry to be admissible. */
export function expectedToolchain(tag) {
  return `leanprover/lean4:${tag}`;
}

// ---------------------------------------------------------------------------
// The network half. Nothing above this line touches it, so the rules are
// tested without one (test/unit/environments-scripts.test.ts).
// ---------------------------------------------------------------------------

function git(args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/** The canonical mathlib repository, from the one module that names it. */
async function mathlibRepository() {
  // mathlibUrl() reads the fake-mathlib test seam; an admission run must look
  // at the real repository whatever the environment says.
  delete process.env.LAX_MATHLIB_URL;
  delete process.env.LAX_MATHLIB_REV;
  const pins = await import(
    path.join(REPOSITORY_ROOT, "dist", "submission-validation", "pins.js")
  );
  return pins.mathlibUrl();
}

async function leanToolchainAt(repository, commit) {
  const raw = repository
    .replace(/^https:\/\/github\.com\//u, "https://raw.githubusercontent.com/")
    .replace(/\.git$/u, "");
  const response = await fetch(`${raw}/${commit}/lean-toolchain`, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`lean-toolchain at ${commit}: HTTP ${response.status}`);
  return (await response.text()).trim();
}

export async function discover(only) {
  const repository = await mathlibRepository();
  const table = readTable();
  const commits = parseLsRemote(await git(["ls-remote", "--tags", repository]));
  let tags = candidateTags([...commits.keys()], { known: table.map((entry) => entry.id) });
  if (only !== undefined) {
    if (!tags.includes(only)) {
      throw new Error(
        `${only} is not a candidate: it is already admitted, below the floor, ` +
          `below ${ADMISSION_START}, or not a mathlib vX.Y.0 release tag`,
      );
    }
    tags = [only];
  }
  const include = [];
  for (const id of tags) {
    const mathlibCommit = commits.get(id);
    const toolchain = await leanToolchainAt(repository, mathlibCommit);
    if (toolchain !== expectedToolchain(id)) {
      throw new Error(`mathlib ${id} (${mathlibCommit.slice(0, 12)}) builds with ${toolchain}`);
    }
    include.push({ id, leanToolchain: toolchain, mathlibCommit });
  }
  return include;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const requested = process.argv[2];
  const only = requested === undefined || requested === "" ? undefined : requested;
  if (only !== undefined && !RELEASE_TAG.test(only)) {
    console.error(`not a mathlib release tag: ${only}`);
    process.exit(2);
  }
  const include = await discover(only);
  for (const entry of include) {
    console.error(`candidate ${entry.id} at ${entry.mathlibCommit} (${entry.leanToolchain})`);
  }
  if (include.length === 0) console.error("no new environment to admit");
  process.stdout.write(`${JSON.stringify({ include })}\n`);
}
