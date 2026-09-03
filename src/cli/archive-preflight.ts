import fs from "node:fs";
import path from "node:path";
import { packageNameForSubmission, submissionIdForPackage } from "../submission-validation/contracts.js";
import { SUBMISSION_ID_PATTERN } from "../shared/constants.js";
import { databaseDirectory, type DatabaseRefreshResult } from "./database.js";
import { cmd, tilde } from "./ui.js";

interface LocalRecord {
  id: string;
  state: string;
  requirements: string[];
  /** Numeric owner ids; empty when the copy carries no readable owner list. */
  owners: number[];
  /** The successor claim in the record's build output, when it carries one. */
  supersedes?: string;
}

/**
 * Something the author should know before they confirm, and the fix if there is
 * one. In the author's nouns — *your copy of the archive*, not *the local
 * lax-database checkout* — because this text lands straight in the notes block
 * of `lax delete` and `lax register`.
 */
export interface PreflightNote {
  text: string;
  fix?: string;
}

export interface DeletePreflight {
  refusal?: string;
  warnings: PreflightNote[];
}

export function checkDeleteLocally(id: string, refresh: DatabaseRefreshResult): DeletePreflight {
  if (refresh === "missing") {
    return { warnings: [NO_LOCAL_COPY] };
  }
  let records: LocalRecord[];
  try {
    records = readRecords(databaseDirectory());
  } catch (error) {
    return {
      warnings: [{
        text: `Your copy of the archive could not be read: ${(error as Error).message}`,
        fix: `Move ${tilde(databaseDirectory())} aside, then run ${cmd("lax sync")}.`,
      }],
    };
  }
  const current = records.find((record) => record.id === id);
  const stale = refresh === "failed";
  const warnings: PreflightNote[] = [];
  if (stale) warnings.push(STALE_LOCAL_COPY);
  if (current === undefined) {
    const message = `${id} is not in your copy of the archive`;
    return stale ? { warnings: [...warnings, { text: message }] } : { refusal: message, warnings };
  }
  if (current.state === "registered" || current.state === "deleted") {
    const message =
      current.state === "registered"
        ? `${id} is registered, so it can never be changed or removed`
        : `${id} is already deleted and its id is retired`;
    if (!stale) return { refusal: message, warnings };
    warnings.push({ text: message });
  }
  const packageName = packageNameForSubmission(id);
  const dependents = records
    .filter(
      (record) =>
        record.id !== id &&
        record.state !== "deleted" &&
        record.requirements.some(
          (requirement) => requirement === packageName || requirement === `${packageName}Proofs`,
        ),
    )
    .map((record) => record.id)
    .sort();
  if (dependents.length > 0) {
    warnings.push({
      text:
        `${list(dependents)} ${dependents.length === 1 ? "builds" : "build"} on ${id} ` +
        "and will be left broken.",
    });
  }
  return { warnings };
}

export interface RegisterPreflight {
  refusal?: string;
  warnings: PreflightNote[];
}

export function checkRegisterLocally(id: string, refresh: DatabaseRefreshResult): RegisterPreflight {
  if (refresh === "missing") {
    return { warnings: [NO_LOCAL_COPY] };
  }
  let records: LocalRecord[];
  try {
    records = readRecords(databaseDirectory());
  } catch (error) {
    return {
      warnings: [{
        text: `Your copy of the archive could not be read: ${(error as Error).message}`,
        fix: `Move ${tilde(databaseDirectory())} aside, then run ${cmd("lax sync")}.`,
      }],
    };
  }
  const current = records.find((record) => record.id === id);
  const stale = refresh === "failed";
  const warnings: PreflightNote[] = [];
  if (stale) warnings.push(STALE_LOCAL_COPY);
  if (current === undefined) {
    const message = `${id} is not in your copy of the archive`;
    return stale ? { warnings: [...warnings, { text: message }] } : { refusal: message, warnings };
  }
  if (current.state === "registered" || current.state === "deleted") {
    const message =
      current.state === "registered"
        ? `${id} is already registered`
        : `${id} is deleted and its id is retired`;
    if (!stale) return { refusal: message, warnings };
    warnings.push({ text: message });
  }
  const states = new Map(records.map((record) => [record.id, record.state]));
  const blockers = dependencyIds(id, current.requirements)
    .map((dependency) => ({ dependency, state: states.get(dependency) }))
    .filter((entry) => entry.state !== "registered");
  if (blockers.length > 0) {
    const registrable = blockers
      .filter((entry) => entry.state !== undefined && entry.state !== "deleted")
      .map((entry) => entry.dependency);
    const message =
      "registration admits only registered dependencies — " +
      blockers
        .map(({ dependency, state }) => `${dependency} is ${state ?? "not in your copy of the archive"}`)
        .join(", ");
    const fix =
      registrable.length > 0
        ? `a chain lands bottom-up: register ${list(registrable)} first`
        : undefined;
    if (!stale) return { refusal: fix === undefined ? message : `${message}; ${fix}`, warnings };
    warnings.push(fix === undefined ? { text: message } : { text: message, fix });
  }
  const supersedesProblem = checkSupersedesLocally(current, records, warnings);
  if (supersedesProblem !== undefined) {
    if (!stale) return { refusal: supersedesProblem, warnings };
    warnings.push({ text: supersedesProblem });
  }
  noteSupersededDependencies(current, records, warnings);
  return { warnings };
}

/**
 * Registering freezes what this submission builds on, so a dependency — its
 * own, or one further up the chain — that a registered successor has replaced
 * belongs in front of the author now. A note, never a refusal: the pinned
 * requires keep working, and the archive admits the registration either way.
 * "Superseded" is derived the way the archive and the website derive it, from
 * registered claims only; a draft claimant is still provisional.
 */
function noteSupersededDependencies(
  current: LocalRecord,
  records: LocalRecord[],
  warnings: PreflightNote[],
): void {
  const byId = new Map(records.map((record) => [record.id, record]));
  const successors = new Map<string, string>();
  for (const record of records) {
    const target = record.supersedes;
    if (record.state !== "registered" || target === undefined) continue;
    if (target === record.id || !byId.has(target)) continue;
    const existing = successors.get(target);
    if (existing === undefined || compareIds(record.id, existing) < 0) successors.set(target, record.id);
  }
  if (successors.size === 0) return;
  // Breadth-first, so the recorded path to each dependency is the shortest
  // one — the fewest submissions to name in the note.
  const cameFrom = new Map<string, string>();
  const queue = [current.id];
  const seen = new Set([current.id]);
  while (queue.length > 0) {
    const id = queue.shift()!;
    const record = byId.get(id);
    if (record === undefined) continue;
    for (const dependency of dependencyIds(id, record.requirements)) {
      if (seen.has(dependency)) continue;
      seen.add(dependency);
      cameFrom.set(dependency, id);
      queue.push(dependency);
    }
  }
  const reached = [...seen].filter((id) => id !== current.id).sort(compareIds);
  for (const id of reached) {
    const successor = successors.get(id);
    // This submission superseding what it builds on is not a thing to fix.
    if (successor === undefined || successor === current.id) continue;
    const through: string[] = [];
    for (let step = cameFrom.get(id); step !== undefined && step !== current.id; step = cameFrom.get(step)) {
      through.unshift(step);
    }
    const latest = latestVersion(successors, id);
    warnings.push({
      text:
        `${id}, which ${current.id} builds on` +
        `${through.length === 0 ? "" : ` (through ${list(through)})`}, ` +
        `is superseded by ${successor}` +
        `${latest === successor || latest === current.id ? "" : `; the latest version is ${latest}`}.`,
      fix: "Registered submissions can never be changed — consider building on the latest version first.",
    });
  }
}

/** Follow bound successors to the newest version; `id` itself when current. */
function latestVersion(successors: ReadonlyMap<string, string>, id: string): string {
  const seen = new Set([id]);
  let current = id;
  for (;;) {
    const next = successors.get(current);
    if (next === undefined || seen.has(next)) return current;
    seen.add(next);
    current = next;
  }
}

function compareIds(left: string, right: string): number {
  return Number(left.slice("lax-".length)) - Number(right.slice("lax-".length));
}

/**
 * The supersedes claim binds when this submission registers, so the same
 * checks the archive will run come first here, in the author's nouns. A
 * problem is returned (refusal when the copy is fresh); an admissible claim
 * leaves a note instead — registering permanently marks the older submission
 * superseded, and that belongs next to the confirmation.
 */
function checkSupersedesLocally(
  current: LocalRecord,
  records: LocalRecord[],
  warnings: PreflightNote[],
): string | undefined {
  const target = current.supersedes;
  if (target === undefined) return undefined;
  const targetRecord = records.find((record) => record.id === target);
  if (targetRecord === undefined) {
    return `this submission declares it supersedes ${target}, which is not in your copy of the archive`;
  }
  if (targetRecord.state !== "registered") {
    return targetRecord.state === "deleted"
      ? `${target} is deleted and its id is retired; a deleted submission cannot be superseded`
      : `${target} is ${targetRecord.state}; only a registered submission can be superseded`;
  }
  const taken = records.find(
    (record) =>
      record.id !== current.id && record.supersedes === target && record.state === "registered",
  );
  if (taken !== undefined) {
    return `${taken.id} already supersedes ${target}; a submission has at most one successor`;
  }
  if (current.owners.length > 0 && targetRecord.owners.length > 0) {
    if (!targetRecord.owners.some((owner) => current.owners.includes(owner))) {
      return `no owner of ${target} owns ${current.id}; a submission can be superseded only by its own owners`;
    }
  } else {
    warnings.push({
      text: `Whether an owner of ${target} owns ${current.id} could not be checked here; the archive itself will decide.`,
    });
  }
  warnings.push({
    text: `Registering also makes ${target} permanently show as superseded by ${current.id}.`,
  });
  return undefined;
}

const NO_LOCAL_COPY: PreflightNote = {
  text: "There is no local copy of the archive, so nothing could be checked here first.",
  fix: `Run ${cmd("lax sync")} if you want that check before the archive decides.`,
};

const STALE_LOCAL_COPY: PreflightNote = {
  text: "Your copy of the archive could not be refreshed, so the archive itself will decide.",
};

/** `lax-8`, `lax-8 and lax-9`, `lax-8, lax-9 and lax-10`. */
function list(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]!}`;
}

/** The requirements are package names; non-Lax packages carry no record. */
function dependencyIds(id: string, requirements: string[]): string[] {
  const ids = new Set<string>();
  for (const name of requirements) {
    const dependency = submissionIdForPackage(name);
    if (dependency !== undefined && dependency !== id) ids.add(dependency);
  }
  return [...ids].sort(compareIds);
}

function readRecords(root: string): LocalRecord[] {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SUBMISSION_ID_PATTERN.test(entry.name))
    .map((entry) => {
      const directory = path.join(root, entry.name);
      const record = readObject(path.join(directory, "record.json"));
      const output = readObject(path.join(directory, "build-output.json"));
      const requirements = [output.requiredByConcepts, output.requiredByProofs].flatMap((value) =>
        Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [],
      );
      const supersedes = readSupersedes(output);
      return {
        id: entry.name,
        state: typeof record.state === "string" ? record.state : "invalid",
        requirements,
        owners: readLocalOwners(directory),
        ...(supersedes === undefined ? {} : { supersedes }),
      };
    });
}

/** The claim `lax submit` echoed under inputs.manifest, read leniently: a
 * value this reader cannot make sense of is a stale-copy problem, and the
 * archive itself re-checks everything. */
function readSupersedes(output: Record<string, unknown>): string | undefined {
  const inputs = output.inputs;
  if (inputs === null || typeof inputs !== "object" || Array.isArray(inputs)) return undefined;
  const manifest = (inputs as Record<string, unknown>).manifest;
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) return undefined;
  const value = (manifest as Record<string, unknown>).supersedes;
  return typeof value === "string" && SUBMISSION_ID_PATTERN.test(value) ? value : undefined;
}

/** Numeric owner ids, or empty when the copy has no readable owner list. */
function readLocalOwners(directory: string): number[] {
  try {
    const value = readObject(path.join(directory, "owner-list.json"));
    if (!Array.isArray(value.owners)) return [];
    return value.owners.flatMap((owner) =>
      owner !== null &&
      typeof owner === "object" &&
      typeof (owner as Record<string, unknown>).githubId === "number"
        ? [(owner as Record<string, unknown>).githubId as number]
        : [],
    );
  } catch {
    return [];
  }
}

function readObject(filename: string): Record<string, unknown> {
  const value = JSON.parse(fs.readFileSync(filename, "utf8")) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${filename} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}
