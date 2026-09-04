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
import { SubmitPublisher, type SubmitCaptureStore } from "../../src/shared/submit-publisher.js";
import { parsePaperOutput, type SuccessfulValidationArtifacts } from "../../src/submission-validation/artifact-schema.js";
import type { PublishedCapture, ResolvedDependency } from "../../src/submission-validation/contracts.js";
import {
  successfulArtifacts,
  TEST_CAPTURE,
  TEST_SOURCE,
} from "../support/validation-artifacts.js";

const repositoryId = 123456789;
const alice = { githubId: 10, handle: "alice" };
const bob = { githubId: 20, handle: "bob" };
const issue = { repositoryId, number: 42 };
const run = {
  id: "123456789",
  url: "https://github.com/lax-archive/lax/actions/runs/123456789",
};

/** Successful artifacts whose build output records a compiled paper. */
function paperArtifacts(): SuccessfulValidationArtifacts {
  const artifacts = successfulArtifacts();
  const paperManifest = { folder: "paper", main: "main.tex", engine: "pdflatex" as const };
  const paper = {
    ...paperManifest,
    pdf: { digest: "7".repeat(64), bytes: 4321, pages: 1 },
    pageSizes: [[612, 792]] as Array<[number, number]>,
    marks: [],
  };
  for (const output of [artifacts.buildOutput, artifacts.report.buildOutput]) {
    output.inputs.manifest.paper = paperManifest;
    output.paper = structuredClone(paper);
  }
  return artifacts;
}

/** Paper artifacts whose build output also records the derived web view. */
function webArtifacts(): SuccessfulValidationArtifacts {
  const artifacts = paperArtifacts();
  const web = {
    format: { tool: "reflowtex", rev: "8".repeat(40), schema: "9".repeat(64) },
    bundle: { digest: "6".repeat(64), bytes: 54321 },
  };
  for (const output of [artifacts.buildOutput, artifacts.report.buildOutput]) {
    output.paper!.web = structuredClone(web);
  }
  return artifacts;
}

describe("trusted submit publisher", () => {
  it("promotes the capture and commits exactly record.json and build-output.json", async () => {
    const current = loaded();
    const harness = submitHarness(new Map([["lax-42", current]]));
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
      registryBlob: expect.stringContaining(`@sha256:${TEST_CAPTURE.digest}`),
    });
    expect(combined["owner-list.json"]).toBe(current.texts["owner-list.json"]);
    expect(harness.captureStore.promote).toHaveBeenCalledExactlyOnceWith(
      "lax-42",
      TEST_SOURCE,
      TEST_CAPTURE,
      "/capture.tar",
      undefined,
      undefined,
    );
    // Ordering invariant: the ghcr push completes before the database CAS
    // commit that references the blob digest.
    expect(harness.captureStore.promote.mock.invocationCallOrder[0]!).toBeLessThan(
      harness.writeFiles.mock.invocationCallOrder[0]!,
    );
    expect(parsed.buildOutput).not.toHaveProperty("paper");
  });

  it("pushes a recorded paper beside the capture and binds its layer into the record", async () => {
    const current = loaded();
    const harness = submitHarness(new Map([["lax-42", current]]));
    const artifacts = paperArtifacts();
    const result = await harness.publisher.publish(request(current), artifacts, "/capture.tar", run, "/paper.pdf");
    expect(result).toMatchObject({ kind: "committed" });
    expect(harness.captureStore.promote).toHaveBeenCalledExactlyOnceWith(
      "lax-42",
      TEST_SOURCE,
      TEST_CAPTURE,
      "/capture.tar",
      { pdfPath: "/paper.pdf", digest: "7".repeat(64), bytes: 4321 },
      undefined,
    );
    const combined = { ...current.texts, ...harness.changes } as Record<string, string>;
    const parsed = parseArchiveFiles("lax-42", combined);
    const paper = (parsed.buildOutput as unknown as { paper: Record<string, unknown> }).paper;
    expect(paper).toEqual({
      ...artifacts.buildOutput.paper,
      pdf: { ...artifacts.buildOutput.paper!.pdf, registryBlob: `ghcr.io/lax-archive/lax-captures@sha256:${"7".repeat(64)}` },
    });
    // The record's paper parses as a published one: registryBlob required and
    // bound to the pdf digest.
    expect(() => parsePaperOutput(paper, artifacts.buildOutput.inputs.manifest.paper!, true)).not.toThrow();
  });

  it("refuses a paper without its PDF and a PDF without a paper before anything is pushed", async () => {
    const current = loaded();
    const withoutPdf = submitHarness(new Map([["lax-42", current]]));
    await expect(withoutPdf.publisher.publish(request(current), paperArtifacts(), "/capture.tar", run))
      .rejects.toThrow("records a paper exactly when a paper.pdf is supplied");
    expect(withoutPdf.captureStore.promote).not.toHaveBeenCalled();
    const strayPdf = submitHarness(new Map([["lax-42", current]]));
    await expect(strayPdf.publisher.publish(request(current), successfulArtifacts(), "/capture.tar", run, "/paper.pdf"))
      .rejects.toThrow("records a paper exactly when a paper.pdf is supplied");
    expect(strayPdf.captureStore.promote).not.toHaveBeenCalled();
  });

  it("pushes a recorded web bundle as the third layer and binds its registry address into `paper.web`", async () => {
    const current = loaded();
    const harness = submitHarness(new Map([["lax-42", current]]));
    const artifacts = webArtifacts();
    const result = await harness.publisher.publish(
      request(current),
      artifacts,
      "/capture.tar",
      run,
      "/paper.pdf",
      "/paper-web.tar",
    );
    expect(result).toMatchObject({ kind: "committed" });
    expect(harness.captureStore.promote).toHaveBeenCalledExactlyOnceWith(
      "lax-42",
      TEST_SOURCE,
      TEST_CAPTURE,
      "/capture.tar",
      { pdfPath: "/paper.pdf", digest: "7".repeat(64), bytes: 4321 },
      { bundlePath: "/paper-web.tar", digest: "6".repeat(64), bytes: 54321 },
    );
    const combined = { ...current.texts, ...harness.changes } as Record<string, string>;
    const parsed = parseArchiveFiles("lax-42", combined);
    const paper = (parsed.buildOutput as unknown as { paper: Record<string, unknown> }).paper;
    expect(paper).toEqual({
      ...artifacts.buildOutput.paper,
      pdf: { ...artifacts.buildOutput.paper!.pdf, registryBlob: `ghcr.io/lax-archive/lax-captures@sha256:${"7".repeat(64)}` },
      web: {
        ...artifacts.buildOutput.paper!.web,
        bundle: {
          ...artifacts.buildOutput.paper!.web!.bundle,
          registryBlob: `ghcr.io/lax-archive/lax-captures@sha256:${"6".repeat(64)}`,
        },
      },
    });
    // The record's paper parses as a published one: both registry blobs
    // required, each bound to its own recorded digest.
    expect(() => parsePaperOutput(paper, artifacts.buildOutput.inputs.manifest.paper!, true)).not.toThrow();
  });

  it("refuses a recorded web view without its tar and a tar without a record, before anything is pushed", async () => {
    const current = loaded();
    const withoutTar = submitHarness(new Map([["lax-42", current]]));
    await expect(withoutTar.publisher.publish(request(current), webArtifacts(), "/capture.tar", run, "/paper.pdf"))
      .rejects.toThrow("records a paper web view exactly when a paper-web.tar is supplied");
    expect(withoutTar.captureStore.promote).not.toHaveBeenCalled();
    const strayTar = submitHarness(new Map([["lax-42", current]]));
    await expect(
      strayTar.publisher.publish(request(current), paperArtifacts(), "/capture.tar", run, "/paper.pdf", "/paper-web.tar"),
    ).rejects.toThrow("records a paper web view exactly when a paper-web.tar is supplied");
    expect(strayTar.captureStore.promote).not.toHaveBeenCalled();
  });

  it("ignores owner-list digest changes but rechecks current numeric ownership", async () => {
    const routed = loaded();
    const ownerChanged = loaded(replaceOwnerList("lax-42", routed.texts, [alice, { githubId: 20, handle: "bob" }]));
    const harness = submitHarness(new Map([["lax-42", ownerChanged]]));
    await expect(
      harness.publisher.publish(request(routed), successfulArtifacts(), "/capture.tar", run),
    ).resolves.toMatchObject({ kind: "committed" });

    const removed = loaded(replaceOwnerList("lax-42", routed.texts, [{ githubId: 20, handle: "bob" }]));
    const rejected = submitHarness(new Map([["lax-42", removed]]));
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
    const harness = submitHarness(new Map([["lax-42", stale]]));
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
    const harness = submitHarness(archive);
    await harness.publisher.publish(request(current), artifacts, "/capture.tar", run);
    const dependencyReads = (harness.load.mock.calls as Array<[string]>).filter(([id]) => id === "lax-7");
    expect(dependencyReads.length).toBeGreaterThanOrEqual(3);

    const changed = dependencyLoaded({ ...dependency.files.record.source!, commit: "9".repeat(40) });
    const rejected = submitHarness(new Map([["lax-42", current], ["lax-7", changed]]));
    await expect(
      rejected.publisher.publish(request(current), artifacts, "/capture.tar", run),
    ).rejects.toThrow("source changed after validation");
    expect(rejected.captureStore.promote).not.toHaveBeenCalled();
  });

  it("admits a supersedes claim only when the command actor owns the registered target and its slot is free", async () => {
    const current = loaded();
    const artifacts = successfulArtifacts();
    artifacts.buildOutput.inputs.manifest.supersedes = "lax-7";

    const accepted = submitHarness(new Map([["lax-42", current], ["lax-7", registeredTarget()]]));
    await expect(
      accepted.publisher.publish(request(current), artifacts, "/capture.tar", run),
    ).resolves.toMatchObject({ kind: "committed" });
    expect(accepted.listRegisteredSuperseders).toHaveBeenCalledWith("lax-7", current.snapshot);
    const combined = { ...current.texts, ...accepted.changes } as Record<string, string>;
    const published = JSON.parse(combined["build-output.json"]!) as {
      inputs: { manifest: { supersedes?: string } };
    };
    expect(published.inputs.manifest.supersedes).toBe("lax-7");

    const draftTarget = submitHarness(new Map([["lax-42", current], ["lax-7", dependencyLoaded()]]));
    await expect(
      draftTarget.publisher.publish(request(current), artifacts, "/capture.tar", run),
    ).rejects.toThrow("lax-7 is draft; only a registered submission can be superseded");
    expect(draftTarget.captureStore.promote).not.toHaveBeenCalled();

    const missingTarget = submitHarness(new Map([["lax-42", current]]));
    await expect(
      missingTarget.publisher.publish(request(current), artifacts, "/capture.tar", run),
    ).rejects.toThrow("supersedes lax-7, which is missing from lax-database");

    const foreignTarget = submitHarness(new Map([["lax-42", current], ["lax-7", registeredTarget(bob)]]));
    await expect(
      foreignTarget.publisher.publish(request(current), artifacts, "/capture.tar", run),
    ).rejects.toThrow(
      "alice does not own lax-7; only an owner of the superseded submission may submit or register lax-42",
    );

    const overlapping = loaded(replaceOwnerList("lax-42", current.texts, [alice, bob]));
    const overlapOnly = submitHarness(
      new Map([["lax-42", overlapping], ["lax-7", registeredTarget(bob)]]),
    );
    await expect(
      overlapOnly.publisher.publish(request(overlapping), artifacts, "/capture.tar", run),
    ).rejects.toThrow(
      "alice does not own lax-7; only an owner of the superseded submission may submit or register lax-42",
    );

    const takenSlot = submitHarness(
      new Map([["lax-42", current], ["lax-7", registeredTarget()]]),
      false,
      ["lax-30"],
    );
    await expect(
      takenSlot.publisher.publish(request(current), artifacts, "/capture.tar", run),
    ).rejects.toThrow("lax-30 already supersedes lax-7; a submission has at most one successor");
  });

  it("treats an existing correlated result as a no-op", async () => {
    const current = loaded();
    const harness = submitHarness(new Map([["lax-42", current]]), true);
    await expect(
      harness.publisher.publish(request(current), successfulArtifacts(), "/capture.tar", run),
    ).resolves.toEqual({ kind: "no-op" });
    expect(harness.control.resultExists).toHaveBeenCalledWith(
      issue.number,
      80,
      "2026-07-30T11:00:00Z",
    );
    expect(harness.load).not.toHaveBeenCalled();
    expect(harness.captureStore.promote).not.toHaveBeenCalled();
    expect(harness.clearProgress).toHaveBeenCalledWith(80);
  });
});

describe("maintainer revalidation", () => {
  const maintainers = new Set([alice.githubId]);
  /** lax-42 registered with the very source the test artifacts were validated from. */
  const registeredCurrent = (source = TEST_SOURCE): LoadedSubmission => {
    const texts = initialFiles("lax-42", issue, alice, "2026-07-30T10:00:00Z");
    texts["record.json"] = jsonFile({
      specVersion: "1",
      id: "lax-42",
      state: "registered",
      createdAt: "2026-07-30T10:00:00Z",
      source,
    });
    return loaded(texts);
  };
  const revalidation = (current: LoadedSubmission): PublishRequest => ({
    ...request(current),
    action: "revalidate",
    command: { action: "revalidate", admin: true, source: { ...TEST_SOURCE } },
  });

  it("republishes a registered record's build output without changing its state", async () => {
    const current = registeredCurrent();
    const harness = submitHarness(new Map([["lax-42", current]]), false, [], maintainers);
    const result = await harness.publisher.publish(revalidation(current), successfulArtifacts(), "/capture.tar", run);
    expect(result.kind).toBe("committed");
    expect(harness.captureStore.promote).toHaveBeenCalledTimes(1);
    expect(Object.keys(harness.changes).sort()).toEqual(["build-output.json", "record.json"]);
    expect(JSON.parse(harness.changes["record.json"]!)).toMatchObject({
      state: "registered",
      source: TEST_SOURCE,
      createdAt: "2026-07-30T10:00:00Z",
    });
    expect(JSON.parse(harness.changes["build-output.json"]!)).toMatchObject({
      capture: { registryBlob: expect.stringContaining("sha256:") },
    });
    const message = harness.writeFiles.mock.calls[0]![0].message;
    expect(message.startsWith("admin revalidate lax-42 by alice (10)\n")).toBe(true);
    // a maintainer need not own the record: the owner gate is replaced, not widened
    expect(current.files.ownerList.owners).toEqual([alice]);
  });

  it("refuses a non-maintainer, a record whose source moved, and a changed supersedes claim", async () => {
    const current = registeredCurrent();
    const stranger = submitHarness(new Map([["lax-42", current]]), false, [], new Set([99]));
    await expect(
      stranger.publisher.publish(revalidation(current), successfulArtifacts(), "/capture.tar", run),
    ).rejects.toThrow("alice is not an archive maintainer");
    expect(stranger.captureStore.promote).not.toHaveBeenCalled();

    const moved = registeredCurrent({ ...TEST_SOURCE, commit: "e".repeat(40) });
    const stale = submitHarness(new Map([["lax-42", moved]]), false, [], maintainers);
    await expect(
      stale.publisher.publish(revalidation(current), successfulArtifacts(), "/capture.tar", run),
    ).rejects.toThrow("no longer records the source the revalidation was authorized for");

    const claiming = successfulArtifacts();
    claiming.buildOutput.inputs.manifest.supersedes = "lax-7";
    claiming.report.buildOutput.inputs.manifest.supersedes = "lax-7";
    const changed = submitHarness(new Map([["lax-42", current]]), false, [], maintainers);
    await expect(
      changed.publisher.publish(revalidation(current), claiming, "/capture.tar", run),
    ).rejects.toThrow("may not change the recorded supersedes claim");
    // the target is not re-admitted: no ownership walk of a claim that is already bound
    expect(changed.listRegisteredSuperseders).not.toHaveBeenCalled();
  });

  it("keeps an ordinary submit on the ordinary gates", async () => {
    const current = registeredCurrent();
    const harness = submitHarness(new Map([["lax-42", current]]), false, [], maintainers);
    await expect(
      harness.publisher.publish(request(current), successfulArtifacts(), "/capture.tar", run),
    ).rejects.toThrow("is now registered");
  });
});

function submitHarness(
  values: Map<string, LoadedSubmission>,
  resultExists = false,
  registeredSuperseders: string[] = [],
  admins?: ReadonlySet<number>,
): {
  publisher: SubmitPublisher;
  control: PublisherControl;
  captureStore: { promote: ReturnType<typeof vi.fn> };
  load: ReturnType<typeof vi.fn>;
  listRegisteredSuperseders: ReturnType<typeof vi.fn>;
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
  const listRegisteredSuperseders = vi.fn(async () => registeredSuperseders);
  const archive: PublisherArchive = { load, listRegisteredSuperseders, writeFiles };
  const publishedCapture: PublishedCapture = {
    ...TEST_CAPTURE,
    registryBlob: `ghcr.io/lax-archive/lax-captures@sha256:${TEST_CAPTURE.digest}`,
  };
  const captureStore = {
    promote: vi.fn(async (_id, _source, _manifest, _capturePath, paper, paperWeb) => ({
      capture: publishedCapture,
      ...(paper === undefined ? {} : { paperBlob: `ghcr.io/lax-archive/lax-captures@sha256:${paper.digest}` }),
      ...(paperWeb === undefined ? {} : { paperWebBlob: `ghcr.io/lax-archive/lax-captures@sha256:${paperWeb.digest}` }),
    })),
  } satisfies SubmitCaptureStore;
  return {
    publisher: new SubmitPublisher(control, archive, captureStore, repositoryId, admins),
    control,
    captureStore,
    load,
    listRegisteredSuperseders,
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

/** A registered lax-7 for supersedes targets; `owner` varies the overlap. */
function registeredTarget(owner = alice): LoadedSubmission {
  const targetIssue = { repositoryId, number: 7 };
  const texts = initialFiles("lax-7", targetIssue, owner, "2026-07-01T10:00:00Z");
  texts["record.json"] = jsonFile({
    specVersion: "1",
    id: "lax-7",
    state: "registered",
    createdAt: "2026-07-01T10:00:00Z",
    source: { repository: "https://github.com/alice/dependency", commit: "7".repeat(40), folder: "." },
  });
  return {
    snapshot: { branch: "main", sha: "a".repeat(40) },
    texts,
    files: parseArchiveFiles("lax-7", texts),
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
      registryBlob: `ghcr.io/lax-archive/lax-captures@sha256:${"8".repeat(64)}`,
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
    action: "submit",
    id: "lax-42",
    issue,
    actor: alice,
    issueNodeId: "I_kwDOexample",
    eventCreatedAt: "2026-07-30T11:00:00Z",
    archiveSha: "a".repeat(40),
    commentId: 80,
    command: { action: "submit", ...TEST_SOURCE },
    preconditions: current.preconditions,
  };
}
