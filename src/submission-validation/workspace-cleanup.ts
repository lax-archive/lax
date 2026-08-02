import fs from "node:fs";
import path from "node:path";

export function removeValidationWorkspace(directory: string): void {
  if (!fs.existsSync(directory)) return;
  makeDirectoriesWritable(directory);
  fs.rmSync(directory, { recursive: true, force: true });
}

function makeDirectoriesWritable(directory: string): void {
  fs.chmodSync(directory, 0o700);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) makeDirectoriesWritable(path.join(directory, entry.name));
  }
}
