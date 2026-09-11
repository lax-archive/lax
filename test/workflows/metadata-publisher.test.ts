import { describe, expect, it, vi } from "vitest";
import type { LoadedSubmission } from "../../src/shared/archive.js";
import {
  fileDigests,
  initialFiles,
  jsonFile,
  parseArchiveFiles,
  type ArchiveChanges,
} from "../../src/shared/archive-schema.js";
import { MetadataPublisher } from "../../src/shared/metadata-publisher.js";
import type { PublisherArchive, PublisherControl } from "../../src/shared/publisher.js";
import type { PublishRequest } from "../../src/shared/types.js";
import type { ParsedMetadataResubmissionArtifact } from "../../src/submission-validation/metadata-resubmission.js";
import { configuredRuntime } from "../../src/submission-validation/config.js";
import { epoch } from "../../src/submission-validation/environments.js";

const repositoryId = 123456789;
const issue = { repositoryId, number: 42 };
const alice = { githubId: 10, handle: "alice" };
const previousSource = {
  repository: "https://github.com/alice/submission",
  commit: "1".repeat(40),
  folder: ".",
};
const nextSource = { ...previousSource, commit: "2".repeat(40) };
const run = {
  id: "123456789",
  url: "https://github.com/lax-archive/lax/actions/runs/123456789",
};

describe("metadata resubmission publisher", () => {
  it("reuses the exact capture and changes only record and build output presentation data", async () => {
    const current = loaded();
    const harness = metadataHarness(current);
    const result = await harness.publisher.publish(request(current), artifact(current), run);
    expect(result).toMatchObject({
      kind: "committed",
      archiveCommit: "c".repeat(40),
      acceptedTitle: "Better title",
    });
    expect(Object.keys(harness.changes).sort()).toEqual(["build-output.json", "record.json"]);
    const combined = { ...current.texts, ...harness.changes } as Record<string, string>;
    const parsed = parseArchiveFiles("lax-42", combined);
    expect(parsed.record).toMatchObject({ state: "draft", source: nextSource });
    expect(parsed.buildOutput.inputs).toMatchObject({
      manifest: { title: "Better title", authors: [{ name: "Alice Example" }] },
      abstract: "A better abstract.\n",
    });
    expect(parsed.buildOutput.capture).toMatchObject({
      digest: "4".repeat(64),
      registryBlob: `ghcr.io/lax-archive/lax-captures@sha256:${"4".repeat(64)}`,
      sourceCommit: nextSource.commit,
    });
    expect(parsed.buildOutput.concepts).toEqual(current.files.buildOutput.concepts);
    expect(combined["owner-list.json"]).toBe(current.texts["owner-list.json"]);
  });

  it("rejects a claimed metadata update that changes any other manifest field", async () => {
    const current = loaded();
    const changed = artifact(current);
    changed.inputs.manifest = {
      ...(changed.inputs.manifest as Record<string, unknown>),
      unlisted: true,
    };
    await expect(metadataHarness(current).publisher.publish(request(current), changed, run))
      .rejects.toThrow("outside title, authors, and abstract");
  });

  it("rejects a field list that does not exactly describe the presentation changes", async () => {
    const current = loaded();
    const changed = artifact(current);
    changed.fields = ["title"];
    await expect(metadataHarness(current).publisher.publish(request(current), changed, run))
      .rejects.toThrow("outside title, authors, and abstract");
  });

  it("rejects stale source and build-output evidence before committing", async () => {
    const current = loaded();
    const staleSource = artifact(current);
    staleSource.previousSource = { ...previousSource, commit: "3".repeat(40) };
    await expect(metadataHarness(current).publisher.publish(request(current), staleSource, run))
      .rejects.toThrow("current recorded source");

    const staleBuild = artifact(current);
    staleBuild.previousBuildOutput = "9".repeat(64);
    await expect(metadataHarness(current).publisher.publish(request(current), staleBuild, run))
      .rejects.toThrow("routed build output");
  });

  it("rejects evidence that moves the repository or does not move the commit", async () => {
    const current = loaded();
    const moved = artifact(current);
    moved.previousSource = { ...previousSource, repository: "https://github.com/alice/other" };
    await expect(metadataHarness(current).publisher.publish(request(current), moved, run))
      .rejects.toThrow("distinct commits in one repository and folder");

    const unchanged = artifact(current);
    unchanged.source = previousSource;
    const unchangedRequest = request(current);
    unchangedRequest.command = { action: "submit", ...previousSource };
    await expect(metadataHarness(current).publisher.publish(unchangedRequest, unchanged, run))
      .rejects.toThrow("distinct commits in one repository and folder");
  });

  it("treats an existing correlated result as a no-op", async () => {
    const current = loaded();
    const harness = metadataHarness(current, true);
    await expect(harness.publisher.publish(request(current), artifact(current), run))
      .resolves.toEqual({ kind: "no-op" });
    expect(harness.writeFiles).not.toHaveBeenCalled();
    expect(harness.control.clearCommandProgress).toHaveBeenCalledWith(80);
  });
});

function metadataHarness(current: LoadedSubmission, finished = false): {
  publisher: MetadataPublisher;
  control: PublisherControl;
  writeFiles: ReturnType<typeof vi.fn>;
  readonly changes: ArchiveChanges;
} {
  const control: PublisherControl = {
    resultExists: vi.fn(async () => finished),
    successReactionExists: vi.fn(async () => false),
    resolveOwnerPairs: vi.fn(async (owners) => owners),
    postIssueComment: vi.fn(),
    completeCommand: vi.fn(),
    clearCommandProgress: vi.fn(),
  };
  let changes: ArchiveChanges = {};
  const writeFiles = vi.fn(async (args: Parameters<PublisherArchive["writeFiles"]>[0]) => {
    changes = args.changes;
    await args.validateCurrent(current);
    return "c".repeat(40);
  });
  const archive: PublisherArchive = {
    load: vi.fn(async () => current),
    listDependents: vi.fn(async () => []),
    listRegisteredSuperseders: vi.fn(async () => []),
    writeFiles,
  };
  return {
    publisher: new MetadataPublisher(control, archive, repositoryId),
    control,
    writeFiles,
    get changes() { return changes; },
  };
}

function loaded(): LoadedSubmission {
  const runtime = configuredRuntime(epoch());
  const texts = initialFiles("lax-42", issue, alice, "2026-07-30T10:00:00Z");
  texts["record.json"] = jsonFile({
    specVersion: "1",
    id: "lax-42",
    state: "draft",
    createdAt: "2026-07-30T10:00:00Z",
    source: previousSource,
  });
  texts["build-output.json"] = jsonFile({
    specVersion: "1",
    id: "lax-42",
    issue,
    inputs: {
      manifest: {
        specVersion: "1",
        id: "lax-42",
        leanVersion: runtime.leanVersion,
        mathlibVersion: runtime.mathlibCommit,
        title: "Original title",
        authors: [{ name: "Alice Example" }],
        bibEntries: [],
      },
      abstract: "Original abstract.\n",
    },
    requiredByConcepts: [],
    requiredByProofs: [],
    concepts: [{
      id: "Lax42.Demo",
      path: "Lax42/Demo.lean",
      title: "Demo",
      type: "definition",
      description: "Demo.",
      imports: [],
      mathlibImports: [],
      sourceText: "def demo := True\n",
      statements: [],
    }],
    proofs: [],
    capture: {
      formatVersion: 1,
      digest: "4".repeat(64),
      sourceCommit: previousSource.commit,
      leanToolchain: runtime.leanToolchain,
      mathlibCommit: runtime.mathlibCommit,
      files: [{ path: "concepts/Lax42.olean", bytes: 3, sha256: "5".repeat(64) }],
      registryBlob: `ghcr.io/lax-archive/lax-captures@sha256:${"4".repeat(64)}`,
    },
  });
  return {
    snapshot: { branch: "main", sha: "a".repeat(40) },
    texts,
    files: parseArchiveFiles("lax-42", texts),
    preconditions: fileDigests(texts),
  };
}

function request(current: LoadedSubmission): PublishRequest {
  return {
    action: "submit",
    id: "lax-42",
    issue,
    actor: alice,
    issueNodeId: "I_kwDOexample",
    eventCreatedAt: "2026-07-30T11:00:00Z",
    commentId: 80,
    archiveSha: current.snapshot.sha,
    command: { action: "submit", ...nextSource },
    preconditions: current.preconditions,
  };
}

function artifact(current: LoadedSubmission): ParsedMetadataResubmissionArtifact {
  const previous = current.files.buildOutput.inputs as {
    manifest: Record<string, unknown>;
    abstract: string;
  };
  return {
    metadataVersion: 1,
    id: "lax-42",
    previousSource,
    source: nextSource,
    previousBuildOutput: current.preconditions.buildOutput,
    fields: ["title", "abstract"],
    inputs: {
      manifest: { ...previous.manifest, title: "Better title" },
      abstract: "A better abstract.\n",
    },
  };
}
