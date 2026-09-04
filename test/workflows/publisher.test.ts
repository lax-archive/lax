import { describe, expect, it, vi, type Mock } from "vitest";
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
  type PublisherWebsite,
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

  it("reports submit title synchronization as a recoverable partial result", async () => {
    const current = loaded();
    const harness = publisherHarness(current);
    const publication = request({
      action: "submit",
      commentId: 80,
      command: {
        action: "submit",
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

  it("keeps the final submit comment and completes its progress reaction", async () => {
    const current = loaded();
    const harness = publisherHarness(current);
    const publication = request({
      action: "submit",
      commentId: 80,
      command: {
        action: "submit",
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
    expect(deletion.control.resultExists).toHaveBeenCalledWith(
      issue.number,
      78,
      "2026-07-30T10:00:00Z",
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

  it("register binds a supersedes claim when the command actor owns the registered target", async () => {
    const current = loadedWithSupersedes("lax-7");
    const harness = publisherHarness(current, current, () => undefined, {
      "lax-7": dependencyLoaded("lax-7", "registered"),
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
    // successor uniqueness is read at the CAS-consistent snapshot
    expect(harness.listRegisteredSuperseders).toHaveBeenCalledWith("lax-7", current.snapshot);
  });

  it("register refuses a supersedes claim on an unregistered target, a foreign one, or a taken slot", async () => {
    const current = loadedWithSupersedes("lax-7");
    const registration = {
      action: "register" as const,
      commentId: 79,
      command: { action: "register" as const },
      preconditions: current.preconditions,
    };

    const draftTarget = publisherHarness(current, current, () => undefined, {
      "lax-7": dependencyLoaded("lax-7", "draft"),
    });
    await expect(draftTarget.publisher.publish(request(registration), run)).rejects.toThrow(
      "lax-7 is draft; only a registered submission can be superseded",
    );

    const missingTarget = publisherHarness(current);
    await expect(missingTarget.publisher.publish(request(registration), run)).rejects.toThrow(
      "supersedes lax-7, which is missing from lax-database",
    );

    const deletedTarget = publisherHarness(current, current, () => undefined, {
      "lax-7": dependencyLoaded("lax-7", "deleted"),
    });
    await expect(deletedTarget.publisher.publish(request(registration), run)).rejects.toThrow(
      "lax-7 is deleted and its id is retired; a deleted submission cannot be superseded",
    );

    const malformed = loadedWithSupersedes("lax-7");
    malformed.texts["build-output.json"] = malformed.texts["build-output.json"]!.replace(
      '"lax-7"',
      "7",
    );
    malformed.files = parseArchiveFiles("lax-42", malformed.texts);
    malformed.preconditions = fileDigests(malformed.texts);
    const corrupt = publisherHarness(malformed, malformed, () => undefined, {
      "lax-7": dependencyLoaded("lax-7", "registered"),
    });
    await expect(
      corrupt.publisher.publish(
        request({ ...registration, preconditions: malformed.preconditions }),
        run,
      ),
    ).rejects.toThrow("supersedes claim must be a string");

    const foreignTarget = publisherHarness(current, current, () => undefined, {
      "lax-7": dependencyLoaded("lax-7", "registered", bob),
    });
    await expect(foreignTarget.publisher.publish(request(registration), run)).rejects.toThrow(
      "alice does not own lax-7; only an owner of the superseded submission may submit or register lax-42",
    );

    const overlappingTexts = replaceOwnerList("lax-42", current.texts, [alice, bob]);
    const overlapping = loaded(overlappingTexts);
    const overlapOnly = publisherHarness(overlapping, overlapping, () => undefined, {
      "lax-7": dependencyLoaded("lax-7", "registered", bob),
    });
    await expect(
      overlapOnly.publisher.publish(
        request({ ...registration, preconditions: overlapping.preconditions }),
        run,
      ),
    ).rejects.toThrow(
      "alice does not own lax-7; only an owner of the superseded submission may submit or register lax-42",
    );

    const takenSlot = publisherHarness(
      current,
      current,
      () => undefined,
      { "lax-7": dependencyLoaded("lax-7", "registered") },
      ["lax-30"],
    );
    await expect(takenSlot.publisher.publish(request(registration), run)).rejects.toThrow(
      "lax-30 already supersedes lax-7; a submission has at most one successor",
    );
    expect(takenSlot.website.request).not.toHaveBeenCalled();
  });

  it("routes Lean submits away from the ordinary publisher", async () => {
    const current = loaded();
    const harness = publisherHarness(current);
    await expect(
      harness.publisher.publish(
        request({
          action: "submit",
          commentId: 80,
          command: {
            action: "submit",
            repository: "https://github.com/alice/repo",
            commit: "a".repeat(40),
            folder: ".",
          },
          preconditions: current.preconditions,
        }),
        run,
      ),
    ).rejects.toThrow("SubmitPublisher");
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
    ).toThrow("initialization files do not exactly match");
    const randomIdInitial = initialFiles(
      "lax-123456",
      issue,
      alice,
      "2026-07-30T10:00:00Z",
    );
    expect(
      parsePublishRequest(
        { ...request({ action: "create", initialFiles: randomIdInitial }), id: "lax-123456" },
        issue.repositoryId,
      ).id,
    ).toBe("lax-123456");
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

    const oldCli = request({
      action: "submit",
      commentId: 77,
      command: {
        action: "submit",
        repository: "https://github.com/alice/example",
        commit: "b".repeat(40),
        folder: ".",
      },
      preconditions: fileDigests(initial),
    });
    expect(
      parsePublishRequest(
        { ...oldCli, legacyManifestWithoutIssue: true },
        issue.repositoryId,
      ).legacyManifestWithoutIssue,
    ).toBe(true);
    expect(() =>
      parsePublishRequest(
        { ...oldCli, legacyManifestWithoutIssue: false },
        issue.repositoryId,
      ),
    ).toThrow("legacy manifest compatibility flag is invalid");

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

describe("maintainer publications", () => {
  const maintainers = new Set([alice.githubId]);
  const registered = (): LoadedSubmission => {
    const texts = initialFiles("lax-42", issue, alice, "2026-07-30T10:00:00Z");
    const record = JSON.parse(texts["record.json"]!) as Record<string, unknown>;
    texts["record.json"] = jsonFile({
      ...record,
      state: "registered",
      source: { repository: "https://github.com/alice/repo", commit: "b".repeat(40), folder: "." },
    });
    return loaded(texts);
  };

  it("tombstones a registered record on a maintainer delete, attributed in the commit", async () => {
    const current = registered();
    const harness = publisherHarness(current, current, () => undefined, {}, [], maintainers);
    const result = await harness.publisher.publish(
      request({
        action: "delete",
        commentId: 78,
        command: { action: "delete", admin: true },
        preconditions: current.preconditions,
        dependents: ["lax-50"],
      }),
      run,
    );
    expect(result.kind).toBe("committed");
    expect(Object.keys(harness.changes()).sort()).toEqual(["build-output.json", "record.json"]);
    expect(JSON.parse(harness.changes()["record.json"]!)).toMatchObject({ state: "deleted" });
    const message = harness.writeFiles.mock.calls[0]![0].message;
    expect(message.startsWith("admin delete lax-42 by alice (10)\n")).toBe(true);
    expect(message).toContain("lax-actor-id: 10");
  });

  it("returns a registered record to draft, unless a registered successor claims it", async () => {
    const current = registered();
    const reset = publisherHarness(current, current, () => undefined, {}, [], maintainers);
    await reset.publisher.publish(
      request({
        action: "reset-draft",
        commentId: 79,
        command: { action: "reset-draft", admin: true },
        preconditions: current.preconditions,
      }),
      run,
    );
    expect(Object.keys(reset.changes())).toEqual(["record.json"]);
    expect(JSON.parse(reset.changes()["record.json"]!)).toMatchObject({
      state: "draft",
      source: { commit: "b".repeat(40) },
    });
    expect(reset.listRegisteredSuperseders).toHaveBeenCalledWith("lax-42", current.snapshot);

    const claimed = publisherHarness(current, current, () => undefined, {}, ["lax-77"], maintainers);
    await expect(
      claimed.publisher.publish(
        request({
          action: "reset-draft",
          commentId: 79,
          command: { action: "reset-draft", admin: true },
          preconditions: current.preconditions,
        }),
        run,
      ),
    ).rejects.toThrow("lax-77 supersedes lax-42; a superseded submission cannot be reset to draft");
    expect(claimed.website.request).not.toHaveBeenCalled();
  });

  it("replaces owners outright for a maintainer and refuses the form to anyone else", async () => {
    const current = registered();
    const harness = publisherHarness(current, current, () => undefined, {}, [], maintainers);
    await harness.publisher.publish(
      request({
        action: "owners",
        commentId: 77,
        command: { action: "owners", owners: [bob], admin: true },
        preconditions: current.preconditions,
      }),
      run,
    );
    expect(JSON.parse(harness.changes()["owner-list.json"]!)).toEqual({ specVersion: "1", owners: [bob] });

    const stranger = publisherHarness(current, current, () => undefined, {}, [], new Set([99]));
    await expect(
      stranger.publisher.publish(
        request({
          action: "delete",
          commentId: 78,
          command: { action: "delete", admin: true },
          preconditions: current.preconditions,
        }),
        run,
      ),
    ).rejects.toThrow("alice is not an archive maintainer");
    expect(stranger.website.request).not.toHaveBeenCalled();
    expect(stranger.successes).toEqual([]);
  });

  it("admits the maintainer flag only where the grammar does", () => {
    const initial = initialFiles("lax-42", issue, alice, "2026-07-30T10:00:00Z");
    const preconditions = fileDigests(initial);
    const parsed = parsePublishRequest(
      request({ action: "delete", commentId: 78, command: { action: "delete", admin: true }, preconditions }),
      issue.repositoryId,
    );
    expect(parsed.command).toEqual({ action: "delete", admin: true });
    expect(() =>
      parsePublishRequest(
        request({
          action: "register",
          commentId: 78,
          command: { action: "register", admin: true } as never,
          preconditions,
        }),
        issue.repositoryId,
      ),
    ).toThrow("exactly");
    expect(() =>
      parsePublishRequest(
        request({
          action: "delete",
          commentId: 78,
          command: { action: "delete", admin: false } as never,
          preconditions,
        }),
        issue.repositoryId,
      ),
    ).toThrow("maintainer flag is invalid");
    expect(() =>
      parsePublishRequest(
        request({
          action: "revalidate",
          commentId: 78,
          command: { action: "revalidate", admin: true },
          preconditions,
        }),
        issue.repositoryId,
      ),
    ).toThrow("exactly");
  });
});

function publisherHarness(
  current: LoadedSubmission | undefined,
  latest = current,
  afterValidation: () => void = () => undefined,
  dependencies: Record<string, LoadedSubmission> = {},
  registeredSuperseders: string[] = [],
  admins?: ReadonlySet<number>,
): {
  publisher: Publisher;
  control: PublisherControl;
  changes: () => ArchiveChanges;
  comments: string[];
  successes: number[];
  clearedProgress: number[];
  load: ReturnType<typeof vi.fn>;
  listRegisteredSuperseders: ReturnType<typeof vi.fn>;
  writeFiles: ReturnType<typeof vi.fn>;
  website: PublisherWebsite & { request: Mock };
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
  const listRegisteredSuperseders = vi.fn(async () => registeredSuperseders);
  const archive: PublisherArchive = { load, listRegisteredSuperseders, writeFiles };
  // `PublisherWebsite.request` is generic in the response type it parses, and
  // no mock can honestly hand back a `Promise<T>` for a T it never sees — the
  // dispatch under test discards the response. So the spy is a plain mock and
  // stands in for the interface deliberately.
  const website = { request: vi.fn().mockResolvedValue(undefined) } as PublisherWebsite & {
    request: Mock;
  };
  return {
    publisher: new Publisher(control, archive, issue.repositoryId, admins),
    control,
    changes: () => changes,
    comments,
    successes,
    clearedProgress,
    load,
    listRegisteredSuperseders,
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

function loadedWithSupersedes(target: string): LoadedSubmission {
  const texts = initialFiles("lax-42", issue, alice, "2026-07-30T10:00:00Z");
  const output = JSON.parse(texts["build-output.json"]!) as Record<string, unknown>;
  texts["build-output.json"] = jsonFile({
    ...output,
    inputs: { manifest: { supersedes: target } },
  });
  return loaded(texts);
}

function dependencyLoaded(
  id: string,
  state: "draft" | "registered" | "deleted",
  owner: GitHubIdentity = alice,
): LoadedSubmission {
  const binding = { repositoryId: issue.repositoryId, number: Number(id.slice("lax-".length)) };
  let texts = initialFiles(id, binding, owner, "2026-07-30T09:00:00Z");
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
