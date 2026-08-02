import { describe, expect, it, vi } from "vitest";
import type { LoadedSubmission } from "../../src/shared/archive.js";
import {
  fileDigests,
  initialFiles,
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
    expect(harness.comments[0]).toContain("lax-result-comment-id:77");
    expect(harness.comments[0]).toContain("Workflow run: [#123456789]");
  });

  it("owner no-op writes neither Archive nor Website but still reports a correlated result", async () => {
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
    expect(harness.comments[0]).toContain("was already current");
    expect(harness.comments[0]).toContain("lax-workflow-run-id:123456789");
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
): {
  publisher: Publisher;
  control: PublisherControl;
  changes: () => ArchiveChanges;
  comments: string[];
  writeFiles: ReturnType<typeof vi.fn>;
  website: { request: ReturnType<typeof vi.fn> };
} {
  let changes: ArchiveChanges = {};
  const comments: string[] = [];
  const control: PublisherControl = {
    resultExists: vi.fn().mockResolvedValue(false),
    resolveOwnerPairs: vi.fn(async (owners: GitHubIdentity[]) => owners),
    postIssueComment: vi.fn(async (_number: number, body: string) => {
      comments.push(body);
    }),
  };
  const writeFiles = vi.fn(async (args: Parameters<PublisherArchive["writeFiles"]>[0]) => {
    changes = args.changes;
    args.validateCurrent(latest);
    afterValidation();
    return "c".repeat(40);
  });
  const archive: PublisherArchive = {
    load: vi.fn().mockResolvedValue(current),
    writeFiles,
  };
  const website = { request: vi.fn().mockResolvedValue(undefined) };
  return {
    publisher: new Publisher(control, archive, issue.repositoryId),
    control,
    changes: () => changes,
    comments,
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
