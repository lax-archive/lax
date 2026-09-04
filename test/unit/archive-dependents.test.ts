import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArchiveRepository } from "../../src/shared/archive.js";
import { GitHubClient } from "../../src/shared/github.js";
import { parsePublishRequest } from "../../src/shared/publisher.js";
import type { PublishRequest } from "../../src/shared/types.js";

const snapshot = { branch: "main", sha: "a".repeat(40) };
const repositoryId = 123456789;

/**
 * One database tree around the deletion target lax-13. Either required-package
 * list may name either of a submission's packages — a proofs package building
 * on another submission's *concepts* (lax-5 here) is the commonest
 * cross-submission edge there is — so all four combinations are dependents,
 * while a package that merely starts with the target's name (lax-15's Lax130)
 * is not.
 */
const buildOutputs: Record<string, unknown> = {
  "lax-13": { requiredByConcepts: ["mathlib"], requiredByProofs: [] },
  "lax-3": { requiredByConcepts: ["Lax13"], requiredByProofs: [] },
  "lax-5": { requiredByConcepts: ["mathlib"], requiredByProofs: ["Lax13"] },
  "lax-11": { requiredByConcepts: ["Lax13Proofs"], requiredByProofs: [] },
  "lax-12": { requiredByConcepts: [], requiredByProofs: ["Lax13Proofs"] },
  "lax-15": { requiredByConcepts: ["Lax99"], requiredByProofs: ["Lax130"] },
};

describe("Archive dependent scans", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("matches submission ids to the package names stored in build output", async () => {
    stubDatabase();
    const archive = new ArchiveRepository(new GitHubClient("token", "https://api.test"));
    await expect(archive.listDependents("lax-13", snapshot)).resolves.toEqual([
      "lax-3",
      "lax-5",
      "lax-11",
      "lax-12",
    ]);
  });

  it("produces a dependent list the trusted publisher accepts", async () => {
    stubDatabase();
    const archive = new ArchiveRepository(new GitHubClient("token", "https://api.test"));
    // The route job scans the database and the delete request carries the
    // result; parsePublishRequest re-checks it credential-free in the trusted
    // job, and it runs before that job's own error reporting, so an order this
    // scan cannot produce would fail the command with a generic operational
    // failure on every retry.
    const dependents = await archive.listDependents("lax-13", snapshot);
    const request = parsePublishRequest(deleteRequest(dependents), repositoryId);
    expect(request.dependents).toEqual(["lax-3", "lax-5", "lax-11", "lax-12"]);
  });
});

function stubDatabase(): void {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith(`/git/commits/${snapshot.sha}`)) {
      return json({ sha: snapshot.sha, tree: { sha: "root-tree" } });
    }
    if (url.pathname.endsWith("/git/trees/root-tree") && url.searchParams.get("recursive") === "1") {
      return json({
        truncated: false,
        tree: Object.keys(buildOutputs).map((id) => ({
          path: `${id}/build-output.json`,
          mode: "100644",
          type: "blob",
          sha: id,
        })),
      });
    }
    const sha = url.pathname.split("/").pop()!;
    const content = Buffer.from(JSON.stringify(buildOutputs[sha])).toString("base64");
    return json({ encoding: "base64", content });
  }));
}

function deleteRequest(dependents: string[]): PublishRequest {
  return {
    action: "delete",
    id: "lax-13",
    issue: { repositoryId, number: 42 },
    actor: { githubId: 10, handle: "alice" },
    issueNodeId: "I_kwDOexample",
    eventCreatedAt: "2026-07-30T10:00:00Z",
    commentId: 7,
    command: { action: "delete" },
    archiveSha: "b".repeat(40),
    preconditions: { record: "0".repeat(64), buildOutput: "1".repeat(64), ownerList: "2".repeat(64) },
    dependents,
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
