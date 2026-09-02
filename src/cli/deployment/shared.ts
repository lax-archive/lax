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

/** Top-level manifest of the third-party components the packaged
 * page-builder aggregates, written by page-builder:package and re-derived
 * by page-builder:verify. */
export const NOTICES_FILENAME = "THIRD-PARTY-NOTICES.txt";

/**
 * What the page-builder tree may vendor beside lax's own Apache-2.0 code,
 * and the license text that must travel with each component. The AGPL
 * viewer rides under the aggregation-with-notices decision
 * (paper-web-plan.md, "Risks"): lax's code stays Apache, the component
 * keeps its license, and the tarball says so. `marker` is the file (or
 * directory) whose presence means the component's bytes are in the tree —
 * a marker without its license file fails the packaging, so a pin bump can
 * never ship vendored code label-incorrectly. Components the pinned
 * revision predates are simply absent from that revision's manifest.
 */
const THIRD_PARTY_COMPONENTS = [
  {
    name: "Latin Modern fonts",
    license: "GUST Font License",
    licenseFile: "assets/site/GUST-FONT-LICENSE.txt",
    marker: "assets/site/fonts",
    upstream: "https://www.gust.org.pl/projects/e-foundry/latin-modern",
  },
  {
    name: "pdf.js",
    license: "Apache-2.0",
    licenseFile: "assets/site/pdfjs/LICENSE.txt",
    marker: "assets/site/pdfjs/pdf.min.mjs",
    versionFile: "assets/site/pdfjs/VERSION.txt",
    upstream: "https://github.com/mozilla/pdf.js",
  },
  {
    name: "ReflowTeX viewer",
    license: "AGPL-3.0-or-later",
    licenseFile: "assets/site/reflowtex/LICENSE.txt",
    marker: "assets/site/reflowtex/latex-viewer.js",
    upstream: "https://github.com/radek-p/reflowtex",
  },
] as const;

/**
 * The deterministic notices manifest for one extracted page-builder tree:
 * an entry per vendored component found in it, in the fixed table order,
 * derived from nothing but the tree's contents. Throws on a tree that
 * vendors a component without its license text.
 */
export function thirdPartyNotices(root: string): string {
  const entries: string[] = [];
  for (const component of THIRD_PARTY_COMPONENTS) {
    const hasMarker = fs.existsSync(path.join(root, component.marker));
    const hasLicense = fs.existsSync(path.join(root, component.licenseFile));
    if (hasMarker && !hasLicense) {
      throw new Error(
        `page-builder vendors ${component.name} (${component.marker}) without its ` +
          `license text at ${component.licenseFile}`,
      );
    }
    if (!hasLicense) continue;
    const versionFile = "versionFile" in component ? component.versionFile : undefined;
    const version =
      versionFile !== undefined && fs.existsSync(path.join(root, versionFile))
        ? fs.readFileSync(path.join(root, versionFile), "utf8").trim()
        : undefined;
    entries.push(
      [
        `- ${component.name}${version === undefined ? "" : ` ${version}`}`,
        `  License: ${component.license} (${component.licenseFile})`,
        `  Files: ${component.marker}`,
        `  Upstream: ${component.upstream}`,
      ].join("\n"),
    );
  }
  return (
    "Third-party notices for the vendored lax-website page-builder\n" +
    "=============================================================\n\n" +
    "This bundle aggregates the following third-party components beside\n" +
    "lax's own Apache-2.0 code. Each component remains under its own\n" +
    "license; the license texts travel inside this bundle at the paths\n" +
    "named below.\n\n" +
    `${entries.join("\n\n")}\n`
  );
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
