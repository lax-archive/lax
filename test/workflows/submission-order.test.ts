import { describe, expect, it, vi } from "vitest";
import type { LoadedSubmission } from "../../src/shared/archive.js";
import {
  fileDigests, initialFiles, jsonFile, parseArchiveFiles, redraftedFiles,
  registeredFiles, replaceOwnerList,
} from "../../src/shared/archive-schema.js";
import type { PublisherArchive } from "../../src/shared/publisher.js";
import {
  submittedChanges, submissionBaseline, SupersededSubmission,
} from "../../src/shared/submission-order.js";
import type { PublishRequest } from "../../src/shared/types.js";

const issue = { repositoryId: 123456789, number: 42 };
const alice = { githubId: 10, handle: "alice" };
const source = { repository: "https://github.com/alice/repo", commit: "1".repeat(40), folder: "." };
const admins = new Set([alice.githubId]);

function loaded(texts = initialFiles("lax-42", issue, alice, "2026-07-30T10:00:00Z"), sha = "a".repeat(40)): LoadedSubmission {
  return { snapshot: { branch: "main", sha }, texts,
    files: parseArchiveFiles("lax-42", texts), preconditions: fileDigests(texts) };
}

function request(baseline: LoadedSubmission, commentId = 80): PublishRequest {
  return { action: "submit", id: "lax-42", issue, actor: alice, issueNodeId: "I_kwDOexample",
    eventCreatedAt: "2026-07-30T11:00:00Z", commentId,
    archiveSha: baseline.snapshot.sha, preconditions: baseline.preconditions,
    command: { action: "submit", ...source } };
}

function published(previous: LoadedSubmission, command: PublishRequest, sha = "b".repeat(40)): LoadedSubmission {
  const build = jsonFile({ specVersion: "1", id: "lax-42", issue, value: command.commentId });
  return loaded({ ...previous.texts,
    ...submittedChanges(command, previous, source, build) }, sha);
}

function archive(...snapshots: LoadedSubmission[]): PublisherArchive {
  return { load: vi.fn(async (_id, snapshot) => snapshots.find((entry) => entry.snapshot.sha === snapshot?.sha)),
    listDependents: vi.fn(), listRegisteredSuperseders: vi.fn(), writeFiles: vi.fn() };
}

describe("ordered submission publication", () => {
  it("accepts a fresh legacy record without requiring a database migration", async () => {
    const base = loaded();
    expect(await submissionBaseline(archive(base), request(base), base, admins)).toBe(base);
  });

  it("rebases a newer request through several earlier publications to its exact routed payload", async () => {
    const base = loaded();
    const first = published(base, request(base, 80));
    const second = published(first, request(base, 81), "c".repeat(40));
    expect(await submissionBaseline(archive(base, first, second), request(base, 82), second, admins)).toBe(base);
    // Also works when the request's baseline already includes an earlier receipt.
    expect(await submissionBaseline(archive(base, first, second), request(first, 82), second, admins)).toBe(first);
  });

  it("skips an older or repeated request even when its route ran after the newer publication", async () => {
    const base = loaded();
    const newer = published(base, request(base, 81));
    for (const command of [request(base, 80), request(newer, 80), request(base, 81)]) {
      await expect(submissionBaseline(archive(base, newer), command, newer, admins))
        .rejects.toBeInstanceOf(SupersededSubmission);
    }
  });

  it("orders by event time and uses comment id to break ties within one second", async () => {
    const base = loaded();
    const newer = published(base, { ...request(base, 70), eventCreatedAt: "2026-07-30T11:00:01Z" });
    await expect(submissionBaseline(archive(base, newer), request(base, 80), newer, admins))
      .rejects.toBeInstanceOf(SupersededSubmission);
    const later = { ...request(base, 60), eventCreatedAt: "2026-07-30T11:00:02Z" };
    expect(await submissionBaseline(archive(base, newer), later, newer, admins)).toBe(base);
  });

  it("keeps current ownership checks while tolerating changes that retain the actor", async () => {
    const base = loaded();
    const first = published(base, request(base));
    const bob = { githubId: 20, handle: "bob" };
    const retained = loaded(replaceOwnerList("lax-42", first.texts, [alice, bob]), first.snapshot.sha);
    expect(await submissionBaseline(archive(base), request(base, 81), retained, admins)).toBe(base);
    const removed = loaded(replaceOwnerList("lax-42", first.texts, [bob]), first.snapshot.sha);
    await expect(submissionBaseline(archive(base), request(base, 81), removed, admins)).rejects.toThrow("no longer an owner");
    await expect(submissionBaseline(archive(base), request(base, 79), removed, admins)).rejects.toThrow("no longer an owner");
  });

  it("ends the lineage at registration, including after reset-draft and another submit", async () => {
    const base = loaded();
    const first = published(base, request(base));
    const registered = loaded(registeredFiles("lax-42", first.texts), "c".repeat(40));
    expect(registered.files.buildOutput.lastSubmission).toBeUndefined();
    await expect(submissionBaseline(archive(base), request(base, 83), registered, admins)).rejects.toThrow("is now registered");
    const reset = loaded(redraftedFiles("lax-42", registered.texts), "d".repeat(40));
    const afterReset = published(reset, request(reset, 81), "e".repeat(40));
    await expect(submissionBaseline(archive(base, first, registered, reset), request(base, 83), afterReset, admins))
      .rejects.toThrow("changed after validation");
    expect(await submissionBaseline(archive(reset), request(reset, 83), afterReset, admins)).toBe(reset);
  });

  it("does not rebase revalidation through ordinary submit publications", async () => {
    const base = loaded();
    const first = published(base, request(base));
    const command: PublishRequest = { ...request(base, 81), action: "revalidate",
      command: { action: "revalidate", admin: true, source } };
    await expect(submissionBaseline(archive(base), command, first, admins)).rejects.toThrow("changed after validation");
  });

  it.each(["record", "build-output"])("rejects a %s edit that leaves an old receipt behind", async (file) => {
    const base = loaded();
    const first = published(base, request(base));
    const texts = { ...first.texts };
    if (file === "record") texts["record.json"] = jsonFile({ ...first.files.record, source: { ...source, commit: "9".repeat(40) } });
    else texts["build-output.json"] = jsonFile({ ...first.files.buildOutput, value: "manual edit" });
    const edited = loaded(texts, "c".repeat(40));
    await expect(submissionBaseline(archive(base), request(base, 81), edited, admins)).rejects.toThrow("changed after validation");
  });

  it("fails closed on missing or altered immutable predecessor evidence", async () => {
    const base = loaded();
    const first = published(base, request(base));
    await expect(submissionBaseline(archive(), request(base, 81), first, admins)).rejects.toThrow("changed after validation");
    const altered = loaded({ ...base.texts, "build-output.json": jsonFile({ ...base.files.buildOutput, extra: true }) });
    await expect(submissionBaseline(archive(altered), request(base, 81), first, admins)).rejects.toThrow("changed after validation");
  });

  it.each(["commentId", "eventCreatedAt", "record", "buildOutput", "previous"])(
    "rejects malformed archived receipt %s before interpreting its ordering", (field) => {
      const base = loaded();
      const first = published(base, request(base));
      const receipt = { ...first.files.buildOutput.lastSubmission!, [field]: null };
      expect(() => loaded({ ...first.texts,
        "build-output.json": jsonFile({ ...first.files.buildOutput, lastSubmission: receipt }),
      })).toThrow();
    },
  );
});
