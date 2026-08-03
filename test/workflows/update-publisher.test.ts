import { describe, expect, it, vi } from "vitest";
import type { LoadedSubmission } from "../../src/shared/archive.js";
import {
  fileDigests,
  initialFiles,
  jsonFile,
  parseArchiveFiles,
  replaceOwnerList,
  type ArchiveChanges,
} from "../../src/shared/archive-schema.js";
import type { PublisherArchive, PublisherControl } from "../../src/shared/publisher.js";
import type { PublishRequest } from "../../src/shared/types.js";
import { UpdatePublisher, type UpdateCaptureStore } from "../../src/shared/update-publisher.js";
import type { PublishedCapture, ResolvedDependency } from "../../src/submission-validation/contracts.js";
import {
  successfulArtifacts,
  TEST_CAPTURE,
  TEST_SOURCE,
} from "../support/validation-artifacts.js";

const repositoryId = 123456789;
const alice = { githubId: 10, handle: "alice" };
const issue = { repositoryId, number: 42 };
const run = {
  id: "123456789",
  url: "https://github.com/lax-archive/lax/actions/runs/123456789",
};

describe("trusted update publisher", () => {
  it("promotes the capture and commits exactly record.json and build-output.json", async () => {
    const current = loaded();
    const harness = updateHarness(new Map([["lax-42", current]]));
    const result = await harness.publisher.publish(request(current), successfulArtifacts(), "/capture.tar", run);
    expect(result).toMatchObject({
      kind: "committed",
      archiveCommit: "c".repeat(40),
      acceptedTitle: "Accepted submission title",
    });
    expect(Object.keys(harness.changes).sort()).toEqual(["build-output.json", "record.json"]);
    expect(harness.changes["owner-list.json"]).toBeUndefined();
    const combined = { ...current.texts, ...harness.changes } as Record<string, string>;
    const parsed = parseArchiveFiles("lax-42", combined);
    expect(parsed.record).toMatchObject({ state: "draft", source: TEST_SOURCE });
    expect(parsed.buildOutput.issue).toEqual(issue);
    expect(parsed.buildOutput.capture).toMatchObject({
      ...TEST_CAPTURE,
      downloadUrl: expect.stringContaining("/capture.tar"),
    });
    expect(combined["owner-list.json"]).toBe(current.texts["owner-list.json"]);
    expect(harness.captureStore.promote).toHaveBeenCalledOnce();
  });

  it("ignores owner-list digest changes but rechecks current numeric ownership", async () => {
    const routed = loaded();
    const ownerChanged = loaded(replaceOwnerList("lax-42", routed.texts, [alice, { githubId: 20, handle: "bob" }]));
    const harness = updateHarness(new Map([["lax-42", ownerChanged]]));
    await expect(
      harness.publisher.publish(request(routed), successfulArtifacts(), "/capture.tar", run),
    ).resolves.toMatchObject({ kind: "committed" });

    const removed = loaded(replaceOwnerList("lax-42", routed.texts, [{ githubId: 20, handle: "bob" }]));
    const rejected = updateHarness(new Map([["lax-42", removed]]));
    await expect(
      rejected.publisher.publish(request(routed), successfulArtifacts(), "/capture.tar", run),
    ).rejects.toThrow("no longer an owner");
    expect(rejected.captureStore.promote).not.toHaveBeenCalled();
  });

  it("aggregates issue, owner, state, and record/build stale-state failures before mutation", async () => {
    const routed = loaded();
    const texts = initialFiles(
      "lax-42",
      { repositoryId: 999, number: 99 },
      { githubId: 20, handle: "bob" },
      "2026-07-30T10:00:00Z",
    );
    texts["record.json"] = jsonFile({
      specVersion: "1",
      id: "lax-42",
      state: "registered",
      createdAt: "2026-07-30T10:00:00Z",
    });
    const stale = loaded(texts);
    const harness = updateHarness(new Map([["lax-42", stale]]));
    try {
      await harness.publisher.publish(request(routed), successfulArtifacts(), "/capture.tar", run);
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as Error).message).toContain("expected issue binding");
      expect((error as Error).message).toContain("no longer an owner");
      expect((error as Error).message).toContain("is now registered");
      expect((error as Error).message).toContain("changed after validation");
    }
    expect(harness.captureStore.promote).not.toHaveBeenCalled();
    expect(harness.writeFiles).not.toHaveBeenCalled();
  });

  it("re-reads and compares every dependency before capture promotion and again before the write", async () => {
    const current = loaded();
    const dependency = dependencyLoaded();
    const artifacts = successfulArtifacts();
    const expectedCapture = dependency.files.buildOutput.capture as PublishedCapture;
    const expected: ResolvedDependency = {
      packageName: "Lax7",
      submissionId: "lax-7",
      kind: "concepts",
      source: dependency.files.record.source!,
      state: "draft",
      capture: expectedCapture,
      statements: [],
      requiredPackages: [],
    };
    artifacts.report.dependencies.push(expected);
    artifacts.buildOutput.requiredByConcepts.push("Lax7");
    const archive = new Map([["lax-42", current], ["lax-7", dependency]]);
    const harness = updateHarness(archive);
    await harness.publisher.publish(request(current), artifacts, "/capture.tar", run);
    const dependencyReads = (harness.load.mock.calls as Array<[string]>).filter(([id]) => id === "lax-7");
    expect(dependencyReads.length).toBeGreaterThanOrEqual(3);

    const changed = dependencyLoaded({ ...dependency.files.record.source!, commit: "9".repeat(40) });
    const rejected = updateHarness(new Map([["lax-42", current], ["lax-7", changed]]));
    await expect(
      rejected.publisher.publish(request(current), artifacts, "/capture.tar", run),
    ).rejects.toThrow("source changed after validation");
    expect(rejected.captureStore.promote).not.toHaveBeenCalled();
  });

  it("treats an existing correlated result as a no-op", async () => {
    const current = loaded();
    const harness = updateHarness(new Map([["lax-42", current]]), true);
    await expect(
      harness.publisher.publish(request(current), successfulArtifacts(), "/capture.tar", run),
    ).resolves.toEqual({ kind: "no-op" });
    expect(harness.load).not.toHaveBeenCalled();
    expect(harness.captureStore.promote).not.toHaveBeenCalled();
    expect(harness.clearProgress).toHaveBeenCalledWith(80);
  });
});

function updateHarness(
  values: Map<string, LoadedSubmission>,
  resultExists = false,
): {
  publisher: UpdatePublisher;
  captureStore: { promote: ReturnType<typeof vi.fn> };
  load: ReturnType<typeof vi.fn>;
  writeFiles: ReturnType<typeof vi.fn>;
  clearProgress: ReturnType<typeof vi.fn>;
  readonly changes: ArchiveChanges;
} {
  const clearProgress = vi.fn();
  const control: PublisherControl = {
    resultExists: vi.fn().mockResolvedValue(resultExists),
    successReactionExists: vi.fn().mockResolvedValue(false),
    resolveOwnerPairs: vi.fn(async (owners) => owners),
    postIssueComment: vi.fn(),
    completeCommand: vi.fn(),
    clearCommandProgress: clearProgress,
  };
  const load = vi.fn(async (id: string) => values.get(id));
  let changes: ArchiveChanges = {};
  const writeFiles = vi.fn(async (args: Parameters<PublisherArchive["writeFiles"]>[0]) => {
    changes = args.changes;
    await args.validateCurrent(values.get(args.id));
    return "c".repeat(40);
  });
  const archive: PublisherArchive = { load, writeFiles };
  const publishedCapture: PublishedCapture = {
    ...TEST_CAPTURE,
    downloadUrl: "https://github.com/lax-archive/lax-database/releases/download/capture/capture.tar",
  };
  const captureStore = {
    promote: vi.fn().mockResolvedValue(publishedCapture),
  } satisfies UpdateCaptureStore;
  return {
    publisher: new UpdatePublisher(control, archive, captureStore, repositoryId),
    captureStore,
    load,
    writeFiles,
    clearProgress,
    get changes() { return changes; },
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

function dependencyLoaded(source = {
  repository: "https://github.com/alice/dependency",
  commit: "7".repeat(40),
  folder: ".",
}): LoadedSubmission {
  const dependencyIssue = { repositoryId, number: 7 };
  const texts = initialFiles("lax-7", dependencyIssue, alice, "2026-07-01T10:00:00Z");
  texts["record.json"] = jsonFile({
    specVersion: "1",
    id: "lax-7",
    state: "draft",
    createdAt: "2026-07-01T10:00:00Z",
    source,
  });
  texts["build-output.json"] = jsonFile({
    specVersion: "1",
    id: "lax-7",
    issue: dependencyIssue,
    requiredByConcepts: [],
    requiredByProofs: [],
    concepts: [],
    proofs: [],
    capture: {
      formatVersion: 1,
      digest: "8".repeat(64),
      sourceCommit: source.commit,
      leanToolchain: "leanprover/lean4:v4.30.0",
      mathlibCommit: "3".repeat(40),
      files: [{ path: "concepts/Lax7.olean", bytes: 1, sha256: "6".repeat(64) }],
      downloadUrl: "https://github.com/lax-archive/lax-database/releases/download/example/capture.tar",
    },
  });
  return {
    snapshot: { branch: "main", sha: "a".repeat(40) },
    texts,
    files: parseArchiveFiles("lax-7", texts),
    preconditions: fileDigests(texts),
  };
}

function request(current: LoadedSubmission): PublishRequest {
  return {
    action: "update",
    id: "lax-42",
    issue,
    actor: alice,
    issueNodeId: "I_kwDOexample",
    eventCreatedAt: "2026-07-30T11:00:00Z",
    archiveSha: "a".repeat(40),
    commentId: 80,
    command: { action: "update", ...TEST_SOURCE },
    preconditions: current.preconditions,
  };
}
