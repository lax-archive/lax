import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArchiveSnapshot } from "../../src/submission-validation/archive/snapshot.js";
import { describeLocalCapture } from "../../src/submission-validation/captures/seal.js";
import type {
  ArchiveSourceRecord,
  PublishedCapture,
  StaticResult,
} from "../../src/submission-validation/contracts.js";
import { runResolution } from "../../src/submission-validation/phases/resolution.js";
import { containedDirectory } from "../../src/submission-validation/source/fetch.js";
import {
  cleanupTemporary,
  COMMIT,
  request,
  REPOSITORY,
  RUNTIME,
  staticResult,
  temporary,
  writeFile,
} from "../support/submission-validation.js";

afterEach(cleanupTemporary);

function capture(overrides: Partial<PublishedCapture> = {}): PublishedCapture {
  return {
    formatVersion: 1,
    digest: "d".repeat(64),
    sourceCommit: COMMIT,
    leanToolchain: RUNTIME.leanToolchain,
    mathlibCommit: RUNTIME.mathlibCommit,
    files: [],
    registryBlob: `ghcr.io/lax-archive/lax-captures@sha256:${"d".repeat(64)}`,
    ...overrides,
  };
}

function writeArchiveRecord(
  root: string,
  id: string,
  options: {
    state?: ArchiveSourceRecord["state"];
    folder?: string;
    concepts?: string[];
    proofs?: string[];
    /** Statement ids per concept entry of the record's build output. */
    statements?: string[][];
    capture?: PublishedCapture | Record<string, unknown>;
    /** Numeric owner ids written to owner-list.json when present. */
    owners?: number[];
    /** A supersedes claim echoed under the build output's inputs.manifest. */
    supersedes?: string;
  } = {},
): void {
  const state = options.state ?? "registered";
  const directory = path.join(root, id);
  fs.mkdirSync(directory, { recursive: true });
  writeFile(
    directory,
    "record.json",
    JSON.stringify({
      specVersion: "1",
      id,
      state,
      ...((state === "draft" || state === "registered")
        ? { source: { repository: REPOSITORY, commit: COMMIT, folder: options.folder ?? "." } }
        : {}),
    }),
  );
  writeFile(
    directory,
    "build-output.json",
    JSON.stringify({
      specVersion: "1",
      id,
      requiredByConcepts: options.concepts ?? [],
      requiredByProofs: options.proofs ?? [],
      concepts: (options.statements ?? []).map((ids, index) => ({
        id: `Concept${index + 1}`,
        statements: ids.map((statementId) => ({ id: statementId, signature: `${statementId} : True` })),
      })),
      capture: options.capture ?? capture(),
      ...(options.supersedes === undefined
        ? {}
        : { inputs: { manifest: { supersedes: options.supersedes } } }),
    }),
  );
  if (options.owners !== undefined) {
    writeFile(
      directory,
      "owner-list.json",
      JSON.stringify({
        specVersion: "1",
        owners: options.owners.map((githubId) => ({ githubId, handle: `owner-${githubId}` })),
      }),
    );
  }
}

function withConceptRequires(
  dependencies: Array<{ name: string; folder: string; commit?: string }>,
): StaticResult {
  const result = staticResult("lax-9");
  result.concepts!.lakefile.gitRequires = dependencies.map((dependency) => ({
    name: dependency.name,
    git: REPOSITORY,
    rev: dependency.commit ?? COMMIT,
    subDir: dependency.folder === "." ? "concepts" : `${dependency.folder}/concepts`,
  }));
  return result;
}

function resolve(staticCheck: StaticResult, archive: ArchiveSnapshot) {
  return runResolution(request("lax-9"), staticCheck, archive, RUNTIME);
}

describe("Archive dependency resolution retained from main", () => {
  it("resolves by package name and verifies the complete source triple", () => {
    const archiveRoot = temporary("lax-resolution-archive-");
    writeArchiveRecord(archiveRoot, "lax-10", { folder: "a" });
    writeArchiveRecord(archiveRoot, "lax-11", { folder: "b" });
    const archive = new ArchiveSnapshot(archiveRoot, "a".repeat(40));

    const accepted = resolve(
      withConceptRequires([
        { name: "Lax10", folder: "a" },
        { name: "Lax11", folder: "b" },
      ]),
      archive,
    );
    expect(accepted.findings.violations).toEqual([]);
    expect(accepted.result.all.map((dependency) => dependency.packageName)).toEqual([
      "Lax10",
      "Lax11",
    ]);

    const crossWired = resolve(withConceptRequires([{ name: "Lax10", folder: "b" }]), archive);
    expect(crossWired.findings.violations.map((finding) => finding.rule)).toContain(
      "dependency-source",
    );
    const crossWiredMessage = crossWired.findings.violations
      .map((finding) => finding.message)
      .join("\n");
    expect(crossWiredMessage).toContain("does not match the Archive source triple");
    // a stale pin is the chain workflow's characteristic failure: the message
    // has to say how to relink the chain
    expect(crossWiredMessage).toContain("chain workflow");
    // locally the same mismatch can just be an out-of-date database clone
    expect(crossWiredMessage).toContain("lax sync");
  });

  it("carries every statement of a multi-statement upstream concept", () => {
    // Statement ids are the currency of resolution; a concept declaring
    // several of them (no longer gated — see rewrite.md, "multiple statements
    // per concept") must expose all of them to the downstream submission, so
    // a downstream proof may conclude or assume either.
    const archiveRoot = temporary("lax-resolution-archive-");
    writeArchiveRecord(archiveRoot, "lax-10", {
      folder: "a",
      statements: [["Lax10.Two.claimB", "Lax10.Two.claimA"], ["Lax10.Fine.claim"]],
    });
    const archive = new ArchiveSnapshot(archiveRoot, "a".repeat(40));

    const resolved = resolve(withConceptRequires([{ name: "Lax10", folder: "a" }]), archive);
    expect(resolved.findings.violations).toEqual([]);
    expect(resolved.result.all[0]!.statements).toEqual([
      "Lax10.Fine.claim",
      "Lax10.Two.claimA",
      "Lax10.Two.claimB",
    ]);
  });

  it("distinguishes missing and permanently deleted dependencies", () => {
    const archiveRoot = temporary("lax-resolution-archive-");
    writeArchiveRecord(archiveRoot, "lax-10", { state: "deleted" });
    const archive = new ArchiveSnapshot(archiveRoot, "a".repeat(40));

    const result = resolve(
      withConceptRequires([
        { name: "Lax10", folder: "." },
        { name: "Lax99", folder: "." },
      ]),
      archive,
    );
    const byRule = new Map(
      result.findings.violations.map((finding) => [finding.rule, finding.message]),
    );
    expect(byRule.get("deleted-dependency")).toContain("id is retired");
    expect(byRule.get("missing-dependency")).toContain("has no content-bearing Archive record");
    // a deletion is monotone, so only the missing record can be a stale clone
    expect(byRule.get("missing-dependency")).toContain("lax sync");
    expect(byRule.get("deleted-dependency")).not.toContain("lax sync");
  });

  it("warns for draft dependencies and validates capture provenance", () => {
    const draftRoot = temporary("lax-resolution-draft-");
    writeArchiveRecord(draftRoot, "lax-10", { state: "draft" });
    const draft = resolve(
      withConceptRequires([{ name: "Lax10", folder: "." }]),
      new ArchiveSnapshot(draftRoot, "a".repeat(40)),
    );
    expect(draft.findings.violations).toEqual([]);
    expect(draft.findings.warnings.map((finding) => finding.message).join("\n")).toContain(
      "draft submission lax-10",
    );

    const staleRoot = temporary("lax-resolution-stale-capture-");
    writeArchiveRecord(staleRoot, "lax-10", {
      capture: capture({ sourceCommit: "e".repeat(40), mathlibCommit: "f".repeat(40) }),
    });
    const stale = resolve(
      withConceptRequires([{ name: "Lax10", folder: "." }]),
      new ArchiveSnapshot(staleRoot, "a".repeat(40)),
    );
    expect(stale.findings.violations.map((finding) => finding.rule)).toEqual([
      "capture-provenance",
      "capture-provenance",
    ]);
  });

  it("detects cycles in transitive Archive package requirements", () => {
    const archiveRoot = temporary("lax-resolution-cycle-");
    writeArchiveRecord(archiveRoot, "lax-10", { concepts: ["Lax11"] });
    writeArchiveRecord(archiveRoot, "lax-11", { concepts: ["Lax10"] });

    const result = resolve(
      withConceptRequires([{ name: "Lax10", folder: "." }]),
      new ArchiveSnapshot(archiveRoot, "a".repeat(40)),
    );
    expect(result.findings.violations.map((finding) => finding.message).join("\n")).toContain(
      "contain a cycle through Lax10",
    );
  });
});

describe("new validation trust boundaries", () => {
  it("accepts only bounded capture metadata addressed by the record's own digest", () => {
    const acceptedRoot = temporary("lax-capture-accepted-");
    writeArchiveRecord(acceptedRoot, "lax-10");
    const accepted = new ArchiveSnapshot(acceptedRoot, "a".repeat(40));
    expect(accepted.capture(accepted.get("lax-10")!)).toMatchObject({
      sourceCommit: COMMIT,
      registryBlob: expect.stringContaining("ghcr.io/"),
    });

    for (const invalidCapture of [
      // Foreign host, tag reference, and digest mismatch are all rejected:
      // consumers may only fetch the digest the record itself declares.
      capture({ registryBlob: "https://example.com/capture.tar" }),
      capture({ registryBlob: "ghcr.io/lax-archive/lax-captures:cap-some-tag" }),
      capture({ registryBlob: `ghcr.io/lax-archive/lax-captures@sha256:${"e".repeat(64)}` }),
      capture({ files: [{ path: "../escape", bytes: 1, sha256: "a".repeat(64) }] }),
      capture({
        files: [
          { path: "concepts/a", bytes: 1, sha256: "a".repeat(64) },
          { path: "concepts/a", bytes: 1, sha256: "a".repeat(64) },
        ],
      }),
    ]) {
      const root = temporary("lax-capture-rejected-");
      writeArchiveRecord(root, "lax-10", { capture: invalidCapture });
      const snapshot = new ArchiveSnapshot(root, "a".repeat(40));
      expect(snapshot.capture(snapshot.get("lax-10")!)).toBeUndefined();
    }
  });

  it("keeps submission folders inside the checkout and refuses symlink traversal", () => {
    const repository = temporary("lax-contained-repository-");
    const outside = temporary("lax-contained-outside-");
    fs.mkdirSync(path.join(repository, "plain"));
    fs.symlinkSync(outside, path.join(repository, "linked"));

    expect(containedDirectory(repository, "plain")).toBe(
      fs.realpathSync(path.join(repository, "plain")),
    );
    expect(() => containedDirectory(repository, "../outside")).toThrow("escapes the repository");
    expect(() => containedDirectory(repository, "linked")).toThrow("may not traverse a symlink");
  });

  it("describes local captures deterministically and refuses symbolic links", () => {
    const root = temporary("lax-local-capture-");
    writeFile(root, "z/file", "z");
    writeFile(root, "a/file", "a");
    const first = describeLocalCapture(root, COMMIT, RUNTIME);
    const second = describeLocalCapture(root, COMMIT, RUNTIME);
    expect(first).toEqual(second);
    expect(first.files.map((file) => file.path)).toEqual(["a/file", "z/file"]);

    fs.symlinkSync(path.join(root, "a", "file"), path.join(root, "link"));
    expect(() => describeLocalCapture(root, COMMIT, RUNTIME)).toThrow("symbolic link");
  });
});

describe("supersedes resolution", () => {
  function withSupersedes(target: string): StaticResult {
    const result = staticResult("lax-9");
    result.manifest = {
      specVersion: "1",
      id: "lax-9",
      leanVersion: RUNTIME.leanVersion,
      mathlibVersion: RUNTIME.mathlibCommit,
      title: "Test submission",
      authors: [],
      bibEntries: [],
      supersedes: target,
    };
    return result;
  }

  it("admits a registered target sharing an owner, with a free successor slot", () => {
    const root = temporary("lax-supersedes-archive-");
    writeArchiveRecord(root, "lax-9", { state: "init", owners: [1] });
    writeArchiveRecord(root, "lax-5", { owners: [1, 2] });

    const outcome = resolve(withSupersedes("lax-5"), new ArchiveSnapshot(root, "a".repeat(40)));
    expect(outcome.findings.violations).toEqual([]);
    expect(outcome.findings.warnings).toEqual([]);
  });

  it("rejects missing, draft, and deleted targets", () => {
    const root = temporary("lax-supersedes-archive-");
    writeArchiveRecord(root, "lax-9", { state: "init", owners: [1] });
    writeArchiveRecord(root, "lax-5", { state: "draft", owners: [1] });
    writeArchiveRecord(root, "lax-6", { state: "deleted" });
    const archive = new ArchiveSnapshot(root, "a".repeat(40));

    const messages = (target: string) =>
      resolve(withSupersedes(target), archive).findings.violations.map((finding) => finding.message).join("\n");
    expect(messages("lax-99")).toContain("has no Archive record");
    expect(messages("lax-5")).toContain("only a registered submission can be superseded");
    expect(messages("lax-6")).toContain("id is retired");
  });

  it("requires an owner of the target to own the submission, warning when it cannot tell", () => {
    const root = temporary("lax-supersedes-archive-");
    writeArchiveRecord(root, "lax-9", { state: "init", owners: [3] });
    writeArchiveRecord(root, "lax-5", { owners: [1, 2] });
    const disjoint = resolve(withSupersedes("lax-5"), new ArchiveSnapshot(root, "a".repeat(40)));
    expect(disjoint.findings.violations.map((finding) => finding.message).join("\n")).toContain(
      "can be superseded only by its own owners",
    );

    const bare = temporary("lax-supersedes-archive-");
    writeArchiveRecord(bare, "lax-9", { state: "init" });
    writeArchiveRecord(bare, "lax-5", {});
    const unknown = resolve(withSupersedes("lax-5"), new ArchiveSnapshot(bare, "a".repeat(40)));
    expect(unknown.findings.violations).toEqual([]);
    expect(unknown.findings.warnings.map((finding) => finding.message).join("\n")).toContain(
      "the archive itself will decide",
    );

    // an out-of-date copy may not carry the submitting record at all
    const absent = temporary("lax-supersedes-archive-");
    writeArchiveRecord(absent, "lax-5", { owners: [1] });
    const noOwnRecord = resolve(withSupersedes("lax-5"), new ArchiveSnapshot(absent, "a".repeat(40)));
    expect(noOwnRecord.findings.violations).toEqual([]);
    expect(noOwnRecord.findings.warnings.map((finding) => finding.message).join("\n")).toContain(
      "the archive itself will decide",
    );
  });

  it("enforces the single successor slot and warns about competing drafts", () => {
    const root = temporary("lax-supersedes-archive-");
    writeArchiveRecord(root, "lax-9", { state: "init", owners: [1] });
    writeArchiveRecord(root, "lax-5", { owners: [1] });
    writeArchiveRecord(root, "lax-8", { owners: [1], supersedes: "lax-5" });
    const taken = resolve(withSupersedes("lax-5"), new ArchiveSnapshot(root, "a".repeat(40)));
    expect(taken.findings.violations.map((finding) => finding.message).join("\n")).toContain(
      "lax-8 already supersedes lax-5",
    );

    const racing = temporary("lax-supersedes-archive-");
    writeArchiveRecord(racing, "lax-9", { state: "init", owners: [1] });
    writeArchiveRecord(racing, "lax-5", { owners: [1] });
    writeArchiveRecord(racing, "lax-8", { state: "draft", owners: [1], supersedes: "lax-5" });
    const race = resolve(withSupersedes("lax-5"), new ArchiveSnapshot(racing, "a".repeat(40)));
    expect(race.findings.violations).toEqual([]);
    expect(race.findings.warnings.map((finding) => finding.message).join("\n")).toContain(
      "the first to register claims the successor slot",
    );
  });
});
