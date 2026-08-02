import { afterEach, describe, expect, it, vi } from "vitest";
import { followCommand, followInitialization } from "../../src/cli/follow.js";
import type { GitHubClient } from "../../src/shared/github.js";
import {
  appendWorkflowRun,
  initializationMarker,
  initializationPreviewMarker,
  parseWorkflowComment,
  previewMarker,
  resultMarker,
  visibleComment,
} from "../../src/shared/workflow-comments.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("workflow comment correlation", () => {
  it("round-trips visible run ids, URLs and command markers", () => {
    const body = appendWorkflowRun(`Accepted.\n\n${previewMarker(9001)}`, {
      id: "123456789",
      url: "https://github.com/lax-archive/lax/actions/runs/123456789",
    });
    expect(parseWorkflowComment(body)).toEqual({
      previewCommentId: 9001,
      runId: "123456789",
      runUrl: "https://github.com/lax-archive/lax/actions/runs/123456789",
    });
    expect(visibleComment(body)).toContain("Workflow run: [#123456789]");
    expect(visibleComment(body)).not.toContain("<!--");
  });

  it("does not confuse preview, result and initialization markers", () => {
    expect(parseWorkflowComment(previewMarker(1))).toEqual({ previewCommentId: 1 });
    expect(parseWorkflowComment(resultMarker(2))).toEqual({ resultCommentId: 2 });
    expect(parseWorkflowComment(initializationMarker(3))).toEqual({ initializationIssue: 3 });
    expect(parseWorkflowComment(initializationPreviewMarker(3))).toEqual({
      initializationPreviewIssue: 3,
    });
    expect(parseWorkflowComment("<!-- lax-result-comment-id:0 -->")).toEqual({});
    expect(parseWorkflowComment("<!-- lax-result-comment-id:2 --> trailing")).toEqual({
      resultCommentId: 2,
    });
  });

  it("follows a command from its preview run id through its result", async () => {
    vi.stubEnv("LAX_POLL_INTERVAL_MS", "1");
    vi.stubEnv("LAX_WORKFLOW_TIMEOUT_MS", "1000");
    const preview = appendWorkflowRun(`Preview.\n\n${previewMarker(77)}`, run());
    const result = appendWorkflowRun(`Done.\n\n${resultMarker(77)}`, run());
    const paginate = vi
      .fn()
      .mockResolvedValueOnce([{ id: 1, body: preview }])
      .mockResolvedValue([{ id: 1, body: preview }, { id: 2, body: result }]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await followCommand({ paginate } as unknown as GitHubClient, 42, 77);
    expect(paginate).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.flat().join("\n")).toContain("Workflow run #123456789");
    expect(log.mock.calls.flat().join("\n")).toContain("Done.");
  });

  it("follows initialization until the correlated final comment", async () => {
    vi.stubEnv("LAX_POLL_INTERVAL_MS", "1");
    vi.stubEnv("LAX_WORKFLOW_TIMEOUT_MS", "1000");
    const result = appendWorkflowRun(`Initialized.\n\n${initializationMarker(42)}`, run());
    const paginate = vi.fn().mockResolvedValue([{ id: 1, body: result }]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await followInitialization({ paginate } as unknown as GitHubClient, 42);
    expect(log.mock.calls.flat().join("\n")).toContain("Workflow run #123456789");
    expect(log.mock.calls.flat().join("\n")).toContain("Initialized.");
  });
});

function run(): { id: string; url: string } {
  return {
    id: "123456789",
    url: "https://github.com/lax-archive/lax/actions/runs/123456789",
  };
}
