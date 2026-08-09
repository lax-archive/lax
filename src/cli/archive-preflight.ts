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
  return { warnings };
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
  return [...ids].sort((left, right) => Number(left.slice("lax-".length)) - Number(right.slice("lax-".length)));
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
      return {
        id: entry.name,
        state: typeof record.state === "string" ? record.state : "invalid",
        requirements,
      };
    });
}

function readObject(filename: string): Record<string, unknown> {
  const value = JSON.parse(fs.readFileSync(filename, "utf8")) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${filename} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}
