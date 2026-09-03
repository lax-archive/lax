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
    stubWorkflowEnv({ ACTION: "submit", OPERATION: "validate", PUBLICATION_FAILED: "true" });
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
      "Publication did not complete. Inspect this run before retrying: if it created a " +
        "lax-database commit, that commit must not be replayed.",
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

  it("says validation reporting failed when no publishing job ran at all", async () => {
    // The publishing jobs are the only ones that can write lax-database, so
    // without one the report may state plainly that nothing was changed.
    stubWorkflowEnv({ ACTION: "submit", OPERATION: "validate" });
    writeEvent({ issue: { number: issueNumber }, comment: { id: commentId } });
    const state: IssueState = { comments: [], reactions: [] };
    installIssueFetch(state);
    await reportFailure();
    expect(state.comments[0]!.body).toContain(
      "Validation or result reporting failed; no trustworthy validation result was produced. " +
        "lax-database was not changed.",
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

  it("records a failed validation in one paragraph and leaves the detail in the artifact", async () => {
    // The comment is the permanent record of the outcome, not of the build:
    // the transcript belongs to the report artifact, which the author's CLI
    // reads directly and which expires with the run.
    const transcript =
      "info: building Proofs.Main\nProofs/Main.lean:9:2: error: unsolved goals\n⊢ False";
    const reportPath = path.join(workDirectory(), "validation-report.json");
    fs.writeFileSync(reportPath, JSON.stringify({
      reportVersion: 1,
      ok: false,
      request: { id: "lax-42" },
      warnings: [{ phase: "static", rule: "abstract", message: "the abstract is short" }],
      violations: [
        { phase: "compile-proofs", rule: "build", message: transcript },
        { phase: "inspect", rule: "unproved", message: "the conclusion is not proved" },
      ],
    }));
    stubWorkflowEnv({
      VALIDATION_CONTEXT: encode({ id: "lax-42", issueNumber, commentId }),
      VALIDATION_REPORT_PATH: reportPath,
    });
    const state: IssueState = { comments: [], reactions: [] };
    installIssueFetch(state);

    await reportValidation();

    const body = state.comments[0]!.body;
    expect(body).toContain("Submission validation failed for **lax-42**; lax-database was not changed.");
    expect(body).toContain(
      "First finding `[compile-proofs/build]`: info: building Proofs.Main",
    );
    expect(body).toContain("The complete findings are in this run's artifacts");
    // Only the first violation's first line, and no transcript, warnings, or
    // second finding.
    expect(body).not.toContain("unsolved goals");
    expect(body).not.toContain("the conclusion is not proved");
    expect(body).not.toContain("the abstract is short");
    expect(body).not.toContain("```");
    expect(body).toContain(resultMarker(commentId));
    expect(parseWorkflowComment(body)).toMatchObject({ outcome: "failure", runId: "777" });
  });

  it("reports a typed transient infrastructure failure without blaming the submission", async () => {
    const reportPath = path.join(workDirectory(), "validation-report.json");
    fs.writeFileSync(reportPath, JSON.stringify({
      reportVersion: 1,
      ok: false,
      request: { id: "lax-42" },
      warnings: [],
      violations: [],
      failure: {
        kind: "infrastructure",
        retryable: true,
        phase: "source",
        rule: "archive-snapshot",
        message: "GitHub returned HTTP 503\ntransport transcript",
      },
    }));
    stubWorkflowEnv({
      VALIDATION_CONTEXT: encode({ id: "lax-42", issueNumber, commentId }),
      VALIDATION_REPORT_PATH: reportPath,
    });
    const state: IssueState = { comments: [], reactions: [] };
    installIssueFetch(state);

    await reportValidation();

    const body = state.comments[0]!.body;
    expect(body).toContain("Validation infrastructure failed for **lax-42**");
    expect(body).toContain("did not receive a content verdict");
    expect(body).toContain("Failure `[source/archive-snapshot]`: GitHub returned HTTP 503");
    expect(body).toContain("retrying the unchanged submission may succeed");
    expect(body).not.toContain("Submission validation failed");
    expect(body).not.toContain("transport transcript");
  });

  it("reports a resource limit as capacity rather than a content rejection", async () => {
    const reportPath = path.join(workDirectory(), "validation-report.json");
    fs.writeFileSync(reportPath, JSON.stringify({
      reportVersion: 1,
      ok: false,
      request: { id: "lax-42" },
      warnings: [],
      violations: [],
      failure: {
        kind: "resource-limit",
        retryable: false,
        phase: "compile-proofs",
        rule: "compile",
        message: "proofs compilation exceeded its memory limit",
      },
    }));
    stubWorkflowEnv({
      VALIDATION_CONTEXT: encode({ id: "lax-42", issueNumber, commentId }),
      VALIDATION_REPORT_PATH: reportPath,
    });
    const state: IssueState = { comments: [], reactions: [] };
    installIssueFetch(state);

    await reportValidation();

    const body = state.comments[0]!.body;
    expect(body).toContain("reached an Archive resource limit");
    expect(body).toContain("was not rejected on content");
    expect(body).toContain("Reduce the submission's resource use before retrying");
  });
});

describe("prepare-submit entry point", () => {
  it("revalidates artifacts and fresh state credential-free", async () => {
    const texts = initialFiles("lax-42", { repositoryId, number: issueNumber }, alice, "2026-07-30T10:00:00Z");
    const directory = workDirectory();
    const captureBytes = Buffer.from("lax capture fixture bytes");
    const artifacts = successfulArtifacts();
    artifacts.report.request.issue = { repositoryId, number: issueNumber };
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
      VALIDATION_PAPER_PATH: path.join(directory, "paper.pdf"),
      VALIDATION_PAPER_WEB_PATH: path.join(directory, "paper-web.tar"),
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

  it("hashes a recorded paper from the validate artifact before anything is minted", async () => {
    const texts = initialFiles("lax-42", { repositoryId, number: issueNumber }, alice, "2026-07-30T10:00:00Z");
    const directory = workDirectory();
    const captureBytes = Buffer.from("lax capture fixture bytes");
    const pdf = Buffer.from("%PDF-1.7 fixture paper");
    const artifacts = successfulArtifacts();
    artifacts.report.request.issue = { repositoryId, number: issueNumber };
    const digest = createHash("sha256").update(captureBytes).digest("hex");
    artifacts.report.capture.digest = digest;
    const paperManifest = { folder: "paper", main: "main.tex", engine: "pdflatex" as const };
    for (const output of [artifacts.buildOutput, artifacts.report.buildOutput]) {
      output.capture.digest = digest;
      output.inputs.manifest.paper = paperManifest;
      output.paper = {
        ...paperManifest,
        pdf: { digest: createHash("sha256").update(pdf).digest("hex"), bytes: pdf.length, pages: 1 },
        pageSizes: [[612, 792]],
        marks: [],
      };
    }
    fs.writeFileSync(path.join(directory, "validation-report.json"), JSON.stringify(artifacts.report));
    fs.writeFileSync(path.join(directory, "generated-build-output.json"), JSON.stringify(artifacts.buildOutput));
    fs.writeFileSync(path.join(directory, "capture.tar"), captureBytes);
    const outputFile = path.join(directory, "github-output");
    stubWorkflowEnv({
      GITHUB_OUTPUT: outputFile,
      PUBLISH_REQUEST: encode(submitRequest(fileDigests(texts))),
      VALIDATION_REPORT_PATH: path.join(directory, "validation-report.json"),
      GENERATED_BUILD_OUTPUT_PATH: path.join(directory, "generated-build-output.json"),
      VALIDATION_CAPTURE_PATH: path.join(directory, "capture.tar"),
      VALIDATION_PAPER_PATH: path.join(directory, "paper.pdf"),
      VALIDATION_PAPER_WEB_PATH: path.join(directory, "paper-web.tar"),
    });
    installIssueFetch({ comments: [], reactions: [] }, texts);

    // The recorded bytes: ready.
    fs.writeFileSync(path.join(directory, "paper.pdf"), pdf);
    await prepareSubmit();
    expect(fs.readFileSync(outputFile, "utf8")).toMatch(/should_publish<<[^\n]+\ntrue\n/u);
    // The wrong bytes under the right name: refused before any state is read.
    fs.writeFileSync(path.join(directory, "paper.pdf"), "%PDF-1.7 some other paper");
    await expect(prepareSubmit()).rejects.toThrow("recorded size");
    // Recorded but not in the artifact: refused.
    fs.rmSync(path.join(directory, "paper.pdf"));
    await expect(prepareSubmit()).rejects.toThrow("validation paper is missing");
    // A stray bundle beside a web-less paper: refused (the tar direction of
    // the iff, independent of the paper.pdf state).
    fs.writeFileSync(path.join(directory, "paper.pdf"), pdf);
    fs.writeFileSync(path.join(directory, "paper-web.tar"), "stray bundle bytes");
    await expect(prepareSubmit()).rejects.toThrow(
      "carries a paper-web.tar its build output does not record",
    );
  });

  it("hashes a recorded web bundle from the validate artifact, both iff directions enforced", async () => {
    const texts = initialFiles("lax-42", { repositoryId, number: issueNumber }, alice, "2026-07-30T10:00:00Z");
    const directory = workDirectory();
    const captureBytes = Buffer.from("lax capture fixture bytes");
    const pdf = Buffer.from("%PDF-1.7 fixture paper");
    const bundle = Buffer.from("deterministic web bundle fixture bytes");
    const artifacts = successfulArtifacts();
    artifacts.report.request.issue = { repositoryId, number: issueNumber };
    const digest = createHash("sha256").update(captureBytes).digest("hex");
    const paperManifest = { folder: "paper", main: "main.tex", engine: "pdflatex" as const };
    for (const output of [artifacts.buildOutput, artifacts.report.buildOutput]) {
      output.capture.digest = digest;
      output.inputs.manifest.paper = paperManifest;
      output.paper = {
        ...paperManifest,
        pdf: { digest: createHash("sha256").update(pdf).digest("hex"), bytes: pdf.length, pages: 1 },
        pageSizes: [[612, 792]],
        marks: [],
        web: {
          format: { tool: "reflowtex", rev: "8".repeat(40), schema: "9".repeat(64) },
          bundle: { digest: createHash("sha256").update(bundle).digest("hex"), bytes: bundle.length },
        },
      };
    }
    artifacts.report.capture.digest = digest;
    fs.writeFileSync(path.join(directory, "validation-report.json"), JSON.stringify(artifacts.report));
    fs.writeFileSync(path.join(directory, "generated-build-output.json"), JSON.stringify(artifacts.buildOutput));
    fs.writeFileSync(path.join(directory, "capture.tar"), captureBytes);
    fs.writeFileSync(path.join(directory, "paper.pdf"), pdf);
    const outputFile = path.join(directory, "github-output");
    stubWorkflowEnv({
      GITHUB_OUTPUT: outputFile,
      PUBLISH_REQUEST: encode(submitRequest(fileDigests(texts))),
      VALIDATION_REPORT_PATH: path.join(directory, "validation-report.json"),
      GENERATED_BUILD_OUTPUT_PATH: path.join(directory, "generated-build-output.json"),
      VALIDATION_CAPTURE_PATH: path.join(directory, "capture.tar"),
      VALIDATION_PAPER_PATH: path.join(directory, "paper.pdf"),
      VALIDATION_PAPER_WEB_PATH: path.join(directory, "paper-web.tar"),
    });
    installIssueFetch({ comments: [], reactions: [] }, texts);

    // The recorded bytes: ready.
    fs.writeFileSync(path.join(directory, "paper-web.tar"), bundle);
    await prepareSubmit();
    expect(fs.readFileSync(outputFile, "utf8")).toMatch(/should_publish<<[^\n]+\ntrue\n/u);
    // Recorded but not in the artifact: refused before anything is minted.
    fs.rmSync(path.join(directory, "paper-web.tar"));
    await expect(prepareSubmit()).rejects.toThrow("validation paper web bundle is missing");
    // The wrong size under the right name: refused.
    fs.writeFileSync(path.join(directory, "paper-web.tar"), "wrong length");
    await expect(prepareSubmit()).rejects.toThrow("recorded size");
    // The recorded size with tampered bytes: refused at the digest.
    fs.writeFileSync(path.join(directory, "paper-web.tar"), Buffer.from("X".repeat(bundle.length)));
    await expect(prepareSubmit()).rejects.toThrow("paper web bundle digest does not match");
  });
});

describe("publish entry point", () => {
  it("publishes and dispatches the rebuild in one process, with the env-provided tokens", async () => {
    // The Website dispatch is the tail of the same handler: the commit never
    // leaves memory, so there is no job output for anything to forge, and each
    // repository is still reached with exactly its own token.
    const texts = initialFiles("lax-42", { repositoryId, number: issueNumber }, alice, "2026-07-30T10:00:00Z");
    stubWorkflowEnv({
      LAX_DATABASE_TOKEN: "database-token",
      LAX_WEBSITE_TOKEN: "website-token",
      PUBLISH_REQUEST: encode(registerRequest(fileDigests(texts))),
    });
    const requests = installIssueFetch({ comments: [], reactions: [] }, texts, { allowWrites: true });

    await publish();

    const dispatches = requests.filter((request) => request.url.includes("/repos/lax-archive/lax-website/dispatches"));
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.method).toBe("POST");
    expect(dispatches[0]!.authorization).toBe("Bearer website-token");
    expect(JSON.parse(dispatches[0]!.body)).toMatchObject({
      event_type: "lax-db-updated",
      client_payload: { archiveCommit: "c".repeat(40), submissionId: "lax-42", action: "register" },
    });
    for (const request of requests) {
      // Control-repository reads/writes use the workflow token; every
      // lax-database request uses the App token the environment provided, and
      // the dispatch token touches nothing but lax-website.
      const expected = request.url.includes("/repos/lax-archive/lax-database")
        ? "Bearer database-token"
        : request.url.includes("/repos/lax-archive/lax-website")
          ? "Bearer website-token"
          : "Bearer workflow-token";
      expect(request.authorization, `${request.method} ${request.url}`).toBe(expected);
      // The TS never mints tokens: that is exclusively the pinned
      // create-github-app-token action's job in YAML.
      expect(request.url).not.toMatch(/\/app\/|access_tokens|installation/u);
    }
    const writes = requests.filter((request) => request.method !== "GET");
    expect(writes.length).toBeGreaterThan(0);
    // The final result comment is posted by this job too.
    expect(
      writes.some((request) => request.url.endsWith(`/issues/${issueNumber}/comments`)),
    ).toBe(true);
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
    PUBLICATION_FAILED: "",
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
