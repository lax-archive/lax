import fs from "node:fs";
import path from "node:path";
import { packageNameForSubmission } from "../submission-validation/contracts.js";
import { SUBMISSION_ID_PATTERN } from "../shared/constants.js";
import { databaseDirectory, type DatabaseRefreshResult } from "./database.js";

interface LocalRecord {
  id: string;
  state: string;
  requirements: string[];
}

export interface DeletePreflight {
  refusal?: string;
  warnings: string[];
}

export function checkDeleteLocally(id: string, refresh: DatabaseRefreshResult): DeletePreflight {
  if (refresh === "missing") {
    return {
      warnings: [
        "no local lax-database checkout; lifecycle state and dependent submissions could not be checked",
      ],
    };
  }
  let records: LocalRecord[];
  try {
    records = readRecords(databaseDirectory());
  } catch (error) {
    return { warnings: [`local lax-database could not be read: ${(error as Error).message}`] };
  }
  const current = records.find((record) => record.id === id);
  const stale = refresh === "failed";
  const warnings: string[] = [];
  if (stale) warnings.push("local lax-database could not be refreshed; GitHub will make the final decision");
  if (current === undefined) {
    const message = `${id} does not exist in the local lax-database`;
    return stale ? { warnings: [...warnings, message] } : { refusal: message, warnings };
  }
  if (current.state === "registered" || current.state === "deleted") {
    const message =
      current.state === "registered"
        ? `${id} is registered and immutable`
        : `${id} is already deleted and its id is retired`;
    if (!stale) return { refusal: message, warnings };
    warnings.push(message);
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
    warnings.push(`deleting ${id} will strand ${dependents.join(", ")}`);
  }
  return { warnings };
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
