import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialFiles } from "../../src/shared/archive-schema.js";
import {
  CONTROL_REPOSITORY_ID,
  GITHUB_ACTIONS_BOT_ID,
  GITHUB_ACTIONS_BOT_LOGIN,
  LEGACY_SUBMISSION_IDS,
} from "../../src/shared/constants.js";
import { GitHubClient } from "../../src/shared/github.js";
import {
  isLegacyIssueReservationBody,
  LEGACY_ISSUE_RESERVATION_BODY,
  submissionIdFromIssueBody,
} from "../../src/shared/issue-reservation.js";
import {
  initializeSubmission,
  prepareLocalSubmission,
  replaceOwners,
} from "../../src/cli/commands.js";
import {
  readLocalSubmissionManifest,
  setInitialOwners,
  setManifestId,
} from "../../src/cli/manifest.js";
import { scaffoldSubmission } from "../../src/cli/scaffold.js";

const temporary: string[] = [];
const archiveSha = "a".repeat(40);
const id = "lax-123456";
const issue = { repositoryId: CONTROL_REPOSITORY_ID, number: 42 };
const alice = { githubId: 10, handle: "alice" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.LAX_POLL_INTERVAL_MS;
  delete process.env.LAX_WORKFLOW_TIMEOUT_MS;
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("loginless submission initialization", () => {
  it("freezes the complete pre-migration submission id allowlist", () => {
    expect([...LEGACY_SUBMISSION_IDS]).toEqual([
      "lax-3", "lax-4", "lax-5", "lax-6", "lax-8", "lax-9",
      "lax-10", "lax-11", "lax-12", "lax-13", "lax-14", "lax-15", "lax-16", "lax-17", "lax-18",
      "lax-41",
      "lax-46", "lax-47", "lax-48", "lax-49", "lax-50", "lax-51", "lax-52", "lax-53", "lax-54",
      "lax-55", "lax-56", "lax-57", "lax-58", "lax-59", "lax-60", "lax-61", "lax-62",
    ]);
  });

  it("recognizes only the exact historical markerless issue body", () => {
    expect(isLegacyIssueReservationBody(LEGACY_ISSUE_RESERVATION_BODY)).toBe(true);
    expect(isLegacyIssueReservationBody(`${LEGACY_ISSUE_RESERVATION_BODY}\n`)).toBe(false);
    expect(isLegacyIssueReservationBody("A normal project issue")).toBe(false);
  });

  it("recognizes only exact six-digit issue reservation markers", () => {
    expect(submissionIdFromIssueBody("ordinary issue")).toBeUndefined();
    expect(submissionIdFromIssueBody("<!-- lax-submission-id:lax-123456 -->\n\nControl")).toBe(
      "lax-123456",
    );
    for (const marker of [
      "<!-- lax-submission-id:lax-012345 -->",
      "<!-- lax-submission-id:lax-12345 -->",
      "<!-- lax-submission-id:lax-1234567 -->",
      "<!-- lax-submission-id:lax-123456 extra -->",
    ]) expect(() => submissionIdFromIssueBody(marker)).toThrow();
  });

  it("scaffolds a six-digit manifest id without touching GitHub", async () => {
    const parent = temp();
    const root = path.join(parent, "submission");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await initializeSubmission(root, "Local theorem");

    const manifest = readLocalSubmissionManifest(root);
    expect(manifest.id).toMatch(/^lax-[1-9][0-9]{5}$/u);
    expect(manifest.issue).toBeUndefined();
    expect(manifest.authors).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks and stores provisional owners without a login", async () => {
    const root = scaffold();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string> | undefined)?.authorization).toBeUndefined();
      return json({ id: 20, login: "Bob", type: "User" });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await replaceOwners(root, ["bob"]);

    expect(readLocalSubmissionManifest(root).initialOwners).toEqual(["Bob"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("warns and defers owner verification when anonymous GitHub lookup is unavailable", async () => {
    const root = scaffold();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await replaceOwners(root, ["bob"]);

    expect(readLocalSubmissionManifest(root).initialOwners).toEqual(["bob"]);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("could not verify GitHub user bob"));
  });

  it("verifies and records the issue binding for an allowlisted legacy submission", async () => {
    const root = scaffold();
    const manifestFilename = path.join(root, "manifest.yaml");
    fs.writeFileSync(
      manifestFilename,
      fs.readFileSync(manifestFilename, "utf8").replace("id: lax-123456", "id: lax-3"),
    );
    const legacyIssue = { repositoryId: CONTROL_REPOSITORY_ID, number: 3 };
    const legacyFiles = initialFiles("lax-3", legacyIssue, alice, "2026-08-01T10:00:00Z");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/repos/lax-archive/lax-database") return json({ default_branch: "main" });
      if (url.pathname === "/repos/lax-archive/lax-database/git/ref/heads/main") {
        return json({ object: { sha: archiveSha } });
      }
      if (url.pathname === `/repos/lax-archive/lax-database/git/commits/${archiveSha}`) {
        return json({ sha: archiveSha, tree: { sha: "root-tree" } });
      }
      if (url.pathname === "/repos/lax-archive/lax-database/git/trees/root-tree") {
        return json({
          truncated: false,
          tree: [{ path: "lax-3", mode: "040000", type: "tree", sha: "submission-tree" }],
        });
      }
      if (url.pathname === "/repos/lax-archive/lax-database/git/trees/submission-tree") {
        return json({
          truncated: false,
          tree: Object.keys(legacyFiles).map((name) => ({
            path: name,
            mode: "100644",
            type: "blob",
            sha: `blob-${name}`,
          })),
        });
      }
      const blobPrefix = "/repos/lax-archive/lax-database/git/blobs/blob-";
      if (url.pathname.startsWith(blobPrefix)) {
        const name = decodeURIComponent(url.pathname.slice(blobPrefix.length));
        return json({
          encoding: "base64",
          content: Buffer.from(legacyFiles[name]!, "utf8").toString("base64"),
        });
      }
      return json({ message: `unhandled ${url.pathname}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      prepareLocalSubmission(root, GitHubClient.forGitHubAppUser("ghu_test")),
    ).resolves.toBe(true);

    expect(readLocalSubmissionManifest(root).issue).toEqual(legacyIssue);
    expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method !== "POST")).toBe(
      true,
    );
  });

  it("creates and records the issue on first update, then synchronizes local owners", async () => {
    const root = scaffold();
    setInitialOwners(root, ["bob"]);
    process.env.LAX_POLL_INTERVAL_MS = "1";
    process.env.LAX_WORKFLOW_TIMEOUT_MS = "1000";
    const files = initialFiles(id, issue, alice, "2026-08-01T10:00:00Z");
    let issueCreated = false;
    let ownerCommand = "";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.pathname === "/user") return json({ id: 10, login: "alice", type: "User" });
      if (url.pathname === "/users/alice") return json({ id: 10, login: "alice", type: "User" });
      if (url.pathname === "/users/bob") {
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer ghu_test");
        return json({ id: 20, login: "bob", type: "User" });
      }
      if (url.pathname === "/repos/lax-archive/lax-database") return json({ default_branch: "main" });
      if (url.pathname === "/repos/lax-archive/lax-database/git/ref/heads/main") {
        return json({ object: { sha: archiveSha } });
      }
      if (url.pathname === `/repos/lax-archive/lax-database/git/commits/${archiveSha}`) {
        return json({ sha: archiveSha, tree: { sha: "root-tree" } });
      }
      if (url.pathname === "/repos/lax-archive/lax-database/git/trees/root-tree") {
        return json({
          truncated: false,
          tree: issueCreated ? [{ path: id, mode: "040000", type: "tree", sha: "submission-tree" }] : [],
        });
      }
      if (url.pathname === "/repos/lax-archive/lax-database/git/trees/submission-tree") {
        return json({
          truncated: false,
          tree: Object.keys(files).map((name) => ({
            path: name,
            mode: "100644",
            type: "blob",
            sha: `blob-${name}`,
          })),
        });
      }
      const blobPrefix = "/repos/lax-archive/lax-database/git/blobs/blob-";
      if (url.pathname.startsWith(blobPrefix)) {
        const name = decodeURIComponent(url.pathname.slice(blobPrefix.length));
        const content = name === "owner-list.json" && ownerCommand !== ""
          ? `${JSON.stringify({
              specVersion: "1",
              owners: [alice, { githubId: 20, handle: "bob" }],
            })}\n`
          : files[name]!;
        return json({ encoding: "base64", content: Buffer.from(content, "utf8").toString("base64") });
      }
      if (url.pathname === "/repos/lax-archive/lax/issues" && method === "POST") {
        issueCreated = true;
        const body = JSON.parse(String(init?.body)) as { body: string };
        expect(submissionIdFromIssueBody(body.body)).toBe(id);
        return json({
          number: 42,
          html_url: "https://github.com/lax-archive/lax/issues/42",
          created_at: "2026-07-30T10:00:00Z",
        }, 201);
      }
      if (url.pathname === "/repos/lax-archive/lax/issues/42/comments" && method === "POST") {
        ownerCommand = (JSON.parse(String(init?.body)) as { body: string }).body;
        return json({
          id: 9001,
          html_url: "https://github.com/lax-archive/lax/issues/42#issuecomment-9001",
          created_at: "2026-07-30T10:01:00Z",
        }, 201);
      }
      if (url.pathname === "/repos/lax-archive/lax/issues/42/comments") {
        return json([{
          id: 8,
          body: "Done\n\n<!-- lax-initialization-issue:42 -->\n<!-- lax-result-status:success -->",
          user: bot(),
        }]);
      }
      if (url.pathname === "/repos/lax-archive/lax/issues/comments/9001/reactions") {
        return json([{ id: 9, content: "+1", user: bot() }]);
      }
      return json({ message: `unhandled ${method} ${url.pathname}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(
      prepareLocalSubmission(root, GitHubClient.forGitHubAppUser("ghu_test")),
    ).resolves.toBe(true);

    const manifest = readLocalSubmissionManifest(root);
    expect(manifest.issue).toEqual(issue);
    expect(manifest.initialOwners).toEqual([]);
    expect(ownerCommand).toContain(`/lax owners ${id}`);
    expect(ownerCommand).toContain('"githubId":10');
    expect(ownerCommand).toContain('"githubId":20');
  });

  it("stops before issue creation when the manifest id and package identity differ", async () => {
    const root = scaffold();
    setManifestId(root, "lax-654321");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      prepareLocalSubmission(root, GitHubClient.forGitHubAppUser("ghu_test")),
    ).rejects.toThrow("does not match the generated package layout");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rekeys before creating an issue when the chosen id already exists", async () => {
    const root = scaffold();
    fs.writeFileSync(
      path.join(root, "proofs", "Lax123456Proofs.lean"),
      "import Lax123456\nnamespace Lax123456Proofs\n",
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/user") return json({ id: 10, login: "alice", type: "User" });
      if (url.pathname === "/users/alice") return json({ id: 10, login: "alice", type: "User" });
      if (url.pathname === "/repos/lax-archive/lax-database") return json({ default_branch: "main" });
      if (url.pathname === "/repos/lax-archive/lax-database/git/ref/heads/main") {
        return json({ object: { sha: archiveSha } });
      }
      if (url.pathname === `/repos/lax-archive/lax-database/git/commits/${archiveSha}`) {
        return json({ sha: archiveSha, tree: { sha: "root-tree" } });
      }
      if (url.pathname === "/repos/lax-archive/lax-database/git/trees/root-tree") {
        return json({ truncated: false, tree: [{ path: id, mode: "040000", type: "tree", sha: "old" }] });
      }
      return json({ message: `unhandled ${url.pathname}` }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      prepareLocalSubmission(root, GitHubClient.forGitHubAppUser("ghu_test")),
    ).resolves.toBe(true);

    const replacement = readLocalSubmissionManifest(root);
    expect(replacement.id).toMatch(/^lax-[1-9][0-9]{5}$/u);
    expect(replacement.id).not.toBe(id);
    expect(replacement.issue).toBeUndefined();
    const packageName = `Lax${replacement.id.slice("lax-".length)}`;
    expect(fs.existsSync(path.join(root, "concepts", `${packageName}.lean`))).toBe(true);
    expect(fs.readFileSync(path.join(root, "proofs", `${packageName}Proofs.lean`), "utf8")).toContain(
      `namespace ${packageName}Proofs`,
    );
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false);
  });
});

function scaffold(): string {
  const root = temp();
  scaffoldSubmission(root, id, "Local theorem");
  return root;
}

function temp(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lax-loginless-init-"));
  temporary.push(directory);
  return directory;
}

function bot(): { id: number; login: string; type: string } {
  return { id: GITHUB_ACTIONS_BOT_ID, login: GITHUB_ACTIONS_BOT_LOGIN, type: "Bot" };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
