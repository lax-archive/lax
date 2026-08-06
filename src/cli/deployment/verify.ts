import fs from "node:fs";
import path from "node:path";
import {
  directoryDigest,
  metadataFile,
  readLock,
  repositoryRoot,
  runtimeDirectory,
} from "./shared.js";

const lock = readLock();
if (!fs.existsSync(metadataFile) || !fs.existsSync(runtimeDirectory)) {
  throw new Error("packaged page-builder and metadata are required");
}
const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8")) as {
  repository?: string;
  revision?: string;
  bundleSha256?: string;
};
const bundleSha256 = directoryDigest(runtimeDirectory);
if (
  metadata.repository !== lock.repository ||
  metadata.revision !== lock.revision ||
  metadata.bundleSha256 !== bundleSha256
) {
  throw new Error("packaged page-builder metadata does not match its lock or bytes");
}
for (const relative of [
  "package.json",
  "dist/sitegen/generate.js",
  "dist/sitegen/assets.js",
  "assets/site",
  "content/landing.md",
  "content/contributing.md",
]) {
  if (!fs.existsSync(path.join(runtimeDirectory, relative))) {
    throw new Error(`page-builder runtime bundle is missing ${relative}`);
  }
}
// The vendored bundle resolves its bare imports (katex, marked, shiki) from
// the CLI package's own node_modules, so every page-builder runtime dependency
// must be declared by the CLI with the exact range the pinned revision asks
// for — otherwise a pin bump can ship a bundle whose imports break at runtime.
const bundleDependencies = (
  JSON.parse(fs.readFileSync(path.join(runtimeDirectory, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  }
).dependencies ?? {};
const cliDependencies = (
  JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  }
).dependencies ?? {};
for (const [name, range] of Object.entries(bundleDependencies)) {
  if (cliDependencies[name] !== range) {
    throw new Error(
      `page-builder depends on ${name}@${range}, but the CLI package declares ` +
        `${cliDependencies[name] ?? "nothing"}; align package.json with the pinned revision`,
    );
  }
}
console.log(`Verified bundled page-builder revision ${lock.revision}.`);
