// Reading and writing the archive environment table as *text*.
//
// `src/submission-validation/environments.ts` is the single home of the table
// (history/environments-plan.md, "The environment table"). Two jobs need it without a
// TypeScript build in hand: the `inspector-matrix` gate, which decides which
// toolchains to install before anything is compiled, and `admit.mjs`, which
// appends an entry and opens a pull request. Both go through this module, so
// there is one parser and one writer rather than a regex per caller.
//
// The parser is deliberately narrow: it reads the literal `TABLE` array and
// nothing else, and throws on anything it does not recognise. A table it
// cannot read must fail the job, never yield a short matrix that silently
// stops guarding an environment. `test/unit/environments-scripts.test.ts`
// pins its output against the compiled table, so the two cannot drift.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
export const TABLE_FILE = path.join(
  REPOSITORY_ROOT,
  "src",
  "submission-validation",
  "environments.ts",
);

const TABLE_OPENER = "const TABLE: readonly ArchiveEnvironment[] = [";
const ID_PATTERN = /^v[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const DATE_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;

/** The `[` … `]` of the TABLE literal, as offsets into the source. */
function tableExtent(source) {
  const opener = source.indexOf(TABLE_OPENER);
  if (opener < 0) throw new Error(`${TABLE_FILE} no longer declares a TABLE literal`);
  const open = opener + TABLE_OPENER.length - 1;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === "[") depth += 1;
    else if (character === "]") {
      depth -= 1;
      if (depth === 0) return { open, close: index };
    }
  }
  throw new Error("the TABLE literal is not closed");
}

/** The top-level `{ … }` object literals inside the table, as source text. */
function entryTexts(source) {
  const { open, close } = tableExtent(source);
  const texts = [];
  let depth = 0;
  let start = -1;
  for (let index = open + 1; index < close; index += 1) {
    const character = source[index];
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        texts.push(source.slice(start, index + 1));
        start = -1;
      }
    }
  }
  if (depth !== 0) throw new Error("an entry in the TABLE literal is not closed");
  return texts;
}

function field(text, name) {
  const match = new RegExp(`\\b${name}:\\s*"([^"]*)"`, "u").exec(text);
  return match === null ? undefined : match[1];
}

/**
 * The admitted environments, read out of the table's source text. Only the
 * fields a job outside TypeScript needs: the id, the toolchain to install, the
 * inspector source directory to build, and the mathlib commit.
 */
export function parseTable(source) {
  const entries = entryTexts(source).map((text) => {
    const entry = {
      id: field(text, "id"),
      leanToolchain: field(text, "leanToolchain"),
      mathlibCommit: field(text, "mathlibCommit"),
      inspector: field(text, "inspector"),
    };
    for (const [name, value] of Object.entries(entry)) {
      if (typeof value !== "string" || value === "") {
        throw new Error(`an entry in the environment table has no ${name}: ${text}`);
      }
    }
    if (!ID_PATTERN.test(entry.id)) throw new Error(`bad environment id in the table: ${entry.id}`);
    if (entry.leanToolchain !== `leanprover/lean4:${entry.id}`) {
      throw new Error(`${entry.id} names the toolchain ${entry.leanToolchain}`);
    }
    if (!COMMIT_PATTERN.test(entry.mathlibCommit)) {
      throw new Error(`${entry.id} records the mathlib commit ${entry.mathlibCommit}`);
    }
    return entry;
  });
  if (entries.length === 0) throw new Error("the environment table is empty");
  return entries;
}

/** The table as this checkout has it. */
export function readTable() {
  return parseTable(fs.readFileSync(TABLE_FILE, "utf8"));
}

/**
 * The source text with one entry appended to the table.
 *
 * Everything here arrives from a scheduled run's network reads or from a
 * `workflow_dispatch` input, so every field is validated before it is written
 * into a file a pull request will ask a human to merge. The table only grows:
 * an id already present is refused rather than rewritten.
 */
export function appendEntry(source, entry) {
  const { id, mathlibCommit, admittedAt, limits } = entry;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new Error(`refusing to admit the environment id ${JSON.stringify(id)}`);
  }
  if (typeof mathlibCommit !== "string" || !COMMIT_PATTERN.test(mathlibCommit)) {
    throw new Error(`refusing to admit ${id} at the commit ${JSON.stringify(mathlibCommit)}`);
  }
  if (typeof admittedAt !== "string" || !DATE_PATTERN.test(admittedAt)) {
    throw new Error(`refusing to admit ${id} on the date ${JSON.stringify(admittedAt)}`);
  }
  if (parseTable(source).some((existing) => existing.id === id)) {
    throw new Error(`${id} is already in the environment table`);
  }
  const lines = [
    "  {",
    `    id: "${id}",`,
    `    leanToolchain: "leanprover/lean4:${id}",`,
    `    mathlibCommit: "${mathlibCommit}",`,
    `    admittedAt: "${admittedAt}",`,
    '    inspector: "inspector",',
  ];
  const measured = renderLimits(limits);
  if (measured !== undefined) lines.push(`    limits: ${measured},`);
  lines.push("  },");
  const { close } = tableExtent(source);
  // insert before the `]`, which sits on its own line
  const lineStart = source.lastIndexOf("\n", close) + 1;
  return `${source.slice(0, lineStart)}${lines.join("\n")}\n${source.slice(lineStart)}`;
}

/** `limits` as an object literal, or undefined when nothing was measured. */
function renderLimits(limits) {
  if (limits === undefined || limits === null) return undefined;
  const parts = [];
  for (const name of ["leanThreads", "memoryBytes"]) {
    const value = limits[name];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`refusing to record the limit ${name}: ${String(value)}`);
    }
    parts.push(`${name}: ${value}`);
  }
  return parts.length === 0 ? undefined : `{ ${parts.join(", ")} }`;
}
