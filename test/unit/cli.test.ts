import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseIssueReference, resolveIssueReference } from "../../src/cli/commands.js";
import { normalizeRepositoryUrl } from "../../src/cli/git.js";
import { CONTROL_REPOSITORY_ID } from "../../src/shared/constants.js";
import {
  issueNumberFromFolder,
  setManifestIssue,
  submissionIdFromFolder,
} from "../../src/cli/manifest.js";
import { epoch } from "../../src/submission-validation/environments.js";
import { ensureEmptyFolder, scaffoldSubmission } from "../../src/cli/scaffold.js";

const temporary: string[] = [];

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("CLI issue references", () => {
  it("accepts numbers and authoritative issue URLs, resolving legacy ids separately", () => {
    expect(parseIssueReference("42")).toBe(42);
    expect(parseIssueReference("https://github.com/lax-archive/lax/issues/42")).toBe(42);
    expect(resolveIssueReference("lax-41")).toBe(41);
    expect(resolveIssueReference("Lax41")).toBe(41);
    expect(() => resolveIssueReference("lax-42")).toThrow("not in your local archive copy");
    expect(() => resolveIssueReference("42")).toThrow("does not identify a legacy submission");
  });

  it("rejects issue URLs from another repository", () => {
    expect(() => parseIssueReference("https://github.com/other/lax/issues/42")).toThrow(
      "must belong",
    );
  });

  it("resolves a local submission folder through manifest.yaml", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lax-cli-test-"));
    temporary.push(root);
    scaffoldSubmission(root, "lax-123456", "Local example", epoch());
    setManifestIssue(root, { repositoryId: CONTROL_REPOSITORY_ID, number: 42 });
    expect(issueNumberFromFolder(root)).toBe(42);
    expect(resolveIssueReference(root)).toBe(42);
    expect(fs.readFileSync(path.join(root, "manifest.yaml"), "utf8")).toContain("id: lax-123456");
    expect(fs.existsSync(path.join(root, "concepts", "Lax123456.lean"))).toBe(true);
    expect(fs.existsSync(path.join(root, "proofs", "Lax123456Proofs.lean"))).toBe(true);

    fs.writeFileSync(
      path.join(root, "manifest.yaml"),
      fs.readFileSync(path.join(root, "manifest.yaml"), "utf8").replace(
        "id: lax-123456",
        "id: Lax123456",
      ),
    );
    expect(issueNumberFromFolder(root)).toBe(42);
    expect(resolveIssueReference(root)).toBe(42);
  });

  it("reads an offline scaffold locally and refuses it every way to the archive", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lax-cli-test-"));
    temporary.push(root);
    scaffoldSubmission(root, "lax-123456", "Offline example", epoch());
    fs.writeFileSync(
      path.join(root, "manifest.yaml"),
      fs.readFileSync(path.join(root, "manifest.yaml"), "utf8").replace(
        "id: lax-123456",
        "id: lax-0",
      ),
    );
    const manifest = fs.readFileSync(path.join(root, "manifest.yaml"), "utf8");
    expect(manifest).toContain("id: lax-0");
    // no login, so no author to name: the list starts empty rather than wrong
    expect(manifest).toContain("authors: []");
    expect(fs.existsSync(path.join(root, "concepts", "Lax123456.lean"))).toBe(true);
    expect(fs.existsSync(path.join(root, "proofs", "Lax123456Proofs.lean"))).toBe(true);

    // everything local works with it …
    expect(submissionIdFromFolder(root)).toBe("lax-0");
    // … and everything that would post to an issue says why it cannot
    expect(() => issueNumberFromFolder(root)).toThrow("placeholder id lax-0");
    expect(() => resolveIssueReference(root)).toThrow("lax submit");
    expect(() => parseIssueReference("lax-0")).toThrow("issue must be a number");
    expect(() => parseIssueReference("Lax0")).toThrow("issue must be a number");
    expect(() => parseIssueReference("0")).toThrow("issue must be a number");
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
