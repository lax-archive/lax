import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { epoch, type ArchiveEnvironment } from "../submission-validation/environments.js";
import { supportedEnvironment } from "./environments.js";

// `lax print` writes documents, not reports: the reader is an agent about to
// work from them (or a pipe on the way to one), so both printers hand over the
// file's own bytes and deliberately never go through `ui`.

/**
 * The specification governing an environment: spec 1 is `spec.md`; spec 2 is
 * `spec_v2_draft.md` until Jan reconciles it into spec.md (axiomfree-plan.md,
 * "Decisions taken while drafting the spec"). The draft is announced with
 * one line on stderr, so stdout stays the document itself.
 */
export function printSpec(options: { env?: string } = {}): void {
  const environment = options.env === undefined ? epoch() : supportedEnvironment(options.env);
  const { file, banner } = specDocument(environment);
  if (banner !== undefined) process.stderr.write(`${banner}\n`);
  process.stdout.write(fs.readFileSync(packagedFile(file), "utf8"));
}

/** Which bundled document governs the environment, and the banner it needs. */
export function specDocument(environment: ArchiveEnvironment): { file: string; banner?: string } {
  if (environment.specVersion === 2) {
    return {
      file: "spec_v2_draft.md",
      banner:
        `# ${environment.id} follows spec 2; this is its draft specification, normative once reconciled into spec.md`,
    };
  }
  return { file: "spec.md" };
}

/**
 * The brief a user pastes into their agent: how to formalize a result here.
 * Each spec has its own guide, chosen like the specification: by `--env`,
 * else the epoch's.
 */
export function printInstructions(options: { env?: string } = {}): void {
  const environment = options.env === undefined ? epoch() : supportedEnvironment(options.env);
  process.stdout.write(fs.readFileSync(packagedFile("assets", instructionsDocument(environment)), "utf8"));
}

/** Which bundled guide (under `assets/`) speaks for the environment's spec. */
export function instructionsDocument(environment: ArchiveEnvironment): string {
  return environment.specVersion === 2 ? "instructions-spec2.md" : "instructions.md";
}

/** A file shipped beside `dist/` — all of these are in package.json's `files`. */
function packagedFile(...parts: string[]): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ...parts);
}
