import { afterEach, describe, expect, it, vi } from "vitest";
import { zipSync } from "fflate";
import {
  followCommand,
  pollInterval,
  workflowStage,
  type WorkflowStage,
} from "../../src/cli/follow.js";
import {
  appendWorkflowRun,
  previewMarker,
  resultMarker,
  upsertCommandContext,
  workflowRunMarker,
} from "../../src/shared/workflow-comments.js";
import { GitHubError, rateLimitResetAt, type GitHubClient } from "../../src/shared/github.js";

const bot = { id: 41_898_282, login: "github-actions[bot]", type: "Bot" };

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.LAX_POLL_INTERVAL_MS;
  delete process.env.LAX_WORKFLOW_TIMEOUT_MS;
});

describe("the polling budget", () => {
  it("polls every 3 s for the first minute, then backs off to 30 s", () => {
    // Four requests per poll at 3 s is 4,800 an hour against a 5,000 budget;
    // a long queue in front of a 25-minute validation used to spend it all.
    expect(pollInterval(3_000, 0, 3_000)).toBe(3_000);
    expect(pollInterval(3_000, 59_999, 3_000)).toBe(3_000);
    let interval = 3_000;
    const intervals: number[] = [];
    for (let elapsed = 60_000; intervals.length < 6; elapsed += interval) {
      interval = pollInterval(3_000, elapsed, interval);
      intervals.push(interval);
    }
    expect(intervals).toEqual([6_000, 12_000, 24_000, 30_000, 30_000, 30_000]);
  });

  it("reads the reset time out of a rate-limited response and nothing else", () => {
    const now = 1_000_000;
    expect(rateLimitResetAt(403, new Headers({ "retry-after": "30" }), now)).toBe(now + 30_000);
    expect(rateLimitResetAt(429, new Headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000" }), now)).toBe(2_000_000);
    expect(rateLimitResetAt(403, new Headers({ "x-ratelimit-remaining": "0" }), now)).toBe(now + 60_000);
    // A 403 with budget left is a permission problem, not a rate limit.
    expect(rateLimitResetAt(403, new Headers({ "x-ratelimit-remaining": "4999" }), now)).toBeUndefined();
    expect(rateLimitResetAt(404, new Headers({ "retry-after": "30" }), now)).toBeUndefined();
  });

  it("waits out a rate limit and carries on rather than failing the command", async () => {
    process.env.LAX_POLL_INTERVAL_MS = "1";
    process.env.LAX_WORKFLOW_TIMEOUT_MS = "5000";
    const result = appendWorkflowRun(
      `Registered **lax-42**.\n\n${resultMarker(9001)}`,
      { id: "123", url: "https://github.com/lax-archive/lax/actions/runs/123" },
      "success",
    );
    const limited = new GitHubError("GitHub API 403: API rate limit exceeded", 403, undefined, Date.now() + 5);
    const paginate = vi.fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(limited)
      .mockResolvedValueOnce([{ id: 2, body: result, user: bot }]);
    const stages: WorkflowStage[] = [];

    const outcome = await followCommand(
      { paginate, request: vi.fn() } as unknown as GitHubClient,
      42,
      9001,
      { onStage: (stage) => stages.push(stage) },
    );

    expect(outcome.outcome).toBe("success");
    expect(paginate).toHaveBeenCalledTimes(3);
    // The author sees the pause on the row they were already waiting on.
    expect(stages).toEqual([
      { row: "queued" },
      { row: "queued", detail: "waiting out GitHub's API rate limit (1 min)" },
    ]);
  });

  it("still fails on a 403 that is not a rate limit", async () => {
    process.env.LAX_POLL_INTERVAL_MS = "1";
    process.env.LAX_WORKFLOW_TIMEOUT_MS = "100";
    const forbidden = new GitHubError("GitHub API 403: Resource not accessible", 403);
    const paginate = vi.fn().mockRejectedValue(forbidden);

    await expect(followCommand({ paginate, request: vi.fn() } as unknown as GitHubClient, 42, 9001)).rejects.toBe(forbidden);
  });
});

describe("GitHub Actions workflow progress", () => {
  it("names the row the author is waiting on, not the CI job", () => {
    // A step name is CI machinery ("Restore toolchain and warm mathlib
    // workspace"); what reaches the author is the one thing it means for them.
    expect(
      workflowStage(
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
    ).toEqual({ row: "validate", detail: "preparing a clean machine" });
    expect(
      workflowStage({ status: "in_progress", conclusion: null }, [
        { name: "publish-submit", status: "in_progress", conclusion: null },
      ]),
    ).toEqual({ row: "publish" });
    expect(
      workflowStage({ status: "in_progress", conclusion: null }, [
        {
          name: "publish-metadata",
          status: "in_progress",
          conclusion: null,
          steps: [{ name: "Parse metadata evidence", status: "in_progress", conclusion: null }],
        },
      ]),
    ).toEqual({ row: "publish", detail: "re-checking the metadata update" });
    // publishing is several things, and which one it is on is the answer to
    // "what does `Writing the public record` mean"
    expect(
      workflowStage({ status: "in_progress", conclusion: null }, [
        {
          name: "publish-submit",
          status: "in_progress",
          conclusion: null,
          steps: [
            { name: "Mint lax-database token", status: "completed", conclusion: "success" },
            {
              name: "Promote capture, publish trusted submit, and dispatch Website",
              status: "in_progress",
              conclusion: null,
            },
          ],
        },
      ]),
    ).toEqual({ row: "publish", detail: "committing and rebuilding the site" });
    // an unknown job says nothing rather than leaking whatever CI calls it
    expect(
      workflowStage({ status: "in_progress", conclusion: null }, [
        { name: "some-new-job", status: "in_progress", conclusion: null },
      ]),
    ).toEqual({ row: "queued" });
    // a validate job whose current step has no author-facing meaning spins
    // without a detail rather than inventing one
    expect(
      workflowStage({ status: "in_progress", conclusion: null }, [
        {
          name: "Validate",
          status: "in_progress",
          conclusion: null,
          steps: [{ name: "Complete job", status: "in_progress", conclusion: null }],
        },
      ]),
    ).toEqual({ row: "validate" });
  });

  it("reports queued and completed workflow states", () => {
    expect(workflowStage({ status: "queued", conclusion: null }, [])).toEqual({ row: "queued" });
    expect(workflowStage({ status: "completed", conclusion: "failure" }, [])).toEqual({
      row: "publish",
      completed: true,
    });
  });

  it("polls the correlated run and returns its result, printing nothing", async () => {
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
    const previews: string[] = [];
    const stages: WorkflowStage[] = [];

    const outcome = await followCommand(
      { paginate, request } as unknown as GitHubClient,
      42,
      9001,
      { onPreview: (text) => previews.push(text), onStage: (stage) => stages.push(stage) },
    );

    expect(request).toHaveBeenCalledWith("GET", "/repos/lax-archive/lax/actions/runs/123");
    expect(request).toHaveBeenCalledWith(
      "GET",
      "/repos/lax-archive/lax/actions/runs/123/jobs?filter=latest&per_page=100",
    );
    expect(outcome.outcome).toBe("success");
    expect(outcome.runId).toBe("123");
    // the preview reaches the caller as terminal text, not as markdown
    expect(previews).toEqual(["Registration preview."]);
    // the rows the caller drove: queued while the run was unknown, then publish
    expect(stages).toEqual([{ row: "queued" }, { row: "publish" }]);
    // and nothing was printed: composing the screen is the caller's job now
    expect(log).not.toHaveBeenCalled();
  });

  it("hands a refusal back as an outcome rather than throwing", async () => {
    process.env.LAX_POLL_INTERVAL_MS = "1";
    process.env.LAX_WORKFLOW_TIMEOUT_MS = "100";
    const body = appendWorkflowRun(
      "Submission validation failed for **lax-42**.\n\n" + resultMarker(9001),
      { id: "123", url: "https://github.com/lax-archive/lax/actions/runs/123" },
      "failure",
    );
    const paginate = vi.fn().mockResolvedValue([{ id: 2, body, user: bot }]);

    const outcome = await followCommand(
      { paginate } as unknown as GitHubClient,
      42,
      9001,
      {},
    );

    expect(outcome.outcome).toBe("failure");
    // the workflow's own words survive verbatim, for the caller to render
    expect(outcome.comment).toContain("Submission validation failed for **lax-42**.");
  });

  it("accepts final results only from the trusted Actions bot", async () => {
    process.env.LAX_POLL_INTERVAL_MS = "1";
    process.env.LAX_WORKFLOW_TIMEOUT_MS = "100";
    const botResult = appendWorkflowRun(
      `Command refused.\n\n${resultMarker(9001)}`,
      { id: "123", url: "https://github.com/lax-archive/lax/actions/runs/123" },
      "failure",
    );
    const editedSource =
      `/lax register lax-42\n\n${resultMarker(9001)}\n<!-- lax-outcome:success -->`;
    const paginate = vi.fn().mockResolvedValue([
      { id: 2, body: botResult, user: bot },
      { id: 9001, body: editedSource, user: { id: 10, login: "alice", type: "User" } },
    ]);

    const outcome = await followCommand(
      { paginate } as unknown as GitHubClient,
      42,
      9001,
      {},
    );

    expect(outcome.outcome).toBe("failure");
    expect(outcome.comment).toContain("Command refused.");
  });

  it("rejects a bot result without an authenticated outcome", async () => {
    process.env.LAX_POLL_INTERVAL_MS = "1";
    process.env.LAX_WORKFLOW_TIMEOUT_MS = "100";
    const body = appendWorkflowRun(
      `Ambiguous result.\n\n${resultMarker(9001)}`,
      { id: "123", url: "https://github.com/lax-archive/lax/actions/runs/123" },
    );
    const paginate = vi.fn().mockResolvedValue([{ id: 2, body, user: bot }]);

    await expect(
      followCommand({ paginate } as unknown as GitHubClient, 42, 9001, {}),
    ).rejects.toThrow("did not include an authenticated outcome");
  });

  it("ends a submit on the validate job's own report, before the record comment", async () => {
    // The author is waiting for a diagnosis, and the report artifact carries
    // it: as soon as the validate job concludes the findings go to the caller,
    // and a caller that throws from there ends the command.
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

    class Refused extends Error {}
    await expect(
      followCommand({ paginate, request, requestBinary } as unknown as GitHubClient, 42, 9001, {
        onValidationReport: (report) => {
          expect(report.ok).toBe(false);
          expect(report.violations[0]?.message).toContain("unsolved goals");
          expect(report.warnings[0]?.rule).toBe("abstract");
          throw new Refused("the archive refused it");
        },
      }),
    ).rejects.toBeInstanceOf(Refused);

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

    await expect(
      followCommand({ paginate, request } as unknown as GitHubClient, 42, 9001, {}),
    ).rejects.toThrow("did not answer about lax-42 in time");
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

    await expect(
      followCommand({ paginate, request } as unknown as GitHubClient, 42, 9001, {}),
    ).rejects.toThrow(
      "without recording a result; inspect https://github.com/lax-archive/lax/actions/runs/321",
    );
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

    const outcome = await followCommand({ paginate } as unknown as GitHubClient, 42, 9001, {
      acceptSuccessReaction: true,
    });

    expect(paginate).toHaveBeenCalledWith(
      "/repos/lax-archive/lax/issues/comments/9001/reactions",
    );
    expect(outcome).toEqual({
      outcome: "success",
      runId: "456",
      runUrl: "https://github.com/lax-archive/lax/actions/runs/456",
    });
  });

  it("times out when GitHub never emits a correlated comment", async () => {
    process.env.LAX_POLL_INTERVAL_MS = "1";
    process.env.LAX_WORKFLOW_TIMEOUT_MS = "5";
    const paginate = vi.fn().mockResolvedValue([]);

    await expect(
      followCommand({ paginate } as unknown as GitHubClient, 42, 9001, {}),
    ).rejects.toThrow("the archive did not answer about lax-42 in time");
    expect(paginate).toHaveBeenCalled();
  });
});
