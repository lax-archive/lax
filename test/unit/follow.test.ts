import { afterEach, describe, expect, it, vi } from "vitest";
import { zipSync } from "fflate";
import { CommandFailedError, followCommand, workflowProgress } from "../../src/cli/follow.js";
import {
  appendWorkflowRun,
  previewMarker,
  resultMarker,
  upsertCommandContext,
  workflowRunMarker,
} from "../../src/shared/workflow-comments.js";
import type { GitHubClient } from "../../src/shared/github.js";

const bot = { id: 41_898_282, login: "github-actions[bot]", type: "Bot" };

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.LAX_POLL_INTERVAL_MS;
  delete process.env.LAX_WORKFLOW_TIMEOUT_MS;
});

describe("GitHub Actions workflow progress", () => {
  it("names the stage the author is waiting on, not the CI step", () => {
    expect(
      workflowProgress(
        { status: "in_progress", conclusion: null },
        [
          {
            name: "Validate",
            status: "in_progress",
            conclusion: null,
            steps: [
              { name: "Set up job", status: "completed", conclusion: "success" },
              {
                name: "Restore toolchain and warm mathlib workspace",
                status: "in_progress",
                conclusion: null,
              },
            ],
          },
        ],
      ),
    ).toEqual({ label: "validating: compile, kernel replay, inspection", completed: false });
    expect(
      workflowProgress({ status: "in_progress", conclusion: null }, [
        { name: "publish-submit", status: "in_progress", conclusion: null },
      ]).label,
    ).toBe("publishing to lax-database");
    // an unknown job says nothing rather than leaking whatever CI calls it
    expect(
      workflowProgress({ status: "in_progress", conclusion: null }, [
        { name: "some-new-job", status: "in_progress", conclusion: null },
      ]).label,
    ).toBe("working");
  });

  it("reports queued and completed workflow states", () => {
    expect(workflowProgress({ status: "queued", conclusion: null }, [])).toEqual({
      label: "queued",
      completed: false,
    });
    expect(workflowProgress({ status: "completed", conclusion: "failure" }, [])).toEqual({
      label: "finished (failure)",
      completed: true,
      conclusion: "failure",
    });
  });

  it("polls the correlated run and stops at its result comment", async () => {
    process.env.LAX_POLL_INTERVAL_MS = "1";
    process.env.LAX_WORKFLOW_TIMEOUT_MS = "100";
    const preview = appendWorkflowRun(
      `Registration preview.\n\n${previewMarker(9001)}`,
      { id: "123", url: "https://github.com/lax-archive/lax/actions/runs/123" },
    );
    const result = appendWorkflowRun(
      `Registered **lax-42**.\n\n${resultMarker(9001)}`,
      { id: "123", url: "https://github.com/lax-archive/lax/actions/runs/123" },
      "success",
    );
    const paginate = vi.fn()
      .mockResolvedValueOnce([{ id: 1, body: preview, user: bot }])
      .mockResolvedValueOnce([
        { id: 1, body: preview, user: bot },
        { id: 2, body: result, user: bot },
      ]);
    const request = vi.fn(async (_method: string, path: string): Promise<unknown> =>
      path.endsWith("/jobs?filter=latest&per_page=100")
        ? {
            jobs: [
              {
                name: "publish",
                status: "in_progress",
                conclusion: null,
                steps: [{ name: "Publish", status: "in_progress", conclusion: null }],
              },
            ],
          }
        : { status: "in_progress", conclusion: null },
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await followCommand({ paginate, request } as unknown as GitHubClient, 42, 9001, {
      label: "lax register",
      showPreview: true,
    });

    expect(request).toHaveBeenCalledWith(
      "GET",
      "/repos/lax-archive/lax/actions/runs/123",
    );
    expect(request).toHaveBeenCalledWith(
      "GET",
      "/repos/lax-archive/lax/actions/runs/123/jobs?filter=latest&per_page=100",
    );
    const messages = log.mock.calls.map(([message]) => String(message));
    expect(messages[0]).toBe(
      "lax register: workflow run #123: https://github.com/lax-archive/lax/actions/runs/123",
    );
    expect(messages[1]).toBe("lax register: Registration preview.");
    // the run is announced once, and markdown emphasis does not reach the terminal
    expect(messages[2]).toBe("lax register: Registered lax-42.");
    expect(messages).toHaveLength(3);
  });

  it("fails the command when the result comment reports a failure", async () => {
    process.env.LAX_POLL_INTERVAL_MS = "1";
    process.env.LAX_WORKFLOW_TIMEOUT_MS = "100";
    const result = appendWorkflowRun(
      "Submission validation failed for **lax-42**; lax-database was not changed.\n\n" +
        "**compile-proofs** (`build`)\n\n```text\nProofs/Main.lean:9:2: error: unsolved goals\n" +
        "⊢ False\n```\n\n" +
        resultMarker(9001),
      { id: "123", url: "https://github.com/lax-archive/lax/actions/runs/123" },
      "failure",
    );
    const paginate = vi.fn().mockResolvedValue([{ id: 2, body: result, user: bot }]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(
      followCommand({ paginate } as unknown as GitHubClient, 42, 9001, { label: "lax submit" }),
    ).rejects.toBeInstanceOf(CommandFailedError);

    const printed = log.mock.calls.flat().join("\n");
    expect(printed).toContain("lax submit: Submission validation failed for lax-42");
    expect(printed).toContain("compile-proofs (build)");
    // the compile transcript reaches the author with its lines intact
    expect(printed).toContain("Proofs/Main.lean:9:2: error: unsolved goals");
    expect(printed).toContain("⊢ False");
    expect(printed).not.toContain("```");
  });

  it("ends a submit on the validate job's own report, before the record comment", async () => {
    // The author is waiting for a diagnosis, and the report artifact carries
    // it: as soon as the validate job concludes the findings are printed in
    // the same shape `lax build` prints locally, and the command is over.
    process.env.LAX_POLL_INTERVAL_MS = "1";
    process.env.LAX_WORKFLOW_TIMEOUT_MS = "100";
    const preview = appendWorkflowRun(
      `Parsed source preview.\n\n${previewMarker(9001)}`,
      { id: "123", url: "https://github.com/lax-archive/lax/actions/runs/123" },
    );
    const paginate = vi.fn().mockResolvedValue([{ id: 1, body: preview, user: bot }]);
    const request = vi.fn(async (_method: string, path: string): Promise<unknown> => {
      if (path.includes("/artifacts")) {
        return { artifacts: [{ id: 5, name: "submission-validation-report-42" }] };
      }
      if (path.endsWith("/jobs?filter=latest&per_page=100")) {
        return { jobs: [{ name: "Validate", status: "completed", conclusion: "failure" }] };
      }
      return { status: "in_progress", conclusion: null };
    });
    const requestBinary = vi.fn(async () =>
      zipSync({
        "validation-report.json": new TextEncoder().encode(JSON.stringify({
          reportVersion: 1,
          ok: false,
          warnings: [{ phase: "static", rule: "abstract", message: "the abstract is short" }],
          violations: [{
            phase: "compile-proofs",
            rule: "build",
            message: "Proofs/Main.lean:9:2: error: unsolved goals\n⊢ False",
          }],
        })),
      }),
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(
      followCommand({ paginate, request, requestBinary } as unknown as GitHubClient, 42, 9001, {
        label: "lax submit",
        readValidationReport: true,
      }),
    ).rejects.toBeInstanceOf(CommandFailedError);

    const printed = error.mock.calls.flat().join("\n");
    expect(printed).toContain("lax submit: found 1 error and 1 warning during validation");
    expect(printed).toContain("      - [build] Proofs/Main.lean:9:2: error: unsolved goals");
    // a transcript keeps its lines, indented under the finding
    expect(printed).toContain("        ⊢ False");
    expect(printed).toContain("lax submit: validation failed; lax-database was not changed");
    expect(request).toHaveBeenCalledWith(
      "GET",
      "/repos/lax-archive/lax/actions/runs/123/artifacts?per_page=100",
    );
  });

  it("reads no report for the commands that never validate anything", async () => {
    process.env.LAX_POLL_INTERVAL_MS = "1";
    process.env.LAX_WORKFLOW_TIMEOUT_MS = "20";
    const preview = appendWorkflowRun(
      `Delete preview.\n\n${previewMarker(9001)}`,
      { id: "123", url: "https://github.com/lax-archive/lax/actions/runs/123" },
    );
    const paginate = vi.fn().mockResolvedValue([{ id: 1, body: preview, user: bot }]);
    const request = vi.fn(async (_method: string, path: string): Promise<unknown> =>
      path.endsWith("/jobs?filter=latest&per_page=100")
        ? { jobs: [{ name: "Validate", status: "completed", conclusion: "failure" }] }
        : { status: "in_progress", conclusion: null },
    );
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(
      followCommand({ paginate, request } as unknown as GitHubClient, 42, 9001, {
        label: "lax delete",
      }),
    ).rejects.toThrow("timed out");
    expect(request.mock.calls.map(([, path]) => path).some((path) => path.includes("/artifacts")))
      .toBe(false);
  });

  it("fails quickly when a completed run never posts a result", async () => {
    process.env.LAX_POLL_INTERVAL_MS = "1";
    process.env.LAX_WORKFLOW_TIMEOUT_MS = "100";
    const preview = appendWorkflowRun(
      `Delete preview.\n\n${previewMarker(9001)}`,
      { id: "321", url: "https://github.com/lax-archive/lax/actions/runs/321" },
    );
    const paginate = vi.fn().mockResolvedValue([{ id: 1, body: preview, user: bot }]);
    const request = vi.fn(async (_method: string, path: string): Promise<unknown> =>
      path.endsWith("/jobs?filter=latest&per_page=100")
        ? { jobs: [] }
        : { status: "completed", conclusion: "failure" },
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(
      followCommand({ paginate, request } as unknown as GitHubClient, 42, 9001, {
        label: "lax delete",
      }),
    ).rejects.toThrow("workflow #321 finished with failure without posting a result");
    expect(paginate).toHaveBeenCalledTimes(2);
  });

  it("follows an owner command through its hidden run marker and final bot thumbs-up", async () => {
    process.env.LAX_POLL_INTERVAL_MS = "1";
    process.env.LAX_WORKFLOW_TIMEOUT_MS = "100";
    const source = upsertCommandContext(
      '/lax owners [{"githubId":10,"handle":"alice"}]',
      9001,
      workflowRunMarker("456"),
    );
    const paginate = vi.fn(async (path: string): Promise<unknown[]> =>
      path.endsWith("/reactions")
        ? [
            {
              content: "rocket",
              user: { id: 41_898_282, login: "github-actions[bot]", type: "Bot" },
            },
            {
              content: "+1",
              user: { id: 41_898_282, login: "github-actions[bot]", type: "Bot" },
            },
          ]
        : [{ id: 9001, body: source, user: { id: 10, login: "alice", type: "User" } }],
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await followCommand({ paginate } as unknown as GitHubClient, 42, 9001, {
      label: "lax owners",
      acceptSuccessReaction: true,
    });

    expect(paginate).toHaveBeenCalledWith(
      "/repos/lax-archive/lax/issues/comments/9001/reactions",
    );
    expect(log.mock.calls.flat().join("\n")).toContain(
      "lax owners: workflow run #456: https://github.com/lax-archive/lax/actions/runs/456",
    );
    expect(log.mock.calls.flat().join("\n")).toContain("lax owners: owner list updated.");
  });

  it("times out when GitHub never emits a correlated comment", async () => {
    process.env.LAX_POLL_INTERVAL_MS = "1";
    process.env.LAX_WORKFLOW_TIMEOUT_MS = "5";
    const paginate = vi.fn().mockResolvedValue([]);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(
      followCommand({ paginate } as unknown as GitHubClient, 42, 9001, { label: "lax submit" }),
    ).rejects.toThrow("timed out waiting for the workflow result on lax-42");
    expect(paginate).toHaveBeenCalled();
  });
});
