import { afterEach, describe, expect, it, vi } from "vitest";
import { followCommand, workflowProgress } from "../../src/cli/follow.js";
import { appendWorkflowRun, previewMarker, resultMarker } from "../../src/shared/workflow-comments.js";
import type { GitHubClient } from "../../src/shared/github.js";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.LAX_POLL_INTERVAL_MS;
  delete process.env.LAX_WORKFLOW_TIMEOUT_MS;
});

describe("GitHub Actions workflow progress", () => {
  it("shows the active job and step", () => {
    expect(
      workflowProgress(
        { status: "in_progress", conclusion: null },
        [
          {
            name: "publish",
            status: "in_progress",
            conclusion: null,
            steps: [
              { name: "Set up job", status: "completed", conclusion: "success" },
              { name: "Revalidate and publish", status: "in_progress", conclusion: null },
            ],
          },
        ],
      ),
    ).toEqual({
      label: "GitHub Actions · publish · Revalidate and publish",
      completed: false,
    });
  });

  it("reports queued and completed workflow states", () => {
    expect(workflowProgress({ status: "queued", conclusion: null }, [])).toEqual({
      label: "GitHub Actions · queued",
      completed: false,
    });
    expect(workflowProgress({ status: "completed", conclusion: "failure" }, [])).toEqual({
      label: "GitHub Actions · failure",
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
    );
    const paginate = vi.fn()
      .mockResolvedValueOnce([{ id: 1, body: preview }])
      .mockResolvedValueOnce([{ id: 1, body: preview }, { id: 2, body: result }]);
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

    await followCommand({ paginate, request } as unknown as GitHubClient, 42, 9001);

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
      "Following workflow run #123: https://github.com/lax-archive/lax/actions/runs/123",
    );
    expect(messages[1]).toContain("Registration preview.");
    expect(messages[2]).toBe(
      "Workflow run #123: https://github.com/lax-archive/lax/actions/runs/123",
    );
    expect(messages[3]).toContain("Registered **lax-42**.");
  });

  it("fails quickly when a completed run never posts a result", async () => {
    process.env.LAX_POLL_INTERVAL_MS = "1";
    process.env.LAX_WORKFLOW_TIMEOUT_MS = "100";
    const preview = appendWorkflowRun(
      `Delete preview.\n\n${previewMarker(9001)}`,
      { id: "321", url: "https://github.com/lax-archive/lax/actions/runs/321" },
    );
    const paginate = vi.fn().mockResolvedValue([{ id: 1, body: preview }]);
    const request = vi.fn(async (_method: string, path: string): Promise<unknown> =>
      path.endsWith("/jobs?filter=latest&per_page=100")
        ? { jobs: [] }
        : { status: "completed", conclusion: "failure" },
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(
      followCommand({ paginate, request } as unknown as GitHubClient, 42, 9001),
    ).rejects.toThrow("workflow #321 finished with failure without posting a result");
    expect(paginate).toHaveBeenCalledTimes(2);
  });

  it("times out when GitHub never emits a correlated comment", async () => {
    process.env.LAX_POLL_INTERVAL_MS = "1";
    process.env.LAX_WORKFLOW_TIMEOUT_MS = "5";
    const paginate = vi.fn().mockResolvedValue([]);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(
      followCommand({ paginate } as unknown as GitHubClient, 42, 9001),
    ).rejects.toThrow("timed out waiting for the workflow result on lax-42");
    expect(paginate).toHaveBeenCalled();
  });
});
