import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LoadedSubmission } from "../../src/shared/archive.js";
import {
  fileDigests,
  initialFiles,
  jsonFile,
  parseArchiveFiles,
} from "../../src/shared/archive-schema.js";
import type { PublishRequest } from "../../src/shared/types.js";
import {
  classifyFetchedMetadataResubmission,
} from "../../src/submission-validation/metadata-resubmission.js";
import { configuredRuntime } from "../../src/submission-validation/config.js";
import { epoch } from "../../src/submission-validation/environments.js";
import { cleanupTemporary, temporary, writeFile } from "../support/submission-validation.js";

const repositoryId = 123456789;
const issue = { repositoryId, number: 42 };
const alice = { githubId: 10, handle: "alice" };
const repository = "https://github.com/alice/submission";

afterEach(cleanupTemporary);

describe("metadata-only resubmission classification", () => {
  it("admits title, author, and abstract changes while binding both exact trees", () => {
    const fixture = repositoryFixture();
    const nextManifest = fixture.manifest
      .replace("title: Original title", "title: Better title")
      .replace("  - name: Alice Example", "  - name: Alice Example\n  - name: Bob Example");
    const next = fixture.commit({ "manifest.yaml": nextManifest, "abstract.md": "A better abstract.\n" });
    const result = classifyFetchedMetadataResubmission(
      request(fixture.current, next),
      fixture.current,
      fixture.root,
    );
    expect(result).toMatchObject({
      previousSource: { commit: fixture.previous },
      source: { commit: next },
      fields: ["title", "authors", "abstract"],
      inputs: {
        manifest: { title: "Better title", authors: [{ name: "Alice Example" }, { name: "Bob Example" }] },
        abstract: "A better abstract.\n",
      },
    });
  });

  it("admits an abstract-only commit", () => {
    const fixture = repositoryFixture();
    const next = fixture.commit({ "abstract.md": "Only the abstract changed.\n" });
    expect(classifyFetchedMetadataResubmission(request(fixture.current, next), fixture.current, fixture.root))
      .toMatchObject({ fields: ["abstract"] });
  });

  it.each([
    ["a code newline", { "concepts/Lax42.lean": "\n" }],
    ["an added empty file", { "empty": "" }],
    ["an unrelated newline", { "LICENSE": "license\n\n" }],
    ["a file mode change", { "concepts/Lax42.lean": "", ".mode": "concepts/Lax42.lean" }],
  ])("falls back for %s", (_label, changes) => {
    const fixture = repositoryFixture();
    const mode = (changes as Record<string, string>)[".mode"];
    const files = {
      ...Object.fromEntries(Object.entries(changes).filter(([name]) => name !== ".mode")),
      "manifest.yaml": fixture.manifest.replace("Original title", "Better title"),
    };
    const next = fixture.commit(files, mode);
    expect(classifyFetchedMetadataResubmission(request(fixture.current, next), fixture.current, fixture.root))
      .toBeUndefined();
  });

  it("falls back when any non-whitelisted manifest field changes", () => {
    const fixture = repositoryFixture();
    const next = fixture.commit({
      "manifest.yaml": fixture.manifest
        .replace("title: Original title", "title: Better title")
        .replace("bibEntries: []", "unlisted: true\nbibEntries: []"),
    });
    expect(classifyFetchedMetadataResubmission(request(fixture.current, next), fixture.current, fixture.root))
      .toBeUndefined();
  });

  it("falls back for byte changes outside the whitelisted YAML value nodes", () => {
    const fixture = repositoryFixture();
    const next = fixture.commit({
      "manifest.yaml": fixture.manifest
        .replace("title: Original title", "title: Better title")
        .replace('specVersion: "1"\n', 'specVersion: "1"\n\n'),
    });
    expect(classifyFetchedMetadataResubmission(request(fixture.current, next), fixture.current, fixture.root))
      .toBeUndefined();
  });

  it("falls back when the previous commit does not match the archived inputs", () => {
    const fixture = repositoryFixture();
    fixture.current.files.buildOutput.inputs = {
      manifest: { ...(fixture.current.files.buildOutput.inputs as { manifest: object }).manifest, title: "Drift" },
      abstract: "Original abstract.\n",
    };
    const next = fixture.commit({ "manifest.yaml": fixture.manifest.replace("Original title", "Better title") });
    expect(classifyFetchedMetadataResubmission(request(fixture.current, next), fixture.current, fixture.root))
      .toBeUndefined();
  });

  it("falls back for an empty commit and for a repository or folder move", () => {
    const fixture = repositoryFixture();
    const next = fixture.commit({});
    expect(classifyFetchedMetadataResubmission(request(fixture.current, next), fixture.current, fixture.root))
      .toBeUndefined();
    const moved = request(fixture.current, next);
    moved.command = { ...moved.command!, repository: "https://github.com/alice/other" } as typeof moved.command;
    expect(classifyFetchedMetadataResubmission(moved, fixture.current, fixture.root)).toBeUndefined();
  });
});

function repositoryFixture(): {
  root: string;
  manifest: string;
  previous: string;
  current: LoadedSubmission;
  commit(files: Record<string, string>, executable?: string): string;
} {
  const root = temporary("lax-metadata-git-");
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "tests@example.com");
  git(root, "config", "user.name", "Tests");
  const runtime = configuredRuntime(epoch());
  const manifest =
    `specVersion: "1"\nid: lax-42\nleanVersion: ${runtime.leanVersion}\n` +
    `mathlibVersion: ${runtime.mathlibCommit}\ntitle: Original title\n` +
    "authors:\n  - name: Alice Example\nbibEntries: []\n" +
    `issue:\n  repositoryId: ${repositoryId}\n  number: ${issue.number}\n`;
  for (const [filename, content] of Object.entries({
    "manifest.yaml": manifest,
    "abstract.md": "Original abstract.\n",
    "LICENSE": "license\n",
    "concepts/Lax42.lean": "",
  })) writeFile(root, filename, content);
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "original");
  const previous = git(root, "rev-parse", "HEAD");
  const texts = initialFiles("lax-42", issue, alice, "2026-07-30T10:00:00Z");
  texts["record.json"] = jsonFile({
    specVersion: "1",
    id: "lax-42",
    state: "draft",
    createdAt: "2026-07-30T10:00:00Z",
    source: { repository, commit: previous, folder: "." },
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
    concepts: [],
    proofs: [],
    capture: {
      formatVersion: 1,
      digest: "4".repeat(64),
      sourceCommit: previous,
      leanToolchain: runtime.leanToolchain,
      mathlibCommit: runtime.mathlibCommit,
      files: [{ path: "concepts/Lax42.olean", bytes: 3, sha256: "5".repeat(64) }],
      registryBlob: `ghcr.io/lax-archive/lax-captures@sha256:${"4".repeat(64)}`,
    },
  });
  const current: LoadedSubmission = {
    snapshot: { branch: "main", sha: "a".repeat(40) },
    texts,
    files: parseArchiveFiles("lax-42", texts),
    preconditions: fileDigests(texts),
  };
  return {
    root,
    manifest,
    previous,
    current,
    commit(files, executable) {
      for (const [filename, content] of Object.entries(files)) writeFile(root, filename, content);
      if (executable !== undefined) fs.chmodSync(path.join(root, executable), 0o755);
      git(root, "add", "-A");
      git(root, "commit", "--quiet", "--allow-empty", "-m", "next");
      return git(root, "rev-parse", "HEAD");
    },
  };
}

function request(current: LoadedSubmission, commit: string): PublishRequest {
  return {
    action: "submit",
    id: "lax-42",
    issue,
    actor: alice,
    issueNodeId: "I_kwDOexample",
    eventCreatedAt: "2026-07-30T11:00:00Z",
    commentId: 80,
    archiveSha: current.snapshot.sha,
    command: { action: "submit", repository, commit, folder: "." },
    preconditions: current.preconditions,
  };
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}
