import { parse } from "yaml";
import type { SubmissionManifest, ValidationRuntimeIdentity } from "../contracts.js";
import type { FindingCollector } from "../findings.js";
import { normalizeSubmissionId, normalizeTitle } from "../../shared/validation.js";
import { HANDLE_PATTERN, LEGACY_SUBMISSION_IDS, MAX_OWNERS } from "../../shared/constants.js";
import type { IssueBinding } from "../../shared/types.js";

const REQUIRED_MANIFEST_KEYS = new Set([
  "specVersion",
  "id",
  "leanVersion",
  "mathlibVersion",
  "title",
  "authors",
  "bibEntries",
]);
const MANIFEST_KEYS = new Set([...REQUIRED_MANIFEST_KEYS, "issue", "initialOwners"]);
const AUTHOR_KEYS = new Set(["name", "orcid", "github"]);

export function validateManifest(
  content: string,
  submissionId: string,
  runtime: ValidationRuntimeIdentity,
  findings: FindingCollector,
  expectedIssue?: IssueBinding,
  legacyManifestWithoutIssue?: true,
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
    if (!MANIFEST_KEYS.has(key)) findings.violate("manifest", `manifest.yaml: unknown key \`${key}\``);
  }
  for (const key of REQUIRED_MANIFEST_KEYS) {
    if (!(key in value)) findings.violate("manifest", `manifest.yaml: missing key \`${key}\``);
  }

  let manifestIssue: IssueBinding | undefined;
  if (value.issue !== undefined) {
    if (
      !plainObject(value.issue) ||
      Object.keys(value.issue).sort().join(",") !== "number,repositoryId" ||
      !Number.isSafeInteger(value.issue.repositoryId) ||
      (value.issue.repositoryId as number) <= 0 ||
      !Number.isSafeInteger(value.issue.number) ||
      (value.issue.number as number) <= 0
    ) findings.violate("manifest", "manifest.yaml: issue binding is invalid");
    else manifestIssue = {
      repositoryId: value.issue.repositoryId as number,
      number: value.issue.number as number,
    };
  }
  if (expectedIssue !== undefined) {
    if (manifestIssue === undefined) {
      const legacyIssueNumber = Number(submissionId.slice("lax-".length));
      const allowlisted = LEGACY_SUBMISSION_IDS.has(submissionId);
      const authorizedOldCli = legacyManifestWithoutIssue === true;
      if ((!allowlisted && !authorizedOldCli) || expectedIssue.number !== legacyIssueNumber) {
        findings.violate("manifest", "manifest.yaml: issue binding is required for a remote update");
      }
    } else if (
      manifestIssue.repositoryId !== expectedIssue.repositoryId ||
      manifestIssue.number !== expectedIssue.number
    ) {
      findings.violate("manifest", "manifest.yaml: issue binding does not match the update issue");
    }
  }
  if (value.initialOwners !== undefined) {
    if (!Array.isArray(value.initialOwners) || value.initialOwners.length > MAX_OWNERS) {
      findings.violate(
        "manifest",
        `manifest.yaml: initialOwners must be a list of at most ${MAX_OWNERS} GitHub handles`,
      );
    } else {
      const seen = new Set<string>();
      for (const [index, owner] of value.initialOwners.entries()) {
        if (typeof owner !== "string" || !HANDLE_PATTERN.test(owner)) {
          findings.violate("manifest", `manifest.yaml: initialOwners[${index}] is not a valid GitHub handle`);
          continue;
        }
        const canonical = owner.toLowerCase();
        if (seen.has(canonical)) {
          findings.violate("manifest", `manifest.yaml: duplicate initial owner ${owner}`);
        }
        seen.add(canonical);
      }
    }
  }

  const stringField = (key: string, limit: number): string | undefined => {
    const field = value[key];
    if (typeof field !== "string" && typeof field !== "number") {
      if (field !== undefined) findings.violate("manifest", `manifest.yaml: \`${key}\` must be a string`);
      return undefined;
    }
    const normalized = String(field).normalize("NFC");
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
      id = normalizeSubmissionId(rawId);
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
      else bibEntries.push(entry.replace(/\r\n?/gu, "\n").normalize("NFC"));
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
  };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
