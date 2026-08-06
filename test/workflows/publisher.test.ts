import { describe, expect, it, vi } from "vitest";
import type { LoadedSubmission } from "../../src/shared/archive.js";
import {
  deletedFiles,
  fileDigests,
  initialFiles,
  jsonFile,
  parseArchiveFiles,
  registeredFiles,
  replaceOwnerList,
  type ArchiveChanges,
} from "../../src/shared/archive-schema.js";
import {
  dispatchWebsiteAndReport,
  parsePublishRequest,
  Publisher,
  type PublisherArchive,
  type PublisherControl,
} from "../../src/shared/publisher.js";
import type { GitHubIdentity, PublishRequest } from "../../src/shared/types.js";

const alice = { githubId: 10, handle: "alice" };
const bob = { githubId: 20, handle: "bob" };
const issue = { repositoryId: 123456789, number: 42 };
const run = {
  id: "123456789",
  url: "https://github.com/lax-archive/lax/actions/runs/123456789",
};

describe("trusted Archive publisher modes", () => {
  it("init mode creates exactly the three prevalidated route-job files", async () => {
    const initial = initialFiles("lax-42", issue, alice, "2026-07-30T10:00:00Z");
    const harness = publisherHarness(undefined);
    const publication = request({ action: "create", initialFiles: initial });
    const result = await harness.publisher.publish(publication, run);
    expect(result.kind).toBe("committed");
    if (result.kind !== "committed") throw new Error("expected a commit");
    expect(Object.keys(harness.changes()).sort()).toEqual([
      "build-output.json",
      "owner-list.json",
      "record.json",
    ]);
    expect(harness.website.request).not.toHaveBeenCalled();
    await dispatchWebsiteAndReport(
      harness.control,
      harness.website,
      publication,
      issue.repositoryId,
      result.archiveCommit,
      run,
    );
    expect(harness.website.request).toHaveBeenCalledOnce();
    expect(harness.comments[0]).toContain("Workflow run: [#123456789]");
    expect(harness.comments[0]).toContain("lax-initialization-issue:42");
  });

  it("refuses init mode if the unprivileged route did not supply schema-checked stubs", async () => {
    const harness = publisherHarness(undefined);
    await expect(harness.publisher.publish(request({ action: "create" }), run)).rejects.toThrow(
      "publication request must contain exactly",
    );
    expect(harness.writeFiles).not.toHaveBeenCalled();
  });

  it("owners mode changes only owner-list.json and uses only its digest precondition", async () => {
    const current = loaded();
    const harness = publisherHarness(current);
    const publication = request({
        action: "owners",
        commentId: 77,
        command: { action: "owners", owners: [alice, bob] },
        preconditions: {
          record: "d".repeat(64),
          buildOutput: "e".repeat(64),
          ownerList: current.preconditions.ownerList,
        },
      });
    const result = await harness.publisher.publish(publication, run);
    expect(result.kind).toBe("committed");
    if (result.kind !== "committed") throw new Error("expected a commit");
    await dispatchWebsiteAndReport(
      harness.control,
      harness.website,
      publication,
      issue.repositoryId,
      result.archiveCommit,
      run,
    );
    expect(Object.keys(harness.changes())).toEqual(["owner-list.json"]);
    expect(harness.changes()["owner-list.json"]).toContain('"handle": "bob"');
    expect(harness.comments).toEqual([]);
    expect(harness.successes).toEqual([77]);
  });

  it("owner no-op writes neither Archive nor Website and reacts to the command", async () => {
    const compact = initialFiles("lax-42", issue, alice, "2026-07-30T10:00:00Z");
    compact["owner-list.json"] = JSON.stringify({ specVersion: "1", owners: [alice] });
    const current = loaded(compact);
    const harness = publisherHarness(current);
    await harness.publisher.publish(
      request({
        action: "owners",
        commentId: 77,
        command: { action: "owners", owners: [alice] },
        preconditions: current.preconditions,
      }),
      run,
    );
    expect(harness.writeFiles).not.toHaveBeenCalled();
    expect(harness.website.request).not.toHaveBeenCalled();
    expect(harness.comments).toEqual([]);
    expect(harness.successes).toEqual([77]);
  });

  it("owner publication creates a comment only when Website dispatch has a problem", async () => {
    const current = loaded();
    const harness = publisherHarness(current);
    const publication = request({
      action: "owners",
      commentId: 77,
      command: { action: "owners", owners: [alice, bob] },
      preconditions: current.preconditions,
    });
    harness.website.request.mockRejectedValueOnce(new Error("dispatch unavailable"));

    await expect(
      dispatchWebsiteAndReport(
        harness.control,
        harness.website,
        publication,
        issue.repositoryId,
        "c".repeat(40),
        run,
      ),
    ).rejects.toThrow("Website dispatch failed");

    expect(harness.successes).toEqual([]);
    expect(harness.clearedProgress).toEqual([77]);
    expect(harness.comments).toHaveLength(1);
    expect(harness.comments[0]).toContain("Website rebuild was not dispatched");
    expect(harness.comments[0]).toContain("lax-result-comment-id:77");
  });

  it("treats an existing bot thumbs-up as an idempotent owner result", async () => {
    const current = loaded();
    const harness = publisherHarness(current);
    vi.mocked(harness.control.successReactionExists).mockResolvedValueOnce(true);

    await expect(
      harness.publisher.publish(
        request({
          action: "owners",
          commentId: 77,
          command: { action: "owners", owners: [alice, bob] },
          preconditions: current.preconditions,
        }),
        run,
      ),
    ).resolves.toEqual({ kind: "no-op" });

    expect(harness.writeFiles).not.toHaveBeenCalled();
    expect(harness.comments).toEqual([]);
    expect(harness.successes).toEqual([]);
    expect(harness.clearedProgress).toEqual([77]);
  });

  it("reports a precise partial result when Website dispatch fails after the commit", async () => {
    const initial = initialFiles("lax-42", issue, alice, "2026-07-30T10:00:00Z");
    const harness = publisherHarness(undefined);
    harness.website.request.mockRejectedValueOnce(new Error("dispatch unavailable"));
    await expect(
      dispatchWebsiteAndReport(
        harness.control,
        harness.website,
        request({ action: "create", initialFiles: initial }),
        issue.repositoryId,
        "c".repeat(40),
        run,
      ),
    ).rejects.toThrow("Website dispatch failed");
    expect(harness.comments[0]).toContain("Website rebuild was not dispatched");
    expect(harness.comments[0]).toContain("lax-initialization-issue:42");
  });

  it("reports update title synchronization as a recoverable partial result", async () => {
    const current = loaded();
    const harness = publisherHarness(current);
    const publication = request({
      action: "update",
      commentId: 80,
      command: {
        action: "update",
        repository: "https://github.com/alice/repo",
        commit: "a".repeat(40),
        folder: ".",
      },
      preconditions: current.preconditions,
    });
    await dispatchWebsiteAndReport(
      harness.control,
      harness.website,
      publication,
      issue.repositoryId,
      "c".repeat(40),
      run,
      "issue API unavailable",
    );
    expect(harness.comments[0]).toContain("Updated **lax-42**");
    expect(harness.comments[0]).toContain("issue title was not synchronized");
    expect(harness.comments[0]).toContain("Workflow run: [#123456789]");
    expect(harness.successes).toEqual([]);
    expect(harness.clearedProgress).toEqual([80]);
  });

  it("keeps the final update comment and completes its progress reaction", async () => {
    const current = loaded();
    const harness = publisherHarness(current);
    const publication = request({
      action: "update",
      commentId: 80,
      command: {
        action: "update",
        repository: "https://github.com/alice/repo",
        commit: "a".repeat(40),
        folder: ".",
      },
      preconditions: current.preconditions,
    });

    await dispatchWebsiteAndReport(
      harness.control,
      harness.website,
      publication,
      issue.repositoryId,
      "c".repeat(40),
      run,
    );

    expect(harness.comments).toHaveLength(1);
    expect(harness.comments[0]).toContain("Updated **lax-42**");
    expect(harness.comments[0]).toContain("lax-result-comment-id:80");
    expect(harness.successes).toEqual([80]);
    expect(harness.clearedProgress).toEqual([]);
  });

  it("update mode omits owner-list.json for delete and registration", async () => {
    const current = loaded();
    const deletion = publisherHarness(current);
    await deletion.publisher.publish(
      request({ action: "delete", commentId: 78, command: { action: "delete" }, preconditions: current.preconditions }),
      run,
    );
    expect(Object.keys(deletion.changes()).sort()).toEqual(["build-output.json", "record.json"]);

    const registration = publisherHarness(current);
    await registration.publisher.publish(
      request({
        action: "register",
        commentId: 79,
        command: { action: "register" },
        preconditions: current.preconditions,
      }),
      run,
    );
    expect(Object.keys(registration.changes())).toEqual(["record.json"]);
  });

  it("register admits only registered dependencies", async () => {
    const current = loadedWithRequires(["Lax7", "mathlib"]);
    const harness = publisherHarness(current, current, () => undefined, {
      "lax-7": dependencyLoaded("lax-7", "draft"),
    });
    await expect(
      harness.publisher.publish(
        request({
          action: "register",
          commentId: 79,
          command: { action: "register" },
          preconditions: current.preconditions,
        }),
        run,
      ),
    ).rejects.toThrow(
      "dependency lax-7 is draft; registration admits only registered dependencies — register lax-7 first",
    );
    // dependency states are read at the same snapshot the CAS commit is built on
    expect(harness.load).toHaveBeenCalledWith("lax-7", current.snapshot);
    expect(harness.website.request).not.toHaveBeenCalled();
  });

  it("register refuses deleted and missing dependencies without a register hint", async () => {
    const current = loadedWithRequires(["Lax7"], ["Lax9"]);
    const harness = publisherHarness(current, current, () => undefined, {
      "lax-7": dependencyLoaded("lax-7", "deleted"),
    });
    try {
      await harness.publisher.publish(
        request({
          action: "register",
          commentId: 79,
          command: { action: "register" },
          preconditions: current.preconditions,
        }),
        run,
      );
      throw new Error("expected publication validation to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("dependency lax-7 is deleted and its id is retired");
      expect(message).toContain("dependency lax-9 is missing from lax-database");
      expect(message).not.toContain("register lax-7 first");
    }
    expect(harness.website.request).not.toHaveBeenCalled();
  });

  it("register proceeds when every dependency is registered", async () => {
    const current = loadedWithRequires(["Lax7"], ["Lax7", "Lax9"]);
    const harness = publisherHarness(current, current, () => undefined, {
      "lax-7": dependencyLoaded("lax-7", "registered"),
      "lax-9": dependencyLoaded("lax-9", "registered"),
    });
    const result = await harness.publisher.publish(
      request({
        action: "register",
        commentId: 79,
        command: { action: "register" },
        preconditions: current.preconditions,
      }),
      run,
    );
    expect(result.kind).toBe("committed");
    expect(Object.keys(harness.changes())).toEqual(["record.json"]);
    expect(harness.changes()["record.json"]).toContain('"state": "registered"');
  });

  it("routes Lean updates away from the ordinary publisher", async () => {
    const current = loaded();
    const harness = publisherHarness(current);
    await expect(
      harness.publisher.publish(
        request({
          action: "update",
          commentId: 80,
          command: {
            action: "update",
            repository: "https://github.com/alice/repo",
            commit: "a".repeat(40),
            folder: ".",
          },
          preconditions: current.preconditions,
        }),
        run,
      ),
    ).rejects.toThrow("UpdatePublisher");
    expect(harness.writeFiles).not.toHaveBeenCalled();
  });

  it("aggregates fresh-state errors and performs no mutation after any error", async () => {
    const stale = loaded();
    const latestTexts = registeredFiles(
      "lax-42",
      initialFiles("lax-42", { repositoryId: 999, number: 99 }, bob, "2026-07-30T10:00:00Z"),
    );
    const latest = loaded(latestTexts);
    let mutated = false;
    const harness = publisherHarness(stale, latest, () => {
      mutated = true;
    });
    try {
      await harness.publisher.publish(
        request({
          action: "register",
          commentId: 81,
          command: { action: "register" },
          preconditions: stale.preconditions,
        }),
        run,
      );
      throw new Error("expected publication validation to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("expected issue binding");
      expect(message).toContain("no longer an owner");
      expect(message).toContain("is now registered");
      expect(message).toContain("changed after validation");
    }
    expect(mutated).toBe(false);
    expect(harness.website.request).not.toHaveBeenCalled();
  });

  it("rejects inexact, cross-boundary, and mismatched trusted requests", () => {
    const initial = initialFiles("lax-42", issue, alice, "2026-07-30T10:00:00Z");
    expect(() =>
      parsePublishRequest(
        { ...request({ action: "create", initialFiles: initial }), extra: true },
        issue.repositoryId,
      ),
    ).toThrow("must contain exactly");
    expect(() =>
      parsePublishRequest(
        { ...request({ action: "create", initialFiles: initial }), id: "lax-43" },
        issue.repositoryId,
      ),
    ).toThrow("derived as lax-42");
    expect(() =>
      parsePublishRequest(
        request({
          action: "owners",
          commentId: 77,
          command: { action: "register" },
          preconditions: fileDigests(initial),
        }) as PublishRequest,
        issue.repositoryId,
      ),
    ).toThrow("action and command action do not match");

    const mismatchedInitializationFiles = [
      initialFiles(
        "lax-42",
        { repositoryId: issue.repositoryId, number: 43 },
        alice,
        "2026-07-30T10:00:00Z",
      ),
      initialFiles(
        "lax-42",
        issue,
        alice,
        "2026-07-30T10:00:01Z",
      ),
      initialFiles(
        "lax-42",
        issue,
        bob,
        "2026-07-30T10:00:00Z",
      ),
    ];
    for (const mismatched of mismatchedInitializationFiles) {
      expect(() =>
        parsePublishRequest(
          request({ action: "create", initialFiles: mismatched }),
          issue.repositoryId,
        ),
      ).toThrow("do not exactly match");
    }
  });
});

function publisherHarness(
  current: LoadedSubmission | undefined,
  latest = current,
  afterValidation: () => void = () => undefined,
  dependencies: Record<string, LoadedSubmission> = {},
): {
  publisher: Publisher;
  control: PublisherControl;
  changes: () => ArchiveChanges;
  comments: string[];
  successes: number[];
  clearedProgress: number[];
  load: ReturnType<typeof vi.fn>;
  writeFiles: ReturnType<typeof vi.fn>;
  website: { request: ReturnType<typeof vi.fn> };
} {
  let changes: ArchiveChanges = {};
  const comments: string[] = [];
  const successes: number[] = [];
  const clearedProgress: number[] = [];
  const control: PublisherControl = {
    resultExists: vi.fn().mockResolvedValue(false),
    successReactionExists: vi.fn().mockResolvedValue(false),
    resolveOwnerPairs: vi.fn(async (owners: GitHubIdentity[]) => owners),
    postIssueComment: vi.fn(async (_number: number, body: string) => {
      comments.push(body);
    }),
    completeCommand: vi.fn(async (commentId: number) => {
      successes.push(commentId);
    }),
    clearCommandProgress: vi.fn(async (commentId: number) => {
      clearedProgress.push(commentId);
    }),
  };
  const writeFiles = vi.fn(async (args: Parameters<PublisherArchive["writeFiles"]>[0]) => {
    changes = args.changes;
    await args.validateCurrent(latest);
    afterValidation();
    return "c".repeat(40);
  });
  const load = vi.fn(async (id: string) => (id === "lax-42" ? current : dependencies[id]));
  const archive: PublisherArchive = { load, writeFiles };
  const website = { request: vi.fn().mockResolvedValue(undefined) };
  return {
    publisher: new Publisher(control, archive, issue.repositoryId),
    control,
    changes: () => changes,
    comments,
    successes,
    clearedProgress,
    load,
    writeFiles,
    website,
  };
}

function loaded(
  texts = initialFiles("lax-42", issue, alice, "2026-07-30T10:00:00Z"),
): LoadedSubmission {
  return {
    snapshot: { branch: "main", sha: "a".repeat(40) },
    texts,
    files: parseArchiveFiles("lax-42", texts),
    preconditions: fileDigests(texts),
  };
}

function loadedWithRequires(concepts: string[], proofs: string[] = []): LoadedSubmission {
  const texts = initialFiles("lax-42", issue, alice, "2026-07-30T10:00:00Z");
  const output = JSON.parse(texts["build-output.json"]!) as Record<string, unknown>;
  texts["build-output.json"] = jsonFile({
    ...output,
    requiredByConcepts: concepts,
    requiredByProofs: proofs,
  });
  return loaded(texts);
}

function dependencyLoaded(id: string, state: "draft" | "registered" | "deleted"): LoadedSubmission {
  const binding = { repositoryId: issue.repositoryId, number: Number(id.slice("lax-".length)) };
  let texts = initialFiles(id, binding, alice, "2026-07-30T09:00:00Z");
  if (state === "draft") {
    const record = JSON.parse(texts["record.json"]!) as Record<string, unknown>;
    texts = {
      ...texts,
      "record.json": jsonFile({
        ...record,
        state: "draft",
        source: { repository: "https://github.com/alice/repo", commit: "b".repeat(40), folder: "." },
      }),
    };
  }
  if (state === "registered") texts = registeredFiles(id, texts);
  if (state === "deleted") texts = deletedFiles(id, texts, "2026-07-30T09:30:00Z");
  return {
    snapshot: { branch: "main", sha: "a".repeat(40) },
    texts,
    files: parseArchiveFiles(id, texts),
    preconditions: fileDigests(texts),
  };
}

function request(overrides: Partial<PublishRequest>): PublishRequest {
  const value = {
    action: "create",
    id: "lax-42",
    issue,
    actor: alice,
    issueNodeId: "I_kwDOexample",
    eventCreatedAt: "2026-07-30T10:00:00Z",
    archiveSha: "a".repeat(40),
    ...overrides,
  } as PublishRequest;
  if (value.action === "create" && value.title === undefined) value.title = "Example";
  return value;
}
