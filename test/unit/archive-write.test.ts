import { afterEach, describe, expect, it, vi } from "vitest";
import { ArchiveRepository } from "../../src/shared/archive.js";
import { GitHubClient } from "../../src/shared/github.js";
import { initialFiles } from "../../src/shared/archive-schema.js";

const baseSha = "a".repeat(40);
const commitSha = "c".repeat(40);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("protected Archive publication", () => {
  it("stages a candidate, waits for the guard, advances without force, and removes the staging ref", async () => {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    let updateAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      requests.push({ method, path: url.pathname, body });

      if (method === "GET" && url.pathname === "/repos/example/database") {
        return json({ default_branch: "main" });
      }
      if (method === "GET" && url.pathname === "/repos/example/database/git/ref/heads/main") {
        return json({ object: { sha: baseSha } });
      }
      if (method === "GET" && url.pathname === `/repos/example/database/git/commits/${baseSha}`) {
        return json({ sha: baseSha, tree: { sha: "root-tree" } });
      }
      if (method === "GET" && url.pathname === "/repos/example/database/git/trees/root-tree") {
        return json({ truncated: false, tree: [] });
      }
      if (method === "POST" && url.pathname === "/repos/example/database/git/blobs") {
        return json({ sha: `blob-${requests.length}` });
      }
      if (method === "POST" && url.pathname === "/repos/example/database/git/trees") {
        return json({ sha: "new-tree" });
      }
      if (method === "POST" && url.pathname === "/repos/example/database/git/commits") {
        return json({ sha: commitSha });
      }
      if (method === "POST" && url.pathname === "/repos/example/database/git/refs") {
        return json({ ref: `refs/heads/lax-publish/${commitSha}` }, 201);
      }
      if (method === "PATCH" && url.pathname === "/repos/example/database/git/refs/heads/main") {
        updateAttempts += 1;
        if (updateAttempts === 1) return json({ message: "Required status check is expected" }, 422);
        return json({ ref: "refs/heads/main" });
      }
      if (
        method === "DELETE" &&
        url.pathname === `/repos/example/database/git/refs/heads/lax-publish%2F${commitSha}`
      ) {
        return new Response(null, { status: 204 });
      }
      return json({ message: `unhandled ${method} ${url.pathname}` }, 500);
    }));

    const repository = new ArchiveRepository(
      new GitHubClient("test-token", "https://api.example.test"),
      "example/database",
      { attempts: 2, intervalMs: 0 },
    );
    const files = initialFiles(
      "lax-42",
      { repositoryId: 123, number: 42 },
      { githubId: 10, handle: "alice" },
      "2026-08-02T12:00:00Z",
    );
    const result = await repository.writeFiles({
      id: "lax-42",
      changes: files,
      message: "Initialize lax-42",
      validateCurrent: (current) => expect(current).toBeUndefined(),
    });

    expect(result).toBe(commitSha);
    expect(updateAttempts).toBe(2);
    expect(requests).toContainEqual({
      method: "POST",
      path: "/repos/example/database/git/refs",
      body: { ref: `refs/heads/lax-publish/${commitSha}`, sha: commitSha },
    });
    expect(requests.filter((request) => request.method === "PATCH")).toEqual([
      {
        method: "PATCH",
        path: "/repos/example/database/git/refs/heads/main",
        body: { sha: commitSha, force: false },
      },
      {
        method: "PATCH",
        path: "/repos/example/database/git/refs/heads/main",
        body: { sha: commitSha, force: false },
      },
    ]);
    expect(requests.some((request) => request.method === "DELETE")).toBe(true);
  });

  it("rebases and revalidates after an unrelated publisher advances the branch", async () => {
    const advancedSha = "b".repeat(40);
    const firstCandidate = "c".repeat(40);
    const secondCandidate = "d".repeat(40);
    const candidates = [firstCandidate, secondCandidate];
    const commitParents: string[][] = [];
    let branchSha = baseSha;
    let commitIndex = 0;

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));

      if (method === "GET" && url.pathname === "/repos/example/database") {
        return json({ default_branch: "main" });
      }
      if (method === "GET" && url.pathname === "/repos/example/database/git/ref/heads/main") {
        return json({ object: { sha: branchSha } });
      }
      if (method === "GET" && url.pathname.startsWith("/repos/example/database/git/commits/")) {
        const sha = url.pathname.split("/").at(-1)!;
        return json({ sha, tree: { sha: `root-${sha}` } });
      }
      if (method === "GET" && url.pathname.startsWith("/repos/example/database/git/trees/root-")) {
        return json({ truncated: false, tree: [] });
      }
      if (method === "POST" && url.pathname === "/repos/example/database/git/blobs") {
        return json({ sha: `blob-${commitIndex}` });
      }
      if (method === "POST" && url.pathname === "/repos/example/database/git/trees") {
        return json({ sha: `tree-${commitIndex}` });
      }
      if (method === "POST" && url.pathname === "/repos/example/database/git/commits") {
        commitParents.push(body.parents);
        const sha = candidates[commitIndex]!;
        commitIndex += 1;
        return json({ sha });
      }
      if (method === "POST" && url.pathname === "/repos/example/database/git/refs") {
        return json({ ref: body.ref }, 201);
      }
      if (method === "PATCH" && url.pathname === "/repos/example/database/git/refs/heads/main") {
        if (body.sha === firstCandidate) {
          branchSha = advancedSha;
          return json({ message: "Reference update conflict" }, 422);
        }
        branchSha = body.sha;
        return json({ ref: "refs/heads/main" });
      }
      if (method === "DELETE" && url.pathname.startsWith("/repos/example/database/git/refs/heads/")) {
        return new Response(null, { status: 204 });
      }
      return json({ message: `unhandled ${method} ${url.pathname}` }, 500);
    }));

    const repository = new ArchiveRepository(
      new GitHubClient("test-token", "https://api.example.test"),
      "example/database",
      { attempts: 1, intervalMs: 0, conflictAttempts: 2, conflictIntervalMs: 0 },
    );
    const validateCurrent = vi.fn((current) => expect(current).toBeUndefined());
    const files = initialFiles(
      "lax-42",
      { repositoryId: 123, number: 42 },
      { githubId: 10, handle: "alice" },
      "2026-08-02T12:00:00Z",
    );

    await expect(repository.writeFiles({
      id: "lax-42",
      changes: files,
      message: "Initialize lax-42",
      validateCurrent,
    })).resolves.toBe(secondCandidate);

    expect(validateCurrent).toHaveBeenCalledTimes(2);
    expect(commitParents).toEqual([[baseSha], [advancedSha]]);
    expect(branchSha).toBe(secondCandidate);
  });
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
