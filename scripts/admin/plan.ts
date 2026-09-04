// The pure half of the admin driver: what a record looks like once read, in
// which order a set of them is revalidated, and the exact comment bodies the
// driver posts. Nothing here touches the network, so all of it is unit-tested
// (test/unit/admin-plan.test.ts) without a GitHub of any kind.
import type { LoadedSubmission } from "../../src/shared/archive.js";
import { supersedesClaim } from "../../src/shared/archive-schema.js";
import type { AdminVerb, GitHubIdentity, SourceLocation, SubmissionState } from "../../src/shared/types.js";
import { isObject } from "../../src/shared/validation.js";
import {
  compareSubmissionIds,
  requiredSubmissionIds,
} from "../../src/submission-validation/contracts.js";

export interface AdminRecord {
  id: string;
  issueNumber: number;
  state: SubmissionState;
  source?: SourceLocation;
  owners: GitHubIdentity[];
  /** Submissions whose packages this record's build requires. */
  dependencies: string[];
  supersedes?: string;
  paper: "none" | "pdf" | "pdf+web";
  capture: "none" | "legacy" | "ghcr";
}

/** The driver's view of a record, from the three files the archive holds. */
export function adminRecord(loaded: LoadedSubmission): AdminRecord {
  const { record, buildOutput, ownerList } = loaded.files;
  const capture = buildOutput.capture;
  const paper = isObject(buildOutput.paper) ? buildOutput.paper : undefined;
  let supersedes: string | undefined;
  try {
    supersedes = supersedesClaim(buildOutput);
  } catch {
    supersedes = undefined;
  }
  return {
    id: record.id,
    issueNumber: buildOutput.issue.number,
    state: record.state,
    ...(record.source === undefined ? {} : { source: record.source }),
    owners: ownerList.owners,
    dependencies: requiredSubmissionIds(buildOutput, record.id),
    ...(supersedes === undefined ? {} : { supersedes }),
    paper: paper === undefined ? "none" : isObject(paper.web) ? "pdf+web" : "pdf",
    capture:
      capture === undefined
        ? "none"
        : isObject(capture) && typeof capture.registryBlob === "string"
          ? "ghcr"
          : "legacy",
  };
}

/** Why a record is not a revalidation candidate, or undefined when it is one. */
export function revalidationSkipReason(record: AdminRecord): string | undefined {
  if (record.state === "deleted") return "deleted";
  if (record.state === "init") return "never submitted";
  if (record.source === undefined) return "no recorded source";
  return undefined;
}

/**
 * The order to revalidate `scope` in: dependencies before dependents, then by
 * id. A dependent whose dependency is also in the scope must see that
 * dependency's fresh capture, which is exactly what the port-db sweep learned
 * the hard way; a dependency outside the scope keeps whatever capture it has.
 * A cycle cannot occur in a database the publisher accepted, but a malformed
 * one must not hang the driver, so the walk refuses instead of looping.
 */
export function revalidationOrder(records: readonly AdminRecord[], scope: readonly string[]): string[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) throw new Error(`dependency cycle through ${id}`);
    visiting.add(id);
    const dependencies = byId.get(id)?.dependencies ?? [];
    const value = dependencies.length === 0 ? 0 : 1 + Math.max(...dependencies.map(depthOf));
    visiting.delete(id);
    depth.set(id, value);
    return value;
  };
  const unknown = scope.filter((id) => !byId.has(id));
  if (unknown.length > 0) throw new Error(`not in lax-database: ${unknown.join(", ")}`);
  const selected = [...new Set(scope)];
  for (const id of selected) depthOf(id);
  return selected.sort(
    (left, right) => depthOf(left) - depthOf(right) || compareSubmissionIds(left, right),
  );
}

/** The exact comment the driver posts for a maintainer verb. */
export function adminCommandBody(verb: AdminVerb, id: string, argument?: unknown): string {
  const head = `/lax admin ${verb} ${id}`;
  return argument === undefined ? head : `${head} ${JSON.stringify(argument)}`;
}

/** `alice/repo @ 0123456 · folder`, the way `lax submit` prints a source. */
export function describeSource(source: SourceLocation | undefined): string {
  if (source === undefined) return "-";
  const repository = source.repository.replace(/^https:\/\/github\.com\//u, "");
  const at = `${repository} @ ${source.commit.slice(0, 7)}`;
  return source.folder === "." ? at : `${at} · ${source.folder}`;
}

/** A fixed-width table, header underlined, columns padded to their widest cell. */
export function formatTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = header.map((name, index) =>
    Math.max(name.length, ...rows.map((cells) => (cells[index] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    `  ${cells.map((cell, index) => cell.padEnd(widths[index]!)).join("  ")}`.trimEnd();
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join("\n");
}

export function statusRows(records: readonly AdminRecord[]): string[][] {
  return records.map((record) => [
    record.id,
    `#${record.issueNumber}`,
    record.state,
    record.capture,
    record.paper,
    record.dependencies.length === 0 ? "-" : record.dependencies.join(","),
    record.supersedes ?? "-",
    record.owners.map((owner) => owner.handle).join(",") || "-",
    describeSource(record.source),
  ]);
}

export const STATUS_HEADER = [
  "id",
  "issue",
  "state",
  "capture",
  "paper",
  "depends on",
  "supersedes",
  "owners",
  "source",
] as const;
