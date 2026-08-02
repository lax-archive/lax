import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const assetPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "assets",
  "apache-2.0.txt",
);

let normalizedCanonical: string | undefined;

export function isAcceptedLicense(content: string): boolean {
  normalizedCanonical ??= normalize(fs.readFileSync(assetPath, "utf8"));
  if (normalize(content) === normalizedCanonical) return true;
  const lines = content.trimEnd().split("\n");
  return normalize(lines.slice(0, -1).join("\n")) === normalizedCanonical;
}

function normalize(value: string): string {
  return value.split(/\s+/u).filter(Boolean).join(" ");
}
