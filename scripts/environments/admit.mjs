#!/usr/bin/env node
// Append an admitted environment to the table.
//
//   node scripts/environments/admit.mjs --id v4.34.0 --commit <40 hex> \
//     [--memory-bytes N] [--lean-threads N] [--date YYYY-MM-DD]
//
// Step 3 of `.github/workflows/environments.yml`: the green test legs measured
// the environment, and this writes the one row that admits it. The job then
// opens a pull request with its own token — this script never commits, never
// pushes, and holds no credential.
//
// The table only grows and an entry is never edited afterwards except to add
// `limits` or `closedAt` (environments-plan.md, "The environment table"), so
// admitting an id that is already there is an error, not an update. `limits`
// is written only when the run measured something; without a measurement the
// entry inherits DEFAULT_LIMITS, which is the honest state.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendEntry, TABLE_FILE } from "./table.mjs";

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
    const next = argv[index + 1];
    if (next === undefined) throw new Error(`${argument} needs a value`);
    values.set(argument.slice(2), next);
    index += 1;
  }
  return values;
}

function positiveInteger(values, name) {
  const raw = values.get(name);
  if (raw === undefined) return undefined;
  if (!/^[0-9]+$/u.test(raw)) throw new Error(`--${name} must be a positive integer, got ${raw}`);
  return Number(raw);
}

/** Today in UTC, so a run near midnight records the date its log carries. */
export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function admit(source, values) {
  const limits = {
    leanThreads: positiveInteger(values, "lean-threads"),
    memoryBytes: positiveInteger(values, "memory-bytes"),
  };
  const measured = limits.leanThreads === undefined && limits.memoryBytes === undefined
    ? undefined
    : limits;
  return appendEntry(source, {
    id: values.get("id"),
    mathlibCommit: values.get("commit"),
    admittedAt: values.get("date") ?? today(),
    limits: measured,
  });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let updated;
  try {
    updated = admit(fs.readFileSync(TABLE_FILE, "utf8"), parseArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(`admit: ${error.message}`);
    process.exit(1);
  }
  fs.writeFileSync(TABLE_FILE, updated);
  console.log(`admitted into ${path.relative(process.cwd(), TABLE_FILE)}`);
}
