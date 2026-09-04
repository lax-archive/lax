import { afterEach, describe, expect, it, vi } from "vitest";
import { ArchiveRepository } from "../../src/shared/archive.js";
import { initialFiles, registeredFiles } from "../../src/shared/archive-schema.js";
import { ControlPlane } from "../../src/shared/control-plane.js";
import { GitHubClient } from "../../src/shared/github.js";
import {
  issueReservationBody,
  LEGACY_ISSUE_RESERVATION_BODY,
} from "../../src/shared/issue-reservation.js";

const repositoryId = 123456789;
const issueNumber = 42;
const archiveSha = "a".repeat(40);
const alice = { githubId: 10, handle: "alice" };
const files = initialFiles(
  "lax-42",
  { repositoryId, number: issueNumber },
  alice,
  "2026-07-30T10:00:00Z",
);

afterEach(() => vi.unstubAllGlobals());

describe("submission control-plane routing", () => {
  it("ignores ordinary comments without touching GitHub or lax-database", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const control = controlPlane();
    await expect(control.route("issue_comment", commentEvent("looks good", alice))).resolves.toEqual({
      kind: "ignore",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("authorizes and routes validated submit requests", async () => {
    const fetchMock = installArchiveFetch();
    const control = controlPlane();
    const result = await control.route(
      "issue_comment",
      commentEvent(
        `/lax submit ${JSON.stringify({
          repository: "https://github.com/alice/formalization",
          commit: "0123456789abcdef0123456789abcdef01234567",
          folder: ".",
        })}`,
        alice,
      ),
    );
    expect(result.kind).toBe("validate");
    if (result.kind !== "validate") throw new Error("unexpected route result");
    expect(result.request.id).toBe("lax-42");
    expect(result.request.command).toMatchObject({ action: "submit", folder: "." });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/users/alice"))).toBe(true);
    expect(fetchMock.mock.calls.every(([url, init]) => (init as RequestInit | undefined)?.method !== "PATCH")).toBe(
      true,
    );
  });

  it("routes a current command through the id reserved in its issue marker", async () => {
    const currentId = "lax-123456";
    const currentFiles = initialFiles(
      currentId,
      { repositoryId, number: issueNumber },
      alice,
      "2026-07-30T10:00:00Z",
    );
    installArchiveFetch(alice, currentFiles, {
      issueBody: issueReservationBody(currentId),
      submissionId: currentId,
    });
    const result = await controlPlane().route(
      "issue_comment",
      commentEvent(
        `/lax submit ${currentId} ${JSON.stringify({
          repository: "https://github.com/alice/formalization",
          commit: "0123456789abcdef0123456789abcdef01234567",
          folder: ".",
        })}`,
        alice,
      ),
    );
    expect(result).toMatchObject({
      kind: "validate",
      request: { id: currentId, command: { action: "submit", folder: "." } },
    });
    if (result.kind !== "validate") throw new Error("unexpected route result");
    expect(result.request.legacyManifestWithoutIssue).toBeUndefined();
  });

  it("applies the owner gate before parsing command arguments", async () => {
    installArchiveFetch({ githubId: 20, handle: "bob" });
    const control = controlPlane();
    await expect(
      control.route("issue_comment", commentEvent("/lax submit definitely-not-json", {
        githubId: 20,
        handle: "bob",
      })),
    ).rejects.toThrow("bob is not an owner");
  });

  it("keeps owners result-only while registration gets one preview", async () => {
    installArchiveFetch();
    const owners = await controlPlane().route(
      "issue_comment",
      commentEvent('/lax owners [{"githubId":10,"handle":"alice"}]', alice),
    );
    expect(owners.kind).toBe("publish");
    if (owners.kind !== "publish") throw new Error("unexpected result");
    expect(owners.preview).toBeUndefined();

    installArchiveFetch();
    const registration = await controlPlane().route(
      "issue_comment",
      commentEvent("/lax register", alice),
    );
    expect(registration.kind).toBe("publish");
    if (registration.kind !== "publish") throw new Error("unexpected result");
    expect(registration.preview).toContain("Registration preview");
    expect(registration.preview).toContain("lax-preview-comment-id:9001");
  });

  it("constructs and schema-checks initialization stubs in the route job", async () => {
    installCreateFetch({ body: issueReservationBody("lax-123456") });
    const result = await controlPlane().route("issues", {
      action: "opened",
      repository: { id: repositoryId, full_name: "lax-archive/lax" },
      issue: {
        number: issueNumber,
        node_id: "I_kwDOexample",
        created_at: "2026-07-30T10:00:00Z",
        user: { id: 10, login: "alice", type: "User" },
      },
    });
    expect(result.kind).toBe("publish");
    if (result.kind !== "publish") throw new Error("unexpected result");
    expect(result.request.action).toBe("create");
    expect(result.request.id).toBe("lax-123456");
    expect(result.preview).toContain("lax-initialization-preview-issue:42");
    expect(Object.keys(result.request.initialFiles ?? {}).sort()).toEqual([
      "build-output.json",
      "owner-list.json",
      "record.json",
    ]);
    expect(result.request.initialFiles?.["owner-list.json"]).toContain('"githubId": 10');
  });

  it("ignores ordinary project issues before constructing archive state", async () => {
    const fetchMock = installCreateFetch({ body: "A normal project issue." });
    await expect(
      controlPlane().route("issues", {
        action: "opened",
        repository: { id: repositoryId, full_name: "lax-archive/lax" },
        issue: { number: issueNumber },
      }),
    ).resolves.toEqual({ kind: "ignore" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores commands on ordinary project issues before reading archive state", async () => {
    const fetchMock = installArchiveFetch(alice, files, { issueBody: "A normal project issue." });
    await expect(
      controlPlane().route("issue_comment", commentEvent("/lax register", alice)),
    ).resolves.toEqual({ kind: "ignore" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requires current commands to match the id reserved in the issue marker", async () => {
    installArchiveFetch(alice, files, { issueBody: issueReservationBody("lax-123456") });
    await expect(
      controlPlane().route("issue_comment", commentEvent("/lax register lax-654321", alice)),
    ).rejects.toThrow("does not match the submission id reserved by this issue");
  });

  it("still finds the reserved id after a browser edit rewrites the body with CRLF", async () => {
    // GitHub's web editor saves the body it submits with CRLF endings, so this
    // is the issue an author leaves behind by opening the control issue in a
    // browser and pressing "Update comment". Both entry points have to keep
    // reading the marker: the issue is the submission's only control plane.
    const webEdited = (body: string): string => body.replace(/\n/gu, "\r\n");
    const currentId = "lax-123456";
    installCreateFetch({ body: webEdited(issueReservationBody(currentId)) });
    await expect(
      controlPlane().route("issues", {
        action: "opened",
        repository: { id: repositoryId, full_name: "lax-archive/lax" },
        issue: {
          number: issueNumber,
          node_id: "I_kwDOexample",
          created_at: "2026-07-30T10:00:00Z",
          user: { id: 10, login: "alice", type: "User" },
        },
      }),
    ).resolves.toMatchObject({ kind: "publish", request: { action: "create", id: currentId } });

    installArchiveFetch(
      alice,
      initialFiles(currentId, { repositoryId, number: issueNumber }, alice, "2026-07-30T10:00:00Z"),
      { issueBody: webEdited(issueReservationBody(currentId)), submissionId: currentId },
    );
    await expect(
      controlPlane().route("issue_comment", commentEvent(`/lax register ${currentId}`, alice)),
    ).resolves.toMatchObject({ kind: "publish" });
  });

  it("rejects a reservation marker that only a second line completes", async () => {
    // Ending the marker line at a CR must not turn the rest of the body into
    // part of the marker: the id is what stands complete on the first line.
    installCreateFetch({ body: "<!-- lax-submission-id:lax-1\r\n23456 -->\r\n" });
    await expect(
      controlPlane().route("issues", {
        action: "opened",
        repository: { id: repositoryId, full_name: "lax-archive/lax" },
        issue: {
          number: issueNumber,
          node_id: "I_kwDOexample",
          created_at: "2026-07-30T10:00:00Z",
          user: { id: 10, login: "alice", type: "User" },
        },
      }),
    ).rejects.toThrow("malformed reservation marker");
  });

  it("aggregates independent initialization event and current-issue errors", async () => {
    const fetchMock = installCreateFetch({
      state: "closed",
      pull_request: {},
      title: `${"x".repeat(513)}\n\u200B`,
      node_id: "!",
      created_at: "2026-02-30T10:00:00Z",
      user: { id: 0, login: "-bad", type: "Bot" },
    });
    try {
      await controlPlane().route("issues", {
        action: "edited",
        repository: { id: repositoryId, full_name: "lax-archive/lax" },
        issue: {
          number: issueNumber,
          node_id: "!",
          created_at: "2026-02-30T10:00:00Z",
          user: { id: 0, login: "-bad", type: "Bot" },
        },
      });
      throw new Error("expected validation to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("action must be opened");
      expect(message).toContain("requires an open issue");
      expect(message).toContain("not a pull request");
      expect(message).toContain("must be a human GitHub user");
      expect(message).toContain("title exceeds 512 UTF-8 bytes");
      expect(message).toContain("issue node id is invalid");
      expect(message).toContain("timestamp must be canonical UTC");
    }
    expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method === "GET")).toBe(true);
  });

  it("continues the independent initialization existence check after title errors", async () => {
    installCreateFetch({ title: "bad\n title" }, true);
    await expect(
      controlPlane().route("issues", {
        action: "opened",
        repository: { id: repositoryId, full_name: "lax-archive/lax" },
        issue: { number: issueNumber },
      }),
    ).rejects.toSatisfy((error: Error) =>
      error.message.includes("title must be one line") &&
      error.message.includes("already exists in lax-database"),
    );
  });

  it("trusts replay markers only when GitHub Actions authored them", async () => {
    const marker = "<!-- lax-result-comment-id:9001 -->";
    installArchiveFetch(alice, files, {
      comments: [{
        id: 1,
        body: marker,
        user: { id: alice.githubId, login: alice.handle, type: "User" },
      }],
    });
    await expect(
      controlPlane().route("issue_comment", commentEvent("/lax register", alice)),
    ).resolves.toMatchObject({ kind: "publish" });

    installArchiveFetch(alice, files, {
      comments: [{
        id: 2,
        body: marker,
        user: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
      }],
    });
    await expect(
      controlPlane().route("issue_comment", commentEvent("/lax register", alice)),
    ).resolves.toEqual({ kind: "ignore" });
  });

  it("replaces workflow context and transitions the bot rocket to thumbs-up", async () => {
    let body = "/lax submit {}";
    let nextReactionId = 2;
    const reactions = [{
      id: 1,
      content: "rocket",
      user: { id: 10, login: "alice", type: "User" },
    }];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const reactionPath = "/repos/lax-archive/lax/issues/comments/9001/reactions";
      if (url.pathname === reactionPath) {
        if (init?.method === "POST") {
          const content = String((JSON.parse(String(init.body)) as { content: string }).content);
          const reaction = {
            id: nextReactionId++,
            content,
            user: { id: 41_898_282, login: "github-actions[bot]", type: "Bot" },
          };
          reactions.push(reaction);
          return json(reaction, 201);
        }
        return json(reactions);
      }
      if (url.pathname.startsWith(`${reactionPath}/`) && init?.method === "DELETE") {
        const reactionId = Number(url.pathname.slice(reactionPath.length + 1));
        const index = reactions.findIndex((reaction) => reaction.id === reactionId);
        if (index !== -1) reactions.splice(index, 1);
        return new Response(undefined, { status: 204 });
      }
      if (!url.pathname.endsWith("/issues/comments/9001")) {
        return json({ message: `unhandled ${url.pathname}` }, 500);
      }
      if (init?.method === "PATCH") {
        body = String((JSON.parse(String(init.body)) as { body: string }).body);
        return json({ id: 9001, body, user: { id: 10, login: "alice", type: "User" } });
      }
      return json({ id: 9001, body, user: { id: 10, login: "alice", type: "User" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const control = controlPlane();

    await control.annotateIssueComment(9001, "Update preview.\n\n<!-- lax-workflow-run-id:123 -->");
    await control.annotateIssueComment(9001, "Update preview changed.\n\n<!-- lax-workflow-run-id:456 -->");
    await control.markCommandStarted(9001);

    expect(body).toContain("/lax submit {}");
    expect(body).toContain("Update preview changed.");
    expect(body).not.toContain("lax-workflow-run-id:123");
    expect(body.match(/lax-command-context:9001:start/gu)).toHaveLength(1);
    await expect(control.successReactionExists(9001)).resolves.toBe(false);
    await control.completeCommand(9001);
    await expect(control.successReactionExists(9001)).resolves.toBe(true);
    expect(reactions).toEqual([
      { id: 1, content: "rocket", user: { id: 10, login: "alice", type: "User" } },
      {
        id: 3,
        content: "+1",
        user: { id: 41_898_282, login: "github-actions[bot]", type: "Bot" },
      },
    ]);
  });

  it("rejects executable Archive payloads", async () => {
    installArchiveFetch(alice, files, { fileMode: "100755" });
    await expect(
      controlPlane().route("issue_comment", commentEvent("/lax register", alice)),
    ).rejects.toThrow("non-executable regular Archive files");
  });

  it("aggregates independent binding, ownership and state gate errors before command parsing", async () => {
    const badFiles = registeredFiles(
      "lax-42",
      initialFiles(
        "lax-42",
        { repositoryId: 999, number: 99 },
        { githubId: 20, handle: "bob" },
        "2026-07-30T10:00:00Z",
      ),
    );
    const fetchMock = installArchiveFetch(alice, badFiles);
    try {
      await controlPlane().route("issue_comment", commentEvent("/lax register", alice));
      throw new Error("expected validation to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("is not bound to this lax issue");
      expect(message).toContain("alice is not an owner");
      expect(message).toContain("is registered and cannot be changed");
    }
    expect(
      fetchMock.mock.calls.every(([, init]) => !["POST", "PATCH", "PUT", "DELETE"].includes(String((init as RequestInit | undefined)?.method))),
    ).toBe(true);
  });

  it("aggregates submit argument errors without reaching a mutation", async () => {
    const fetchMock = installArchiveFetch();
    await expect(
      controlPlane().route(
        "issue_comment",
        commentEvent(
          '/lax submit {"repository":"http://example.com/x","commit":"BAD","folder":"../x","extra":true}',
          alice,
        ),
      ),
    ).rejects.toThrow("must contain exactly");
    try {
      await controlPlane().route(
        "issue_comment",
        commentEvent(
          '/lax submit {"repository":"http://example.com/x","commit":"BAD","folder":"../x","extra":true}',
          alice,
        ),
      );
    } catch (error) {
      expect((error as Error).message).toContain("lowercase 40-character SHA");
      expect((error as Error).message).toContain("without . or ..");
    }
    expect(fetchMock.mock.calls.some(([, init]) => ["POST", "PATCH"].includes(String((init as RequestInit | undefined)?.method)))).toBe(false);
  });
});

function controlPlane(): ControlPlane {
  const github = new GitHubClient("test-token");
  return new ControlPlane(github, new ArchiveRepository(github), repositoryId);
}

function commentEvent(body: string, actor: { githubId: number; handle: string }): unknown {
  return {
    action: "created",
    repository: { id: repositoryId, full_name: "lax-archive/lax" },
    issue: { number: issueNumber, state: "open", node_id: "I_kwDOexample" },
    comment: {
      id: 9001,
      body,
      created_at: "2026-07-30T11:00:00Z",
      user: { id: actor.githubId, login: actor.handle, type: "User" },
    },
  };
}

function installArchiveFetch(
  actor = alice,
  archiveFiles: Record<string, string> = files,
  options: {
    comments?: unknown[];
    fileMode?: string;
    issueBody?: string;
    submissionId?: string;
  } = {},
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/repos/lax-archive/lax/issues/42") {
      return json({
        number: 42,
        node_id: "I_kwDOexample",
        state: "open",
        title: "Example",
        body: options.issueBody ?? LEGACY_ISSUE_RESERVATION_BODY,
        created_at: "2026-07-30T10:00:00Z",
        user: { id: 10, login: "alice", type: "User" },
      });
    }
    if (path === "/repos/lax-archive/lax/issues/42/comments") return json(options.comments ?? []);
    if (path === "/repos/lax-archive/lax-database") return json({ default_branch: "main" });
    if (path === "/repos/lax-archive/lax-database/git/ref/heads/main") {
      return json({ object: { sha: archiveSha } });
    }
    if (path === `/repos/lax-archive/lax-database/git/commits/${archiveSha}`) {
      return json({ sha: archiveSha, tree: { sha: "root-tree" } });
    }
    if (path === "/repos/lax-archive/lax-database/git/trees/root-tree") {
      if (url.searchParams.get("recursive") === "1") return json({ truncated: false, tree: [] });
      return json({
        truncated: false,
        tree: [{
          path: options.submissionId ?? "lax-42",
          mode: "040000",
          type: "tree",
          sha: "submission-tree",
        }],
      });
    }
    if (path === "/repos/lax-archive/lax-database/git/trees/submission-tree") {
      return json({
        truncated: false,
        tree: Object.keys(archiveFiles).map((name) => ({
          path: name,
          mode: options.fileMode ?? "100644",
          type: "blob",
          sha: `blob-${name}`,
        })),
      });
    }
    const blobPrefix = "/repos/lax-archive/lax-database/git/blobs/blob-";
    if (path.startsWith(blobPrefix)) {
      const name = decodeURIComponent(path.slice(blobPrefix.length));
      return json({
        encoding: "base64",
        content: Buffer.from(archiveFiles[name]!, "utf8").toString("base64"),
      });
    }
    if (path === `/users/${actor.handle}`) {
      return json({ id: actor.githubId, login: actor.handle, type: "User" });
    }
    return json({ message: `unhandled ${path}` }, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function installCreateFetch(
  issueOverrides: Record<string, unknown> = {},
  existing = false,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/repos/lax-archive/lax/issues/42") {
      return json({
        number: 42,
        node_id: "I_kwDOexample",
        state: "open",
        title: "Example",
        body: LEGACY_ISSUE_RESERVATION_BODY,
        created_at: "2026-07-30T10:00:00Z",
        user: { id: 10, login: "alice", type: "User" },
        ...issueOverrides,
      });
    }
    if (path === "/users/alice") return json({ id: 10, login: "alice", type: "User" });
    if (path === "/repos/lax-archive/lax-database") return json({ default_branch: "main" });
    if (path === "/repos/lax-archive/lax-database/git/ref/heads/main") {
      return json({ object: { sha: archiveSha } });
    }
    if (path === `/repos/lax-archive/lax-database/git/commits/${archiveSha}`) {
      return json({ sha: archiveSha, tree: { sha: "root-tree" } });
    }
    if (path === "/repos/lax-archive/lax-database/git/trees/root-tree") {
      return json({
        truncated: false,
        tree: existing
          ? [{ path: "lax-42", mode: "040000", type: "tree", sha: "submission-tree" }]
          : [],
      });
    }
    return json({ message: `unhandled ${path}` }, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
