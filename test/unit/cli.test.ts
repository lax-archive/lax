import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseIssueReference, resolveIssueReference } from "../../src/cli/commands.js";
import { normalizeRepositoryUrl } from "../../src/cli/git.js";
import { issueNumberFromFolder } from "../../src/cli/manifest.js";
import { ensureEmptyFolder, scaffoldSubmission } from "../../src/cli/scaffold.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("CLI issue references", () => {
  it("accepts numbers, canonical ids and authoritative issue URLs", () => {
    expect(parseIssueReference("42")).toBe(42);
    expect(parseIssueReference("lax-42")).toBe(42);
    expect(parseIssueReference("Lax42")).toBe(42);
    expect(parseIssueReference("https://github.com/lax-archive/lax/issues/42")).toBe(42);
  });

  it("rejects issue URLs from another repository", () => {
    expect(() => parseIssueReference("https://github.com/other/lax/issues/42")).toThrow(
      "must belong",
    );
  });

  it("resolves a local submission folder through manifest.yaml", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lax-cli-test-"));
    temporary.push(root);
    scaffoldSubmission(root, 42, "Local example", "alice");
    expect(issueNumberFromFolder(root)).toBe(42);
    expect(resolveIssueReference(root)).toBe(42);
    expect(fs.readFileSync(path.join(root, "manifest.yaml"), "utf8")).toContain("id: lax-42");
    expect(fs.existsSync(path.join(root, "concepts", "Lax42.lean"))).toBe(true);
    expect(fs.existsSync(path.join(root, "proofs", "Lax42Proofs.lean"))).toBe(true);

    fs.writeFileSync(
      path.join(root, "manifest.yaml"),
      fs.readFileSync(path.join(root, "manifest.yaml"), "utf8").replace("id: lax-42", "id: Lax42"),
    );
    expect(issueNumberFromFolder(root)).toBe(42);
    expect(resolveIssueReference(root)).toBe(42);
  });

  it("refuses to scaffold over an existing folder", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lax-cli-test-"));
    temporary.push(root);
    fs.writeFileSync(path.join(root, "keep.txt"), "mine\n");
    expect(() => ensureEmptyFolder(root)).toThrow("not empty");
  });

  it("normalizes GitHub SSH origins for issue submissions", () => {
    expect(normalizeRepositoryUrl("git@github.com:alice/formalization.git")).toBe(
      "https://github.com/alice/formalization",
    );
    expect(normalizeRepositoryUrl("ssh://git@github.com/alice/formalization.git")).toBe(
      "https://github.com/alice/formalization",
    );
  });
});
