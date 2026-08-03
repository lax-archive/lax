import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { normalizeSubmissionId } from "../shared/validation.js";

/** Resolve the authoritative issue number from a local submission manifest. */
export function issueNumberFromFolder(folder: string): number {
  const root = path.resolve(folder);
  const filename = path.join(root, "manifest.yaml");
  let value: unknown;
  try {
    value = parse(fs.readFileSync(filename, "utf8"), {
      maxAliasCount: 0,
      merge: false,
      uniqueKeys: true,
    });
  } catch (error) {
    throw new Error(`could not read ${filename}: ${(error as Error).message}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${filename} must be a YAML mapping`);
  }
  const id = (value as Record<string, unknown>).id;
  if (typeof id !== "string")
    throw new Error(`${filename} must contain an id of the form lax-N or LaxN`);
  let canonical: string;
  try {
    canonical = normalizeSubmissionId(id);
  } catch {
    throw new Error(`${filename} must contain an id of the form lax-N or LaxN`);
  }
  return Number(canonical.slice("lax-".length));
}

export function submissionIdFromFolder(folder: string): string {
  return `lax-${issueNumberFromFolder(folder)}`;
}
