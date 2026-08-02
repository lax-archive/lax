import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function printSpec(): void {
  const filename = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "spec.md",
  );
  process.stdout.write(fs.readFileSync(filename, "utf8"));
}
