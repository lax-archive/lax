import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArchiveRepository } from "../../src/shared/archive.js";
import { GitHubClient } from "../../src/shared/github.js";

describe("Archive dependent scans", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("matches submission ids to the package names stored in build output", async () => {
    const snapshot = { branch: "main", sha: "a".repeat(40) };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith(`/git/commits/${snapshot.sha}`)) {
        return json({ sha: snapshot.sha, tree: { sha: "root-tree" } });
      }
      if (url.pathname.endsWith("/git/trees/root-tree") && url.searchParams.get("recursive") === "1") {
        return json({
          truncated: false,
          tree: [
            { path: "lax-13/build-output.json", mode: "100644", type: "blob", sha: "source" },
            { path: "lax-3/build-output.json", mode: "100644", type: "blob", sha: "concept-dependent" },
            { path: "lax-11/build-output.json", mode: "100644", type: "blob", sha: "proof-dependent" },
            { path: "lax-15/build-output.json", mode: "100644", type: "blob", sha: "unrelated" },
          ],
        });
      }
      const sha = url.pathname.split("/").pop();
      const output = sha === "concept-dependent"
        ? { requiredByConcepts: ["Lax13"], requiredByProofs: [] }
        : sha === "proof-dependent"
          ? { requiredByConcepts: [], requiredByProofs: ["Lax13Proofs"] }
          : { requiredByConcepts: ["Lax99"], requiredByProofs: [] };
      return json({ encoding: "base64", content: Buffer.from(JSON.stringify(output)).toString("base64") });
    }));

    const archive = new ArchiveRepository(new GitHubClient("token", "https://api.test"));
    await expect(archive.listDependents("lax-13", snapshot)).resolves.toEqual(["lax-11", "lax-3"]);
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
