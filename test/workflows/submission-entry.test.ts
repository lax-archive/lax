// Behavioral tests for the workflow TS entry points in
// src/workflows/submission.ts — the logic that stage 4 moved out of YAML.
// Each test drives the real exported mode function against a fake-fetch
// GitHub, exactly as `node dist/workflows/submission.js <mode>` would run it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileDigests, initialFiles } from "../../src/shared/archive-schema.js";
import type { PublishRequest } from "../../src/shared/types.js";
import {
  initializationMarker,
  parseWorkflowComment,
  resultMarker,
  workflowRunMarker,
} from "../../src/shared/workflow-comments.js";
import {
  prepareSubmit,
  publish,
  reportFailure,
  reportValidation,
  website,
} from "../../src/workflows/submission.js";
import { successfulArtifacts, TEST_RUNTIME, TEST_SOURCE } from "../support/validation-artifacts.js";

// The suite-wide fake-mathlib seam makes the real pins module carry a
// non-GitHub mathlib URL, which the artifact schema rightly rejects; pin the
// runtime identity to the valid test fixture instead. Only prepare-submit
// consults it, and only for the equality check against the report.
vi.mock("../../src/submission-validation/config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/submission-validation/config.js")>();
  const { TEST_RUNTIME: runtime } = await import("../support/validation-artifacts.js");
  return { ...original, configuredRuntime: () => runtime };
});

const repositoryId = 123456789;
const issueNumber = 42;
const commentId = 9001;
const archiveSha = "a".repeat(40);
const alice = { githubId: 10, handle: "alice" };
const bot = { id: 41_898_282, login: "github-actions[bot]", type: "Bot" };
const workDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const directory of workDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string;
  body: string;
}

interface IssueState {
  comments: Array<{ id: number; body: string; user: typeof bot | { id: number; login: string; type: string } }>;
  reactions: Array<{ id: number; content: string; user: typeof bot }>;
}

describe("report-failure entry point", () => {
  it("keeps the correlation markers byte-compatible with the retired inline reporter", () => {
    // src/cli/follow.ts and the idempotence scans match on exactly these
    // bytes; the deleted actions/github-script body emitted the same ones.
    expect(resultMarker(commentId)).toBe("<!-- lax-result-comment-id:9001 -->");
    expect(initializationMarker(issueNumber)).toBe("<!-- lax-initialization-issue:42 -->");
    expect(workflowRunMarker("777")).toBe("<!-- lax-workflow-run-id:777 -->");
  });

  it("posts one correlated failure, clears the rocket, and stays idempotent on re-runs", async () => {
    stubWorkflowEnv({ ACTION: "submit", OPERATION: "validate", VALIDATION_RESULT: "true" });
    writeEvent({ issue: { number: issueNumber }, comment: { id: commentId } });
    const state: IssueState = {
      comments: [],
      reactions: [{ id: 5, content: "rocket", user: bot }],
    };
    const requests = installIssueFetch(state);

    await reportFailure();
    expect(state.reactions).toHaveLength(0);
    expect(state.comments).toHaveLength(1);
    const body = state.comments[0]!.body;
    expect(body).toContain(
      "Validation succeeded, but trusted submit publication did not complete; no lax-database commit was created.",
    );
    expect(body).toContain(resultMarker(commentId));
    // The CLI's follow loop must keep correlating the comment to its run.
    expect(parseWorkflowComment(body)).toMatchObject({
      resultCommentId: commentId,
      runId: "777",
      runUrl: "https://github.com/lax-archive/lax/actions/runs/777",
    });

    await reportFailure();
    expect(state.comments).toHaveLength(1);
    expect(requests.filter((request) => request.method === "POST" && request.url.endsWith("/comments"))).toHaveLength(1);
  });

  it("does not suppress a report because an earlier run already reported this comment", async () => {
    stubWorkflowEnv({ ACTION: "submit", OPERATION: "validate" });
    writeEvent({ issue: { number: issueNumber }, comment: { id: commentId } });
    const state: IssueState = {
      comments: [{
        id: 1,
        body: `earlier failure\n\n${resultMarker(commentId)}\n${workflowRunMarker("123")}`,
        user: bot,
      }],
      reactions: [],
    };
    installIssueFetch(state);
    await reportFailure();
    expect(state.comments).toHaveLength(2);
    expect(state.comments[1]!.body).toContain(workflowRunMarker("777"));
  });

  it("reports initialization failures with the issue marker and touches no reactions", async () => {
    stubWorkflowEnv({});
    writeEvent({ issue: { number: issueNumber } });
    const state: IssueState = { comments: [], reactions: [{ id: 5, content: "rocket", user: bot }] };
    const requests = installIssueFetch(state);
    await reportFailure();
    expect(state.comments).toHaveLength(1);
    expect(state.comments[0]!.body).toContain(
      "The workflow failed before publication completed; no lax-database commit was created by this run.",
    );
    expect(state.comments[0]!.body).toContain(initializationMarker(issueNumber));
    expect(requests.some((request) => request.url.includes("/reactions"))).toBe(false);
    expect(state.reactions).toHaveLength(1);
  });

  it("warns about a committed database change when a later job failed", async () => {
    const commit = "e".repeat(40);
    stubWorkflowEnv({ ARCHIVE_COMMIT: commit, ACTION: "register", OPERATION: "publish" });
    writeEvent({ issue: { number: issueNumber }, comment: { id: commentId } });
    const state: IssueState = { comments: [], reactions: [] };
    installIssueFetch(state);
    await reportFailure();
    expect(state.comments[0]!.body).toContain(
      `lax-database changed at commit \`${commit}\`, but Website dispatch or final reporting did not complete.`,
    );
  });

  it("does nothing at all without an issue number", async () => {
    stubWorkflowEnv({});
    writeEvent({ pull_request: { number: 3 } });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await reportFailure();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("report-validation entry point", () => {
  it("posts the infrastructure-failure result once and is idempotent afterwards", async () => {
    stubWorkflowEnv({
      VALIDATION_CONTEXT: encode({ id: "lax-42", issueNumber, commentId }),
    });
    const state: IssueState = {
      comments: [],
      reactions: [{ id: 5, content: "rocket", user: bot }],
    };
    installIssueFetch(state);

    await reportValidation();
    expect(state.reactions).toHaveLength(0);
    expect(state.comments).toHaveLength(1);
    const body = state.comments[0]!.body;
    expect(body).toContain("Validation infrastructure failed for **lax-42**");
    expect(body).toContain(resultMarker(commentId));
    expect(parseWorkflowComment(body)).toMatchObject({ resultCommentId: commentId, runId: "777" });

    await reportValidation();
    expect(state.comments).toHaveLength(1);
  });
});

describe("prepare-submit entry point", () => {
  it("revalidates artifacts and fresh state credential-free", async () => {
    const texts = initialFiles("lax-42", { repositoryId, number: issueNumber }, alice, "2026-07-30T10:00:00Z");
    const directory = workDirectory();
    const captureBytes = Buffer.from("lax capture fixture bytes");
    const artifacts = successfulArtifacts();
    const digest = createHash("sha256").update(captureBytes).digest("hex");
    artifacts.report.capture.digest = digest;
    artifacts.report.buildOutput.capture.digest = digest;
    artifacts.buildOutput.capture.digest = digest;
    fs.writeFileSync(path.join(directory, "validation-report.json"), JSON.stringify(artifacts.report));
    fs.writeFileSync(path.join(directory, "generated-build-output.json"), JSON.stringify(artifacts.buildOutput));
    fs.writeFileSync(path.join(directory, "capture.tar"), captureBytes);
    const outputFile = path.join(directory, "github-output");
    const canary = "ghs_canary_token_that_must_never_be_read";
    stubWorkflowEnv({
      GITHUB_OUTPUT: outputFile,
      PUBLISH_REQUEST: encode(submitRequest(fileDigests(texts))),
      VALIDATION_REPORT_PATH: path.join(directory, "validation-report.json"),
      GENERATED_BUILD_OUTPUT_PATH: path.join(directory, "generated-build-output.json"),
      VALIDATION_CAPTURE_PATH: path.join(directory, "capture.tar"),
      // Env-poisoning canary: the preflight job holds no database credential;
      // if this value ever leaves the process something read the wrong env.
      LAX_DATABASE_TOKEN: canary,
    });
    const requests = installIssueFetch({ comments: [], reactions: [] }, texts);

    await prepareSubmit();

    expect(fs.readFileSync(outputFile, "utf8")).toMatch(/should_publish<<[^\n]+\ntrue\n/u);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.authorization).toBe("Bearer workflow-token");
      expect(`${request.url} ${request.body}`).not.toContain(canary);
    }
  });
});

describe("publish and website entry points", () => {
  it("publishes with exactly the two env-provided tokens and mints nothing", async () => {
    const texts = initialFiles("lax-42", { repositoryId, number: issueNumber }, alice, "2026-07-30T10:00:00Z");
    const directory = workDirectory();
    const outputFile = path.join(directory, "github-output");
    stubWorkflowEnv({
      GITHUB_OUTPUT: outputFile,
      LAX_DATABASE_TOKEN: "database-token",
      PUBLISH_REQUEST: encode(registerRequest(fileDigests(texts))),
    });
    const requests = installIssueFetch({ comments: [], reactions: [] }, texts, { allowWrites: true });

    await publish();

    expect(fs.readFileSync(outputFile, "utf8")).toContain("archive_commit");
    for (const request of requests) {
      // Control-repository reads/writes use the workflow token; every
      // lax-database request uses the App token the environment provided.
      const expected = request.url.includes("/repos/lax-archive/lax-database")
        ? "Bearer database-token"
        : "Bearer workflow-token";
      expect(request.authorization, `${request.method} ${request.url}`).toBe(expected);
      // The TS never mints tokens: that is exclusively the pinned
      // create-github-app-token action's job in YAML.
      expect(request.url).not.toMatch(/\/app\/|access_tokens|installation/u);
    }
    const writes = requests.filter((request) => request.method !== "GET");
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((request) => request.url.includes("/repos/lax-archive/lax-database"))).toBe(true);
  });

  it("dispatches the website rebuild with only the given dispatch token", async () => {
    const texts = initialFiles("lax-42", { repositoryId, number: issueNumber }, alice, "2026-07-30T10:00:00Z");
    stubWorkflowEnv({
      LAX_WEBSITE_TOKEN: "website-token",
      PUBLISH_REQUEST: encode(registerRequest(fileDigests(texts))),
      ARCHIVE_COMMIT: "c".repeat(40),
    });
    const requests = installIssueFetch({ comments: [], reactions: [] }, texts, { allowWrites: true });

    await website();

    const dispatches = requests.filter((request) => request.url.includes("/repos/lax-archive/lax-website/dispatches"));
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.method).toBe("POST");
    expect(dispatches[0]!.authorization).toBe("Bearer website-token");
    expect(JSON.parse(dispatches[0]!.body)).toMatchObject({
      event_type: "lax-db-updated",
      client_payload: { archiveCommit: "c".repeat(40), submissionId: "lax-42", action: "register" },
    });
    for (const request of requests) {
      if (request.url.includes("lax-website")) continue;
      // The dispatch token never touches the control repository, and the TS
      // mints nothing itself.
      expect(request.authorization, `${request.method} ${request.url}`).toBe("Bearer workflow-token");
      expect(request.url).not.toMatch(/\/app\/|access_tokens|installation/u);
    }
  });
});

// --------------------------------------------------------------------------
// Harness
// --------------------------------------------------------------------------

function stubWorkflowEnv(extra: Record<string, string>): void {
  const base: Record<string, string> = {
    GITHUB_TOKEN: "workflow-token",
    LAX_REPOSITORY_ID: String(repositoryId),
    GITHUB_RUN_ID: "777",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "lax-archive/lax",
    ACTION: "",
    OPERATION: "",
    VALIDATION_RESULT: "",
    ARCHIVE_COMMIT: "",
    TITLE_SYNC_ERROR: "",
  };
  for (const [name, value] of Object.entries({ ...base, ...extra })) vi.stubEnv(name, value);
}

function writeEvent(event: unknown): void {
  const file = path.join(workDirectory(), "event.json");
  fs.writeFileSync(file, JSON.stringify(event));
  vi.stubEnv("GITHUB_EVENT_PATH", file);
}

function workDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lax-entry-"));
  workDirectories.push(directory);
  return directory;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function submitRequest(preconditions: PublishRequest["preconditions"]): PublishRequest {
  return {
    action: "submit",
    id: "lax-42",
    issue: { repositoryId, number: issueNumber },
    actor: alice,
    issueNodeId: "I_kwDOexample",
    eventCreatedAt: "2026-07-30T11:00:00Z",
    archiveSha,
    commentId,
    command: { action: "submit", ...TEST_SOURCE },
    preconditions,
  };
}

function registerRequest(preconditions: PublishRequest["preconditions"]): PublishRequest {
  return {
    action: "register",
    id: "lax-42",
    issue: { repositoryId, number: issueNumber },
    actor: alice,
    issueNodeId: "I_kwDOexample",
    eventCreatedAt: "2026-07-30T11:00:00Z",
    archiveSha,
    commentId,
    command: { action: "register" },
    preconditions,
  };
}

/**
 * A fake GitHub covering the issue-comment surface of lax-archive/lax, user
 * resolution, the read surface of lax-archive/lax-database, and (with
 * allowWrites) the happy-path CAS write plus the Website dispatch endpoint.
 */
function installIssueFetch(
  state: IssueState,
  archiveTexts?: Record<string, string>,
  options: { allowWrites?: boolean } = {},
): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  const commitSha = "c".repeat(40);
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body === undefined ? "" : String(init.body);
    requests.push({ method, url: String(url), authorization: headers.authorization ?? "", body });
    const route = `${method} ${url.pathname}`;

    // lax-archive/lax issue surface.
    if (route === `GET /repos/lax-archive/lax/issues/${issueNumber}/comments`) return json(state.comments);
    if (route === `POST /repos/lax-archive/lax/issues/${issueNumber}/comments`) {
      const comment = {
        id: 100 + state.comments.length,
        body: (JSON.parse(body) as { body: string }).body,
        user: bot,
      };
      state.comments.push(comment);
      return json(comment, 201);
    }
    if (route === `GET /repos/lax-archive/lax/issues/comments/${commentId}/reactions`) return json(state.reactions);
    if (method === "DELETE" && url.pathname.startsWith(`/repos/lax-archive/lax/issues/comments/${commentId}/reactions/`)) {
      const reactionId = Number(url.pathname.split("/").at(-1));
      state.reactions = state.reactions.filter((reaction) => reaction.id !== reactionId);
      return new Response(null, { status: 204 });
    }
    if (route === "GET /users/alice") return json({ id: alice.githubId, login: alice.handle, type: "User" });

    // lax-archive/lax-database read surface.
    if (archiveTexts !== undefined) {
      if (route === "GET /repos/lax-archive/lax-database") return json({ default_branch: "main" });
      if (route === "GET /repos/lax-archive/lax-database/git/ref/heads/main") return json({ object: { sha: archiveSha } });
      if (route === `GET /repos/lax-archive/lax-database/git/commits/${archiveSha}`) {
        return json({ sha: archiveSha, tree: { sha: "root-tree" } });
      }
      if (route === "GET /repos/lax-archive/lax-database/git/trees/root-tree") {
        return json({
          truncated: false,
          tree: [{ path: "lax-42", mode: "040000", type: "tree", sha: "submission-tree" }],
        });
      }
      if (route === "GET /repos/lax-archive/lax-database/git/trees/submission-tree") {
        return json({
          truncated: false,
          tree: Object.keys(archiveTexts).map((name) => ({
            path: name,
            mode: "100644",
            type: "blob",
            sha: `blob-${name}`,
          })),
        });
      }
      const blobPrefix = "/repos/lax-archive/lax-database/git/blobs/blob-";
      if (method === "GET" && url.pathname.startsWith(blobPrefix)) {
        const name = decodeURIComponent(url.pathname.slice(blobPrefix.length));
        return json({
          encoding: "base64",
          content: Buffer.from(archiveTexts[name]!, "utf8").toString("base64"),
        });
      }
    }

    // Happy-path CAS write surface and Website dispatch.
    if (options.allowWrites === true) {
      if (route === "POST /repos/lax-archive/lax-database/git/blobs") return json({ sha: `blob-${requests.length}` });
      if (route === "POST /repos/lax-archive/lax-database/git/trees") return json({ sha: "new-tree" });
      if (route === "POST /repos/lax-archive/lax-database/git/commits") return json({ sha: commitSha });
      if (route === "POST /repos/lax-archive/lax-database/git/refs") return json({ ref: `refs/heads/lax-publish/${commitSha}` }, 201);
      if (route === "PATCH /repos/lax-archive/lax-database/git/refs/heads/main") return json({ ref: "refs/heads/main" });
      if (method === "DELETE" && url.pathname.startsWith("/repos/lax-archive/lax-database/git/refs/heads/")) {
        return new Response(null, { status: 204 });
      }
      if (route === "POST /repos/lax-archive/lax-website/dispatches") return new Response(null, { status: 204 });
    }

    return json({ message: `unhandled ${route}` }, 500);
  }));
  return requests;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
