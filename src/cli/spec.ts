import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `lax print` writes documents, not reports: the reader is an agent about to
// work from them (or a pipe on the way to one), so both printers hand over the
// file's own bytes and deliberately never go through `ui`.

export function printSpec(): void {
  process.stdout.write(fs.readFileSync(packagedFile("spec.md"), "utf8"));
}

/** The brief a user pastes into their agent: how to formalize a result here. */
export function printInstructions(): void {
  process.stdout.write(fs.readFileSync(packagedFile("assets", "instructions.md"), "utf8"));
}

/** A file shipped beside `dist/` — both of these are in package.json's `files`. */
function packagedFile(...parts: string[]): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ...parts);
}
