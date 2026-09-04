// The author-facing side of the environment table: choosing one on the command
// line, saying what choosing a non-epoch one costs, and counting who is already
// there.
//
// The table itself (submission-validation/environments.ts) is the authority and
// the only thing an id is ever used for is a lookup in it (trust rule 2). What
// lives here is the CLI's half: the `--env` option of `lax init`, `lax doctor`
// and `lax port`, the typed confirmation an off-epoch choice needs, and the
// disk statement a second environment on a machine earns.

import fs from "node:fs";
import path from "node:path";
import { SUBMISSION_ID_PATTERN } from "../shared/constants.js";
import { isObject } from "../shared/validation.js";
import {
  admittedEnvironmentList,
  environment as environmentById,
  environments,
  epoch,
  type ArchiveEnvironment,
} from "../submission-validation/environments.js";
import { warmDir, warmReady } from "../submission-validation/host/warmstore.js";
import { confirmTyped } from "./confirm.js";
import { databaseDirectory } from "./database.js";
import * as ui from "./ui.js";

/**
 * The entry an author named with `--env`, or the epoch when they named
 * nothing. An id the table does not admit is refused in the words the static
 * gate refuses an unknown `leanVersion` in, because it is the same table and
 * the same cause: an environment newer than the installed CLI.
 */
export function requestedEnvironment(id: string | undefined): ArchiveEnvironment {
  if (id === undefined) return epoch();
  const entry = environmentById(id);
  if (entry !== undefined) return entry;
  throw new Error(
    `${id} is not an archive environment. ` +
      `Admitted: ${admittedEnvironmentList()}. ` +
      "Update lax if the environment is newer than this CLI.",
  );
}

/** Whether this machine can build in an environment: its warm mathlib store is
 * ready. The toolchain alone is not enough and is provisioned with the store. */
export function environmentInstalled(entry: ArchiveEnvironment): boolean {
  return warmReady(warmDir(entry));
}

/** The admitted environments this machine has a warm store for. */
export function installedEnvironments(): ArchiveEnvironment[] {
  return environments().filter((entry) => environmentInstalled(entry));
}

/**
 * How many registered submissions each environment holds, read from this
 * machine's copy of the archive. A record's environment is its
 * `manifest.leanVersion` and nothing else — no schema of its own — so this is a
 * scan of `build-output.json`, guarded by `record.json`'s state.
 *
 * `undefined` means there is no local copy to count, which is a different
 * answer from "none": the caller says `lax sync` rather than "0".
 */
export function registeredByEnvironment(): Map<string, number> | undefined {
  const database = databaseDirectory();
  if (!fs.existsSync(path.join(database, ".git"))) return undefined;
  const counts = new Map<string, number>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(database, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !SUBMISSION_ID_PATTERN.test(entry.name)) continue;
    const record = readJson(path.join(database, entry.name, "record.json"));
    if (!isObject(record) || record.state !== "registered") continue;
    const output = readJson(path.join(database, entry.name, "build-output.json"));
    const manifest = isObject(output) && isObject(output.inputs) ? output.inputs.manifest : undefined;
    const id = isObject(manifest) && typeof manifest.leanVersion === "string" ? manifest.leanVersion : undefined;
    if (id === undefined) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/**
 * The block an author sees before a submission is created outside the epoch,
 * and the typed confirmation under it.
 *
 * Straying is allowed and nudged, never refused: what the author has to
 * understand is the one consequence they cannot undo later, which is that the
 * work joins a different island. So the block is the two populations and that
 * sentence, and the acknowledgement is the id typed out — the same shape `lax
 * delete` and `lax register` use for the other two decisions that cannot be
 * taken back.
 */
export async function confirmEnvironment(
  entry: ArchiveEnvironment,
  options: { yes?: boolean } = {},
): Promise<boolean> {
  if (entry.id === epoch().id) return true;
  ui.title(`Environment ${entry.id}`);
  const counts = registeredByEnvironment();
  if (counts === undefined) {
    ui.line(`${epoch().id} is the archive's epoch, ${entry.id} is not — run ${ui.cmd("lax sync")} to`);
    ui.line("count the registered submissions in each.");
  } else {
    ui.line(
      `${epoch().id} is the archive's epoch, with ` +
        `${ui.plural(counts.get(epoch().id) ?? 0, "registered submission")};`,
    );
    ui.line(`${entry.id} has ${ui.count(counts.get(entry.id) ?? 0)}.`);
  }
  ui.line(`Only submissions in ${entry.id} can cite this work.`);
  ui.blank();
  if (options.yes === true) return true;
  return confirmTyped({ expected: entry.id, action: `creating a submission in ${entry.id}` });
}

/** Roughly what an environment costs on disk: the warm mathlib store plus the
 * toolchain elan installs under it. Measured at v4.30.0 and stable enough to
 * state as a range. */
export const ENVIRONMENT_DISK_NOTE =
  "roughly 10 GB (a mathlib store of about 7.5 GB and a toolchain of 2 to 4 GB)";

/**
 * The lines to print before provisioning `entry`, or none.
 *
 * Only a *second* environment earns them: the first one is what `lax doctor`
 * and every build already download and the author was told about there, while
 * the second is a cost they chose by naming `--env` and should see before it
 * starts rather than after.
 */
export function diskCostLines(entry: ArchiveEnvironment): string[] {
  if (environmentInstalled(entry)) return [];
  const installed = installedEnvironments();
  if (installed.length === 0) return [];
  return [
    `${entry.id} is a second environment on this machine — it needs its own`,
    `mathlib store and toolchain, ${ENVIRONMENT_DISK_NOTE}.`,
    `Installed: ${installed.map((other) => other.id).join(", ")}.`,
  ];
}

function readJson(filename: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filename, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}
