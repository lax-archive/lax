import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StaticResult } from "../../src/submission-validation/contracts.js";
import { FindingCollector } from "../../src/submission-validation/findings.js";
import { resolveSiblings } from "../../src/submission-validation/phases/siblings.js";
import { runStaticValidation } from "../../src/submission-validation/phases/static.js";
import {
  appendRequirement,
  cleanupTemporary,
  COMMIT,
  initializeGit,
  makeSubmission,
  request,
  REPOSITORY,
  RUNTIME,
  staticResult,
  temporary,
  writeFile,
} from "../support/submission-validation.js";

afterEach(cleanupTemporary);

function monorepo(submissions: Array<{ id: string; folder: string }>): string {
  const top = temporary("lax-sibling-repository-");
  for (const submission of submissions) {
    makeSubmission(
      submission.id,
      submission.folder === "." ? top : path.join(top, submission.folder),
    );
  }
  return top;
}

function resolve(root: string, id: string): {
  graph: ReturnType<typeof resolveSiblings>;
  findings: FindingCollector;
} {
  const checked = runStaticValidation(request(id), root, RUNTIME);
  expect(
    checked.findings.violations,
    checked.findings.violations.map((finding) => finding.message).join("\n"),
  ).toEqual([]);
  const findings = new FindingCollector("resolution");
  return { graph: resolveSiblings(root, checked.result, findings), findings };
}

function messages(findings: FindingCollector): string {
  return findings.violations.map((finding) => finding.message).join("\n");
}

describe("sibling path resolution retained from main", () => {
  it("resolves a concept sibling and records its repository-relative source", () => {
    const top = monorepo([
      { id: "lax-1", folder: "a" },
      { id: "lax-2", folder: "b" },
    ]);
    appendRequirement(top, "b", "concepts", 'name = "Lax1"\npath = "../../a/concepts"');
    initializeGit(top);

    const { graph, findings } = resolve(path.join(top, "b"), "lax-2");
    expect(findings.violations).toEqual([]);
    expect(graph.concepts).toHaveLength(1);
    expect(graph.concepts[0]).toMatchObject({
      name: "Lax1",
      targetId: "lax-1",
      kind: "concepts",
      folder: "a",
    });
    expect(graph.closure.has("Lax1")).toBe(true);
  });

  it("normalizes legacy ids while resolving sibling submissions", () => {
    const top = monorepo([
      { id: "lax-1", folder: "a" },
      { id: "lax-2", folder: "b" },
    ]);
    const dependencyManifest = path.join(top, "a", "manifest.yaml");
    fs.writeFileSync(
      dependencyManifest,
      fs.readFileSync(dependencyManifest, "utf8").replace("id: lax-1", "id: Lax1"),
    );
    appendRequirement(top, "b", "concepts", 'name = "Lax1"\npath = "../../a/concepts"');
    initializeGit(top);

    const { graph, findings } = resolve(path.join(top, "b"), "lax-2");
    expect(findings.violations).toEqual([]);
    expect(graph.concepts[0]?.targetId).toBe("lax-1");
  });

  it("rejects missing targets, non-submissions, and manifest-id mismatches", () => {
    const top = monorepo([
      { id: "lax-3", folder: "a" },
      { id: "lax-2", folder: "b" },
    ]);
    appendRequirement(top, "b", "concepts", 'name = "Lax1"\npath = "../../a/concepts"');
    appendRequirement(top, "b", "concepts", 'name = "Lax8"\npath = "../../missing/concepts"');
    fs.mkdirSync(path.join(top, "plain", "concepts"), { recursive: true });
    appendRequirement(top, "b", "proofs", 'name = "Lax9"\npath = "../../plain/concepts"');
    initializeGit(top);

    const result = resolve(path.join(top, "b"), "lax-2");
    expect(messages(result.findings)).toContain("declares id lax-3");
    expect(messages(result.findings)).toContain("demands package Lax1");
    expect(messages(result.findings)).toContain("has no folder `missing/concepts`");
    expect(messages(result.findings)).toContain("not a submission");
  });

  it("rejects self-references including normalized variants of the own-concept edge", () => {
    const top = monorepo([{ id: "lax-2", folder: "b" }]);
    const filename = path.join(top, "b", "proofs", "lakefile.toml");
    fs.writeFileSync(
      filename,
      fs.readFileSync(filename, "utf8").replace('path = "../concepts"', 'path = "./../concepts"'),
    );
    initializeGit(top);

    const result = resolve(path.join(top, "b"), "lax-2");
    expect(messages(result.findings)).toContain("points back into this submission itself");
    expect(messages(result.findings)).toContain('{ path = "../concepts" }');
  });

  it("rejects lexical repository escapes and symlink escapes", () => {
    const outside = temporary("lax-sibling-outside-");
    makeSubmission("lax-1", path.join(outside, "a"));
    const top = monorepo([{ id: "lax-2", folder: "b" }]);
    fs.symlinkSync(path.join(outside, "a"), path.join(top, "linked"));
    appendRequirement(
      top,
      "b",
      "concepts",
      'name = "Lax1"\npath = "../../../outside/concepts"',
    );
    appendRequirement(top, "b", "proofs", 'name = "Lax1"\npath = "../../linked/concepts"');
    initializeGit(top);

    const result = resolve(path.join(top, "b"), "lax-2");
    expect(messages(result.findings)).toContain("escapes the repository");
    expect(messages(result.findings)).toContain("leaves the repository through a symlink");
  });

  it("detects transitive sibling cycles with their folder chain", () => {
    const top = monorepo([
      { id: "lax-1", folder: "a" },
      { id: "lax-2", folder: "b" },
    ]);
    appendRequirement(top, "a", "concepts", 'name = "Lax2"\npath = "../../b/concepts"');
    appendRequirement(top, "b", "concepts", 'name = "Lax1"\npath = "../../a/concepts"');
    initializeGit(top);

    const result = resolve(path.join(top, "b"), "lax-2");
    expect(messages(result.findings)).toContain("sibling path requires form a cycle");
    expect(messages(result.findings)).toContain("a/concepts");
    expect(messages(result.findings)).toContain("b/concepts");
  });

  it("scans the repository for nested folders and duplicate submission ids", () => {
    const nested = monorepo([
      { id: "lax-1", folder: "." },
      { id: "lax-2", folder: "sub" },
    ]);
    initializeGit(nested);
    expect(messages(resolve(path.join(nested, "sub"), "lax-2").findings)).toContain(
      "nested inside submission folder",
    );

    const duplicated = monorepo([
      { id: "lax-1", folder: "a" },
      { id: "lax-1", folder: "b" },
    ]);
    initializeGit(duplicated);
    expect(messages(resolve(path.join(duplicated, "a"), "lax-1").findings)).toContain(
      "two submission folders with the id lax-1",
    );
  });

  it("ignores dependency and fixture manifests that are not repository submissions", () => {
    const top = monorepo([{ id: "lax-1", folder: "a" }]);
    writeFile(top, ".lake/packages/dep/manifest.yaml", "id: lax-1\n");
    writeFile(top, "fixtures/manifest.yaml", "id: not-a-lax-id\n");
    initializeGit(top);

    expect(resolve(path.join(top, "a"), "lax-1").findings.violations).toEqual([]);
  });

  it("rejects conflicting package sources across the sibling closure", () => {
    const top = monorepo([
      { id: "lax-1", folder: "a" },
      { id: "lax-2", folder: "b" },
      { id: "lax-3", folder: "c" },
    ]);
    appendRequirement(top, "c", "concepts", 'name = "Lax1"\npath = "../../a/concepts"');
    appendRequirement(top, "c", "concepts", 'name = "Lax2"\npath = "../../b/concepts"');
    appendRequirement(
      top,
      "a",
      "concepts",
      `name = "Lax9"\ngit = "${REPOSITORY}"\nrev = "${COMMIT}"\nsubDir = "concepts"`,
    );
    appendRequirement(
      top,
      "b",
      "concepts",
      `name = "Lax9"\ngit = "${REPOSITORY}"\nrev = "${"f".repeat(40)}"\nsubDir = "concepts"`,
    );
    initializeGit(top);

    expect(messages(resolve(path.join(top, "c"), "lax-3").findings)).toContain(
      "package name Lax9 has two sources",
    );
  });

  it("resolves structurally outside git but warns that repository checks are unavailable", () => {
    const base = temporary("lax-sibling-no-git-");
    makeSubmission("lax-1", path.join(base, "a"));
    makeSubmission("lax-2", path.join(base, "b"));
    const result: StaticResult = staticResult("lax-2");
    result.concepts!.lakefile.pathRequires.push({ name: "Lax1", path: "../../a/concepts" });
    const findings = new FindingCollector("resolution");

    const graph = resolveSiblings(path.join(base, "b"), result, findings);
    expect(findings.violations).toEqual([]);
    expect(findings.warnings.map((finding) => finding.message).join("\n")).toContain(
      "not inside a git repository",
    );
    expect(graph.concepts[0]).toMatchObject({ name: "Lax1", targetId: "lax-1" });
    expect(graph.concepts[0]?.folder).toBeUndefined();
  });
});
