import fs from "node:fs";
import path from "node:path";
import {
  directoryDigest,
  metadataFile,
  NOTICES_FILENAME,
  readLock,
  repositoryRoot,
  runtimeDirectory,
  thirdPartyNotices,
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
// Once a renderer release ships the paper viewers, this list (and
// REQUIRED_RENDERER_PATHS in src/cli/website-renderer.ts) also names
// "assets/site/pdfjs", "assets/site/reflowtex", and "assets/site/manuscript.js"
// — a release-step edit, since the current pin predates those files.
for (const relative of [
  "package.json",
  "dist/sitegen/generate.js",
  "dist/sitegen/assets.js",
  "assets/site",
  "content/landing.md",
  "content/contributing.md",
  NOTICES_FILENAME,
]) {
  if (!fs.existsSync(path.join(runtimeDirectory, relative))) {
    throw new Error(`page-builder runtime bundle is missing ${relative}`);
  }
}
// The notices manifest must say exactly what the tree it ships in vendors:
// re-derive it from the packaged bytes (which also re-fails a component
// vendored without its license text) and require the stored file to match.
const expectedNotices = thirdPartyNotices(runtimeDirectory);
if (fs.readFileSync(path.join(runtimeDirectory, NOTICES_FILENAME), "utf8") !== expectedNotices) {
  throw new Error("packaged third-party notices do not match the components the bundle vendors");
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
