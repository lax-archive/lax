#!/usr/bin/env node
// Derive the rehearsal fork of .github/workflows/submission.yml *at run time*
// from the real file. There is deliberately no checked-in copy of the patched
// workflow: a stale fork would silently rehearse a workflow that production no
// longer runs, which is exactly the failure mode history/live-rehearsal.md was
// written to prevent. Every structural assumption below is asserted, so drift
// in submission.yml breaks this script instead of shipping a wrong patch.
//
// The three deviations (documented in the emitted workflow's own header):
//   a. a workflow-level `env:` block pointing the repository constants from
//      src/shared/constants.ts at the scratch repositories,
//   b. the three `actions/create-github-app-token` mint steps deleted and
//      their consumers switched to `${{ secrets.LAX_SCRATCH_TOKEN }}`, an
//      environment-scoped personal token that mirrors the production posture
//      (present only inside the two protected environments),
//   c. ci.yml / release-cli.yml dropped from the pushed tree (done by
//      setup.sh, not here — this script only rewrites submission.yml).
//
// Usage:
//   node scripts/rehearsal/patch-workflow.mjs --owner <owner> --prefix <prefix>
//        [--input <submission.yml>] [--output <file>]
// With no --output the patched workflow is written to stdout.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const MINT_ACTION = "actions/create-github-app-token";
const SECRET_EXPRESSION = "${{ secrets.LAX_SCRATCH_TOKEN }}";
const ENVIRONMENTS = ["lax-database-publish", "lax-website-dispatch"];

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "..", "..");
const defaultInput = path.join(repositoryRoot, ".github", "workflows", "submission.yml");

class PatchError extends Error {}

/** Fail loudly: an unmet assumption means submission.yml drifted. */
function assume(condition, message) {
  if (!condition) throw new PatchError(`submission.yml drifted: ${message}`);
}

export function scratchRepositories(owner, prefix) {
  assume(/^[A-Za-z0-9][A-Za-z0-9-]*$/u.test(owner), `invalid owner ${JSON.stringify(owner)}`);
  assume(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(prefix), `invalid prefix ${JSON.stringify(prefix)}`);
  return {
    control: `${owner}/${prefix}-control`,
    database: `${owner}/${prefix}-database`,
    submission: `${owner}/${prefix}-submission`,
    // Website stands in as the database repo: the repository_dispatch
    // receiver lives there, so the dispatch is visibly received.
    website: `${owner}/${prefix}-database`,
    // ghcr repository paths are lowercase, like CAPTURES_REPOSITORY.
    captures: `${owner}/${prefix}-captures`.toLowerCase(),
  };
}

/**
 * Rewrite the workflow source. Returns the patched text.
 * Throws PatchError when any expected structure is missing.
 */
export function patchWorkflow(source, owner, prefix) {
  const repositories = scratchRepositories(owner, prefix);
  assume(!/^env:/mu.test(source), "a top-level env: block already exists");
  assume(source.includes(MINT_ACTION), `no ${MINT_ACTION} step found`);
  assume(!source.includes("LAX_SCRATCH_TOKEN"), "LAX_SCRATCH_TOKEN already referenced");

  let lines = source.split("\n");
  lines = insertEnvironmentBlock(lines, repositories);
  const { lines: withoutMints, ids } = removeMintSteps(lines);
  lines = withoutMints;

  let text = lines.join("\n");
  let consumers = 0;
  // Two jobs happen to use the same step id; each consumer sits in the job
  // whose mint step it named, so the textual replacement stays exact.
  for (const id of new Set(ids)) {
    const expression = `\${{ steps.${id}.outputs.token }}`;
    const occurrences = text.split(expression).length - 1;
    const removed = ids.filter((candidate) => candidate === id).length;
    assume(
      occurrences === removed,
      `mint step ${id} was removed ${removed} time(s) but has ${occurrences} consumer(s)`,
    );
    consumers += occurrences;
    text = text.split(expression).join(SECRET_EXPRESSION);
  }
  const patched = header(repositories) + text;
  verify(patched, text, repositories, consumers);
  return patched;
}

/** Insert the repository-constant overrides right after top-level permissions. */
function insertEnvironmentBlock(lines, repositories) {
  const start = lines.findIndex((line) => line === "permissions:");
  assume(start >= 0, "no top-level permissions: block");
  let end = start + 1;
  while (end < lines.length && /^\s+\S/u.test(lines[end])) end += 1;
  assume(end > start + 1, "the top-level permissions: block is empty");
  const block = [
    "",
    "# Rehearsal deviation (a): point the repository constants of",
    "# src/shared/constants.ts at the disposable scratch repositories. Nothing",
    "# below this block is aware that it is not production.",
    "env:",
    `  LAX_CONTROL_REPOSITORY: ${repositories.control}`,
    `  LAX_DATABASE_REPOSITORY: ${repositories.database}`,
    `  LAX_WEBSITE_REPOSITORY: ${repositories.website}`,
    `  LAX_CAPTURES_REPOSITORY: ${repositories.captures}`,
  ];
  return [...lines.slice(0, end), ...block, ...lines.slice(end)];
}

/** Delete every App-token mint step; return the step ids that were removed. */
function removeMintSteps(lines) {
  const ids = [];
  let result = [...lines];
  for (;;) {
    const uses = result.findIndex((line) => line.includes(`uses: ${MINT_ACTION}@`));
    if (uses < 0) break;
    let start = uses;
    while (start > 0 && !/^ {6}- /u.test(result[start])) start -= 1;
    assume(/^ {6}- /u.test(result[start]), "a mint step does not start at the expected indentation");
    let end = uses + 1;
    while (end < result.length && /^ {8}\S|^ {10}/u.test(result[end])) end += 1;
    const block = result.slice(start, end);
    const id = block
      .map((line) => /^ {8}id: (\S+)$/u.exec(line))
      .find((match) => match !== null)?.[1];
    assume(id !== undefined, `a ${MINT_ACTION} step carries no id:`);
    ids.push(id);
    result = [...result.slice(0, start), ...result.slice(end)];
    // Collapse the blank line the deletion would otherwise double up.
    if (result[start - 1]?.trim() === "" && result[start]?.trim() === "") {
      result.splice(start, 1);
    }
  }
  assume(ids.length === 3, `expected 3 ${MINT_ACTION} steps, found ${ids.length}`);
  return { lines: result, ids };
}

function header(repositories) {
  return [
    "# REHEARSAL FORK — NOT FOR MERGE.",
    "#",
    "# Generated by scripts/rehearsal/patch-workflow.mjs from the real",
    "# .github/workflows/submission.yml. Deviations from it, and only these:",
    "#",
    "#   a. the workflow-level env: block below points the repository",
    `#      constants at ${repositories.control}, ${repositories.database},`,
    `#      ${repositories.website} (standing in for lax-website), and`,
    `#      ${repositories.captures}.`,
    "#   b. the three actions/create-github-app-token mint steps are deleted;",
    "#      their consumers now read the environment-scoped personal token",
    "#      secrets.LAX_SCRATCH_TOKEN, which exists only inside the two",
    `#      protected environments (${ENVIRONMENTS.join(", ")}).`,
    "#   c. ci.yml and release-cli.yml are absent from the pushed tree.",
    "#",
    "# Everything else is byte-identical to the tree this was derived from.",
    "",
  ].join("\n");
}

/**
 * Parse the result and re-check the invariants on the parsed document.
 * `body` is the patched workflow without the explanatory header, so the
 * header's own prose about the removed action does not defeat the checks.
 */
function verify(text, body, repositories, mintCount) {
  let parsed;
  try {
    parsed = YAML.parse(text);
  } catch (error) {
    throw new PatchError(`the patched workflow is not valid YAML: ${error.message}`);
  }
  assume(parsed !== null && typeof parsed === "object", "the patched workflow is not a mapping");
  assume(!body.includes(MINT_ACTION), "a mint step survived the patch");
  for (const forbidden of [
    "LAX_DATABASE_APP_ID",
    "LAX_WEBSITE_APP_ID",
    "LAX_DATABASE_APP_PRIVATE_KEY",
    "LAX_WEBSITE_APP_PRIVATE_KEY",
  ]) {
    assume(!body.includes(forbidden), `${forbidden} survived the patch`);
  }
  assume(
    JSON.stringify(parsed.env) ===
      JSON.stringify({
        LAX_CONTROL_REPOSITORY: repositories.control,
        LAX_DATABASE_REPOSITORY: repositories.database,
        LAX_WEBSITE_REPOSITORY: repositories.website,
        LAX_CAPTURES_REPOSITORY: repositories.captures,
      }),
    "the env: block did not survive parsing",
  );
  const jobs = parsed.jobs ?? {};
  const consumers = Object.values(jobs).flatMap((job) =>
    (job.steps ?? []).filter((step) =>
      Object.values(step.env ?? {}).includes(SECRET_EXPRESSION),
    ),
  );
  assume(
    consumers.length === mintCount,
    `expected ${mintCount} steps to read the scratch token, found ${consumers.length}`,
  );
  // The protected environments still gate every job that touches the token.
  for (const environment of ENVIRONMENTS) {
    assume(
      Object.values(jobs).some((job) => job.environment === environment),
      `no job declares environment ${environment}`,
    );
  }
  for (const [name, job] of Object.entries(jobs)) {
    const usesSecret = (job.steps ?? []).some((step) =>
      Object.values(step.env ?? {}).includes(SECRET_EXPRESSION),
    );
    assume(
      !usesSecret || ENVIRONMENTS.includes(job.environment),
      `job ${name} reads the scratch token outside a protected environment`,
    );
  }
}

function main(argv) {
  const options = { owner: undefined, prefix: undefined, input: defaultInput, output: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = /^--(owner|prefix|input|output)$/u.exec(flag)?.[1];
    if (key === undefined) throw new PatchError(`unknown argument ${flag}`);
    const value = argv[index + 1];
    if (value === undefined) throw new PatchError(`${flag} needs a value`);
    options[key] = value;
    index += 1;
  }
  if (options.owner === undefined || options.prefix === undefined) {
    throw new PatchError("usage: patch-workflow.mjs --owner <owner> --prefix <prefix> [--input f] [--output f]");
  }
  const source = fs.readFileSync(options.input, "utf8");
  const patched = patchWorkflow(source, options.owner, options.prefix);
  if (options.output === undefined) process.stdout.write(patched);
  else fs.writeFileSync(options.output, patched);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
