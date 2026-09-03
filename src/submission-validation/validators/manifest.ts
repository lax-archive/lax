import { parse } from "yaml";
import type { PaperManifest, SubmissionManifest, ValidationRuntimeIdentity } from "../contracts.js";
import type { FindingCollector } from "../findings.js";
import {
  normalizeSubmissionId,
  normalizeTitle,
  PAPER_ENGINES,
  validateFolder,
  validatePaperMain,
} from "../../shared/validation.js";
import { isValidBibtex } from "./bibtex.js";

const MANIFEST_KEYS = new Set([
  "specVersion",
  "id",
  "leanVersion",
  "mathlibVersion",
  "title",
  "authors",
  "bibEntries",
]);
const OPTIONAL_MANIFEST_KEYS = new Set(["supersedes", "paper"]);
const PAPER_KEYS = new Set(["folder", "main", "engine", "web"]);
const AUTHOR_KEYS = new Set(["name", "orcid", "github"]);

export function validateManifest(
  content: string,
  submissionId: string,
  runtime: ValidationRuntimeIdentity,
  findings: FindingCollector,
): SubmissionManifest | undefined {
  if (Buffer.byteLength(content, "utf8") > 256 * 1024) {
    findings.violate("manifest", "manifest.yaml exceeds 256 KiB");
    return undefined;
  }
  let value: unknown;
  try {
    value = parse(content, { maxAliasCount: 0, merge: false, uniqueKeys: true });
  } catch (error) {
    findings.violate("manifest", `manifest.yaml is not valid YAML: ${(error as Error).message}`);
    return undefined;
  }
  if (!plainObject(value)) {
    findings.violate("manifest", "manifest.yaml must be a YAML mapping");
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (!MANIFEST_KEYS.has(key) && !OPTIONAL_MANIFEST_KEYS.has(key))
      findings.violate("manifest", `manifest.yaml: unknown key \`${key}\``);
  }
  for (const key of MANIFEST_KEYS) {
    if (!(key in value)) findings.violate("manifest", `manifest.yaml: missing key \`${key}\``);
  }

  const stringField = (key: string, limit: number): string | undefined => {
    const field = value[key];
    if (typeof field !== "string") {
      if (field !== undefined) findings.violate("manifest", `manifest.yaml: \`${key}\` must be a string`);
      return undefined;
    }
    const normalized = field.normalize("NFC");
    if (Buffer.byteLength(normalized, "utf8") > limit)
      findings.violate("manifest", `manifest.yaml: \`${key}\` exceeds ${limit} UTF-8 bytes`);
    if (/\r|\u0000|\u2028|\u2029/u.test(normalized))
      findings.violate("manifest", `manifest.yaml: \`${key}\` contains a forbidden control character`);
    return normalized;
  };

  const specVersion = stringField("specVersion", 32);
  const rawId = stringField("id", 64);
  let id: string | undefined;
  if (rawId !== undefined) {
    try {
      // `lax-0` is a well-formed id here so that an offline scaffold gets the
      // equality violation below rather than a syntax one. In the trusted path
      // `submissionId` comes from the issue number, so a `lax-0` manifest is
      // refused either way — this only decides which sentence the author reads.
      id = normalizeSubmissionId(rawId, { placeholder: true });
    } catch (error) {
      findings.violate("manifest", `manifest.yaml: ${(error as Error).message}`);
    }
  }
  const leanVersion = stringField("leanVersion", 64);
  const mathlibVersion = stringField("mathlibVersion", 64);
  const rawTitle = stringField("title", 512);
  let title = rawTitle;
  if (rawTitle !== undefined) {
    try {
      title = normalizeTitle(rawTitle);
    } catch (error) {
      findings.violate("manifest", `manifest.yaml: ${(error as Error).message}`);
    }
  }
  if (specVersion !== undefined && specVersion !== "1")
    findings.violate("manifest", "manifest.yaml: specVersion must be \"1\"");
  const expectedId = submissionId;
  if (id !== undefined && id !== expectedId)
    findings.violate(
      "manifest",
      `manifest.yaml: id must be ${expectedId} or Lax${expectedId.slice("lax-".length)}, got ${rawId}`,
    );
  if (leanVersion !== undefined && leanVersion !== runtime.leanVersion)
    findings.violate("manifest", `manifest.yaml: leanVersion must be ${runtime.leanVersion}`);
  if (mathlibVersion !== undefined && mathlibVersion !== runtime.mathlibCommit)
    findings.violate("manifest", `manifest.yaml: mathlibVersion must be ${runtime.mathlibCommit}`);

  let supersedes: string | undefined;
  if ("supersedes" in value) {
    const rawSupersedes = stringField("supersedes", 64);
    if (rawSupersedes !== undefined) {
      try {
        supersedes = normalizeSubmissionId(rawSupersedes);
      } catch (error) {
        findings.violate("manifest", `manifest.yaml: supersedes: ${(error as Error).message}`);
      }
    }
    if (supersedes !== undefined && supersedes === expectedId) {
      findings.violate("manifest", "manifest.yaml: a submission cannot supersede itself");
      supersedes = undefined;
    }
  }

  let paper: PaperManifest | undefined;
  if ("paper" in value) paper = validatePaperBlock(value.paper, findings);

  const authors = [] as SubmissionManifest["authors"];
  if (!Array.isArray(value.authors) || value.authors.length > 100) {
    findings.violate("manifest", "manifest.yaml: authors must be a list of at most 100 entries");
  } else {
    for (const [index, authorValue] of value.authors.entries()) {
      if (!plainObject(authorValue)) {
        findings.violate("manifest", `manifest.yaml: authors[${index}] must be a mapping`);
        continue;
      }
      for (const key of Object.keys(authorValue))
        if (!AUTHOR_KEYS.has(key)) findings.violate("manifest", `manifest.yaml: authors[${index}]: unknown key \`${key}\``);
      if (typeof authorValue.name !== "string" || authorValue.name.trim() === "") {
        findings.violate("manifest", `manifest.yaml: authors[${index}].name is required`);
        continue;
      }
      const author = { name: authorValue.name.normalize("NFC") } as SubmissionManifest["authors"][number];
      if (typeof authorValue.orcid === "string") author.orcid = authorValue.orcid;
      else if (authorValue.orcid !== undefined)
        findings.violate("manifest", `manifest.yaml: authors[${index}].orcid must be a string`);
      if (typeof authorValue.github === "string") author.github = authorValue.github;
      else if (authorValue.github !== undefined)
        findings.violate("manifest", `manifest.yaml: authors[${index}].github must be a string`);
      authors.push(author);
    }
  }

  const bibEntries: string[] = [];
  if (!Array.isArray(value.bibEntries) || value.bibEntries.length > 1_000) {
    findings.violate("manifest", "manifest.yaml: bibEntries must be a list of at most 1,000 strings");
  } else {
    value.bibEntries.forEach((entry, index) => {
      if (typeof entry !== "string") findings.violate("manifest", `manifest.yaml: bibEntries[${index}] must be a string`);
      else if (Buffer.byteLength(entry, "utf8") > 16 * 1024)
        findings.violate("manifest", `manifest.yaml: bibEntries[${index}] exceeds 16 KiB`);
      else {
        const normalized = entry.replace(/\r\n?/gu, "\n").normalize("NFC");
        if (!isValidBibtex(normalized))
          findings.violate(
            "manifest",
            `manifest.yaml: bibEntries[${index}] must contain one or more complete BibTeX entries`,
          );
        else bibEntries.push(normalized);
      }
    });
  }

  if ([specVersion, id, leanVersion, mathlibVersion, title].some((entry) => entry === undefined)) return undefined;
  return {
    specVersion: specVersion!,
    id: id!,
    leanVersion: leanVersion!,
    mathlibVersion: mathlibVersion!,
    title: title!,
    authors,
    bibEntries,
    ...(supersedes === undefined ? {} : { supersedes }),
    ...(paper === undefined ? {} : { paper }),
  };
}

/**
 * The optional `paper` block (paper-plan.md, "Manifest"): a folder inside the
 * submission, an entry file inside that folder, and an engine — the three
 * choices an author also carries to arXiv. Shape only; that the folder and
 * file exist is the static gate's check, with the tree in hand.
 */
function validatePaperBlock(value: unknown, findings: FindingCollector): PaperManifest | undefined {
  if (!plainObject(value)) {
    findings.violate("manifest", "manifest.yaml: `paper` must be a mapping with `folder`, `main`, and optionally `engine`");
    return undefined;
  }
  let ok = true;
  for (const key of Object.keys(value)) {
    if (!PAPER_KEYS.has(key)) {
      findings.violate("manifest", `manifest.yaml: paper: unknown key \`${key}\``);
      ok = false;
    }
  }
  let folder: string | undefined;
  if (!("folder" in value)) findings.violate("manifest", "manifest.yaml: paper: missing key `folder`");
  else {
    try {
      folder = validateFolder(value.folder);
    } catch (error) {
      findings.violate("manifest", `manifest.yaml: paper.${(error as Error).message}`);
    }
  }
  let main: string | undefined;
  if (!("main" in value)) findings.violate("manifest", "manifest.yaml: paper: missing key `main`");
  else {
    try {
      main = validatePaperMain(value.main);
    } catch (error) {
      findings.violate("manifest", `manifest.yaml: ${(error as Error).message}`);
    }
  }
  let engine: PaperManifest["engine"] = "pdflatex";
  if ("engine" in value) {
    const raw = value.engine;
    if (typeof raw === "string" && (PAPER_ENGINES as readonly string[]).includes(raw)) {
      engine = raw as PaperManifest["engine"];
    } else {
      findings.violate("manifest", `manifest.yaml: paper.engine must be one of ${PAPER_ENGINES.join(", ")}`);
      ok = false;
    }
  }
  // The derived web view's opt-out (paper-web-plan.md, "Author-facing
  // contract"): a boolean, default true. `web: false` means the reflow
  // derivation is not attempted at all — no warning either.
  let web: boolean | undefined;
  if ("web" in value) {
    if (typeof value.web === "boolean") {
      web = value.web;
    } else {
      findings.violate("manifest", "manifest.yaml: paper.web must be true or false");
      ok = false;
    }
  }
  if (!ok || folder === undefined || main === undefined) return undefined;
  return { folder, main, engine, ...(web === undefined ? {} : { web }) };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
