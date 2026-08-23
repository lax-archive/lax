import { describe, expect, it } from "vitest";
import {
  deletedFiles,
  initialFiles,
  parseArchiveFiles,
  parseOwnerList,
  registeredFiles,
  replaceOwnerList,
  supersedesClaim,
} from "../../src/shared/archive-schema.js";

const issue = { repositoryId: 123456789, number: 42 };
const alice = { githubId: 10, handle: "alice" };

describe("lax-database record transitions", () => {
  it("creates the exact three initialization files", () => {
    const files = initialFiles("lax-42", issue, alice, "2026-07-30T10:00:00Z");
    expect(Object.keys(files).sort()).toEqual([
      "build-output.json",
      "owner-list.json",
      "record.json",
    ]);
    expect(parseArchiveFiles("lax-42", files)).toEqual({
      record: {
        specVersion: "1",
        id: "lax-42",
        state: "init",
        createdAt: "2026-07-30T10:00:00Z",
      },
      buildOutput: { specVersion: "1", id: "lax-42", issue },
      ownerList: { specVersion: "1", owners: [alice] },
    });
    expect(Object.keys(JSON.parse(files["record.json"]!))).toEqual([
      "specVersion",
      "id",
      "state",
      "createdAt",
    ]);
    expect(Object.keys(JSON.parse(files["build-output.json"]!))).toEqual([
      "specVersion",
      "id",
      "issue",
    ]);
    expect(Object.keys(JSON.parse(files["owner-list.json"]!))).toEqual(["specVersion", "owners"]);
  });

  it("keeps ownership separate and supports init registration", () => {
    const initial = initialFiles("lax-42", issue, alice, "2026-07-30T10:00:00Z");
    const owned = replaceOwnerList("lax-42", initial, [
      alice,
      { githubId: 20, handle: "bob" },
    ]);
    const registered = parseArchiveFiles("lax-42", registeredFiles("lax-42", owned));
    expect(registered.record.state).toBe("registered");
    expect(registered.record.source).toBeUndefined();
    expect(registered.ownerList.owners).toHaveLength(2);
  });

  it("deletes to a three-file tombstone with one lifecycle field", () => {
    const initial = initialFiles("lax-42", issue, alice, "2026-07-30T10:00:00Z");
    const deleted = deletedFiles("lax-42", initial, "2026-07-30T12:30:00Z");
    const parsed = parseArchiveFiles("lax-42", deleted);
    expect(parsed.record).toEqual({
      specVersion: "1",
      id: "lax-42",
      state: "deleted",
      createdAt: "2026-07-30T10:00:00Z",
      deletedAt: "2026-07-30T12:30:00Z",
    });
    expect(parsed.buildOutput).toEqual({ specVersion: "1", id: "lax-42", issue });
    expect(parsed.ownerList.owners).toEqual([alice]);
    expect(Object.keys(JSON.parse(deleted["record.json"]!))).toEqual([
      "specVersion",
      "id",
      "state",
      "createdAt",
      "deletedAt",
    ]);
    expect(Object.keys(JSON.parse(deleted["build-output.json"]!))).toEqual([
      "specVersion",
      "id",
      "issue",
    ]);
  });

  it("rejects a duplicated lifecycle state in build output", () => {
    const files = initialFiles("lax-42", issue, alice, "2026-07-30T10:00:00Z");
    files["build-output.json"] = JSON.stringify({
      specVersion: "1",
      id: "lax-42",
      issue,
      state: "init",
    });
    expect(() => parseArchiveFiles("lax-42", files)).toThrow("must not duplicate");
  });

  it("requires exactly the three regular Archive payloads", () => {
    const initial = initialFiles("lax-42", issue, alice, "2026-07-30T10:00:00Z");
    const missing = { ...initial };
    delete missing["owner-list.json"];
    expect(() => parseArchiveFiles("lax-42", missing)).toThrow("must contain exactly");
    expect(() => parseArchiveFiles("lax-42", { ...initial, "extra.json": "{}" })).toThrow(
      "must contain exactly",
    );
  });

  it("keeps minimal build-output extensions permissive until its full schema is supplied", () => {
    const initial = initialFiles("lax-42", issue, alice, "2026-07-30T10:00:00Z");
    initial["build-output.json"] = JSON.stringify({
      specVersion: "1",
      id: "lax-42",
      issue,
      futureSchemaField: { retained: true },
    });
    expect(parseArchiveFiles("lax-42", initial).buildOutput.futureSchemaField).toEqual({ retained: true });
  });

  it("rejects malformed timestamps and inexact issue bindings", () => {
    const initial = initialFiles("lax-42", issue, alice, "2026-07-30T10:00:00Z");
    initial["record.json"] = JSON.stringify({
      specVersion: "1",
      id: "lax-42",
      state: "init",
      createdAt: "2026-02-30T10:00:00Z",
    });
    expect(() => parseArchiveFiles("lax-42", initial)).toThrow("not a real timestamp");

    const binding = initialFiles("lax-42", issue, alice, "2026-07-30T10:00:00Z");
    binding["build-output.json"] = JSON.stringify({
      specVersion: "1",
      id: "lax-42",
      issue: { ...issue, owner: "lax-archive" },
    });
    expect(() => parseArchiveFiles("lax-42", binding)).toThrow("must contain exactly");
  });

  it("requires sorted unique owner ids and case-insensitive unique handles", () => {
    const initial = initialFiles("lax-42", issue, alice, "2026-07-30T10:00:00Z");
    initial["owner-list.json"] = JSON.stringify({
      specVersion: "1",
      owners: [
        { githubId: 20, handle: "alice" },
        { githubId: 10, handle: "bob" },
      ],
    });
    expect(() => parseArchiveFiles("lax-42", initial)).toThrow("sorted numerically");
    initial["owner-list.json"] = JSON.stringify({
      specVersion: "1",
      owners: [
        { githubId: 10, handle: "Alice" },
        { githubId: 20, handle: "alice" },
      ],
    });
    expect(() => parseArchiveFiles("lax-42", initial)).toThrow("duplicate handles");
  });

  it("does not impose the command owner-count limit on stored owner lists", () => {
    const owners = Array.from({ length: 51 }, (_, index) => ({
      githubId: index + 1,
      handle: `owner-${index + 1}`,
    }));
    expect(parseOwnerList({ specVersion: "1", owners }).owners).toHaveLength(51);
  });
});

describe("supersedes claim extraction", () => {
  it("reads the canonical claim and fails closed on anything else", () => {
    expect(supersedesClaim({})).toBeUndefined();
    expect(supersedesClaim({ inputs: { manifest: {} } })).toBeUndefined();
    expect(supersedesClaim({ inputs: { manifest: { supersedes: "lax-7" } } })).toBe("lax-7");
    // trusted writes only ever store the normalized value; anything else is
    // corruption and must never silently free the successor slot
    expect(() => supersedesClaim({ inputs: { manifest: { supersedes: 7 } } })).toThrow(
      "must be a string",
    );
    expect(() => supersedesClaim({ inputs: { manifest: { supersedes: "Lax7" } } })).toThrow(
      "must match lax-<positive decimal>",
    );
  });
});
