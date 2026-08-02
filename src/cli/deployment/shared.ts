import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface WebsiteSourceLock {
  repository: string;
  revision: string;
}

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const buildRoot = path.join(repositoryRoot, ".build", "page-builder");
export const sourceDirectory = path.join(buildRoot, "source");
export const vendorDirectory = path.join(repositoryRoot, "dist", "cli", "vendor");
export const archiveFile = path.join(vendorDirectory, "page-builder.tgz");
export const metadataFile = path.join(vendorDirectory, "page-builder.json");
export const runtimeDirectory = path.join(vendorDirectory, "page-builder");

export function readLock(): WebsiteSourceLock {
  const file = path.join(
    repositoryRoot,
    "src",
    "cli",
    "deployment",
    "website-source.lock.json",
  );
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<WebsiteSourceLock>;
  if (
    typeof value.repository !== "string" ||
    value.repository !== "https://github.com/lax-archive/lax-website.git" ||
    typeof value.revision !== "string" ||
    !/^[0-9a-f]{40}$/u.test(value.revision)
  ) {
    throw new Error("website-source.lock.json must pin lax-website to a full commit SHA");
  }
  return value as WebsiteSourceLock;
}

/** Hash an extracted package deterministically, including every relative path. */
export function directoryDigest(root: string): string {
  const digest = createHash("sha256");
  const visit = (directory: string, prefix: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name))) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`page-builder package contains a symlink: ${relative}`);
      if (entry.isDirectory()) {
        visit(file, relative);
      } else if (entry.isFile()) {
        const bytes = fs.readFileSync(file);
        digest.update(`${relative}\0${bytes.length}\0`, "utf8");
        digest.update(bytes);
      } else {
        throw new Error(`page-builder package contains an unsupported entry: ${relative}`);
      }
    }
  };
  visit(root, "");
  return digest.digest("hex");
}
