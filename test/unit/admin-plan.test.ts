import { describe, expect, it } from "vitest";
import {
  adminCommandBody,
  adminRecord,
  describeSource,
  formatTable,
  revalidationOrder,
  revalidationSkipReason,
  statusRows,
  type AdminRecord,
} from "../../scripts/admin/plan.js";
import type { LoadedSubmission } from "../../src/shared/archive.js";
import { fileDigests, initialFiles, jsonFile, parseArchiveFiles } from "../../src/shared/archive-schema.js";

const alice = { githubId: 10, handle: "alice" };
const source = { repository: "https://github.com/alice/repo", commit: "b".repeat(40), folder: "." };

function record(id: string, dependencies: string[] = [], state: AdminRecord["state"] = "registered"): AdminRecord {
  return {
    id,
    issueNumber: Number(id.slice(4)),
    state,
    ...(state === "init" || state === "deleted" ? {} : { source }),
    owners: [alice],
    dependencies,
    paper: "none",
    capture: "ghcr",
  };
}

describe("admin driver plan", () => {
  it("orders a revalidation scope dependencies-first, then by id", () => {
    const records = [
      record("lax-9", ["lax-3", "lax-5"]),
      record("lax-5", ["lax-3"]),
      record("lax-3"),
      record("lax-4"),
      record("lax-12", ["lax-9"]),
    ];
    expect(revalidationOrder(records, ["lax-12", "lax-9", "lax-5", "lax-4", "lax-3"])).toEqual([
      "lax-3",
      "lax-4",
      "lax-5",
      "lax-9",
      "lax-12",
    ]);
    // a dependency outside the scope orders but is not added
    expect(revalidationOrder(records, ["lax-12", "lax-5"])).toEqual(["lax-5", "lax-12"]);
    expect(() => revalidationOrder(records, ["lax-99"])).toThrow("not in lax-database: lax-99");
    expect(() =>
      revalidationOrder([record("lax-1", ["lax-2"]), record("lax-2", ["lax-1"])], ["lax-1"]),
    ).toThrow("dependency cycle");
  });

  it("skips what has nothing to revalidate", () => {
    expect(revalidationSkipReason(record("lax-1"))).toBeUndefined();
    expect(revalidationSkipReason(record("lax-1", [], "draft"))).toBeUndefined();
    expect(revalidationSkipReason(record("lax-1", [], "init"))).toBe("never submitted");
    expect(revalidationSkipReason(record("lax-1", [], "deleted"))).toBe("deleted");
    expect(revalidationSkipReason({ ...record("lax-1"), source: undefined })).toBe("no recorded source");
  });

  it("posts the exact maintainer grammar the route job parses", () => {
    expect(adminCommandBody("revalidate", "lax-48")).toBe("/lax admin revalidate lax-48");
    expect(adminCommandBody("reset-draft", "lax-48")).toBe("/lax admin reset-draft lax-48");
    expect(adminCommandBody("owners", "lax-48", [{ githubId: 20, handle: "bob" }])).toBe(
      '/lax admin owners lax-48 [{"githubId":20,"handle":"bob"}]',
    );
  });

  it("reads a record's edges, paper, and capture shape from its archive files", () => {
    const texts = initialFiles("lax-42", { repositoryId: 1, number: 42 }, alice, "2026-07-30T10:00:00Z");
    texts["record.json"] = jsonFile({
      specVersion: "1",
      id: "lax-42",
      state: "registered",
      createdAt: "2026-07-30T10:00:00Z",
      source,
    });
    const output = JSON.parse(texts["build-output.json"]!) as Record<string, unknown>;
    texts["build-output.json"] = jsonFile({
      ...output,
      inputs: { manifest: { supersedes: "lax-7" } },
      requiredByConcepts: ["Lax13", "mathlib"],
      requiredByProofs: ["Lax13Proofs", "Lax9"],
      capture: { digest: "a".repeat(64), registryBlob: "ghcr.io/x@sha256:" + "a".repeat(64) },
      paper: { pdf: { digest: "b".repeat(64) }, web: { bundle: { digest: "c".repeat(64) } } },
    });
    const loaded: LoadedSubmission = {
      snapshot: { branch: "main", sha: "a".repeat(40) },
      texts,
      files: parseArchiveFiles("lax-42", texts),
      preconditions: fileDigests(texts),
    };
    const parsed = adminRecord(loaded);
    expect(parsed).toEqual({
      id: "lax-42",
      issueNumber: 42,
      state: "registered",
      source,
      owners: [alice],
      dependencies: ["lax-9", "lax-13"],
      supersedes: "lax-7",
      paper: "pdf+web",
      capture: "ghcr",
    });
    expect(statusRows([parsed])[0]).toEqual([
      "lax-42",
      "#42",
      "registered",
      "ghcr",
      "pdf+web",
      "lax-9,lax-13",
      "lax-7",
      "alice",
      "alice/repo @ bbbbbbb",
    ]);
    expect(describeSource({ ...source, folder: "sub" })).toBe("alice/repo @ bbbbbbb · sub");
    expect(formatTable(["a", "bb"], [["1", "2"], ["333", "4"]])).toBe(
      ["  a    bb", "  ---  --", "  1    2", "  333  4"].join("\n"),
    );
  });
});
