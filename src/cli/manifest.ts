import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { PLACEHOLDER_SUBMISSION_ID } from "../shared/constants.js";
import { normalizeSubmissionId } from "../shared/validation.js";
import * as ui from "./ui.js";

/**
 * The id a local submission folder carries.
 *
 * `lax-0` is one of the answers: `lax init --offline` scaffolds with it, and
 * everything that runs on this machine — `lax build`, `lax serve`,
 * `lax doctor` — works with it unchanged. The commands that reach the archive
 * go through `issueNumberFromFolder` instead, which refuses it.
 */
export function submissionIdFromFolder(folder: string): string {
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
  try {
    return normalizeSubmissionId(id, { placeholder: true });
  } catch {
    throw new Error(`${filename} must contain an id of the form lax-N or LaxN`);
  }
}

/**
 * The issue number behind a submission folder, for the commands that post to
 * the archive.
 *
 * An offline scaffold has none: nothing was ever reserved for it, so the
 * placeholder is refused here rather than turned into issue 0.
 */
export function issueNumberFromFolder(folder: string): number {
  const id = submissionIdFromFolder(folder);
  if (id === PLACEHOLDER_SUBMISSION_ID) {
    throw new Error(
      `${ui.tilde(path.resolve(folder))} carries the placeholder id ${PLACEHOLDER_SUBMISSION_ID}.\n` +
        "It was scaffolded offline, so the archive never allocated an id for it — and\n" +
        `there is no issue to post to. Run ${ui.cmd("lax init")} in a fresh folder for a real id\n` +
        "and move the sources across: package names, imports and namespaces carry it.",
    );
  }
  return Number(id.slice("lax-".length));
}
