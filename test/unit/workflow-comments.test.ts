import { afterEach, describe, expect, it, vi } from "vitest";
import { followCommand, followInitialization } from "../../src/cli/follow.js";
import type { GitHubClient } from "../../src/shared/github.js";
import {
  appendWorkflowRun,
  initializationMarker,
  initializationPreviewMarker,
  parseWorkflowComment,
  previewMarker,
  readCommandContext,
  resultMarker,
  upsertCommandContext,
  visibleComment,
  workflowRunMarker,
} from "../../src/shared/workflow-comments.js";

const bot = { id: 41_898_282, login: "github-actions[bot]", type: "Bot" };

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
    expect(parseWorkflowComment(
      `${resultMarker(1)}\n<!-- lax-outcome:failure -->\n` +
      `${resultMarker(2)}\n<!-- lax-outcome:success -->`,
    )).toEqual({ resultCommentId: 2, outcome: "success" });
  });

  it("replaces workflow-owned context on the original command without duplicating it", () => {
    const command = '/lax submit {"repository":"https://github.com/alice/repo"}';
    const first = upsertCommandContext(
      command,
      77,
      appendWorkflowRun(`Update preview.\n\n${previewMarker(77)}`, run()),
    );
    const second = upsertCommandContext(first, 77, workflowRunMarker("987654321"));
    expect(readCommandContext(first, 77)).toContain("Update preview.");
    expect(second).toContain(command);
    expect(second).not.toContain("Update preview.");
    expect(second.match(/lax-command-context:77:start/gu)).toHaveLength(1);
    expect(parseWorkflowComment(second).runId).toBe("987654321");
    expect(visibleComment(first)).toContain(`${command}\n\nUpdate preview.`);
  });

  it("follows a command from its preview run id through its result", async () => {
    vi.stubEnv("LAX_POLL_INTERVAL_MS", "1");
    vi.stubEnv("LAX_WORKFLOW_TIMEOUT_MS", "1000");
    const preview = appendWorkflowRun(`Preview.\n\n${previewMarker(77)}`, run());
    const result = appendWorkflowRun(`Done.\n\n${resultMarker(77)}`, run(), "success");
    const paginate = vi
      .fn()
      .mockResolvedValueOnce([{ id: 1, body: preview, user: bot }])
      .mockResolvedValue([
        { id: 1, body: preview, user: bot },
        { id: 2, body: result, user: bot },
      ]);
    const previews: string[] = [];
    const outcome = await followCommand({ paginate } as unknown as GitHubClient, 42, 77, {
      onPreview: (text) => previews.push(text),
      since: "2026-07-30T10:00:00Z",
    });
    expect(paginate).toHaveBeenCalledTimes(2);
    expect(paginate).toHaveBeenCalledWith(
      "/repos/lax-archive/lax/issues/42/comments?since=2026-07-30T10%3A00%3A00Z",
    );
    expect(outcome.runId).toBe("123456789");
    expect(previews).toEqual(["Preview."]);
    expect(outcome.comment).toContain("Done.");
  });

  it("follows initialization until the correlated final comment", async () => {
    vi.stubEnv("LAX_POLL_INTERVAL_MS", "1");
    vi.stubEnv("LAX_WORKFLOW_TIMEOUT_MS", "1000");
    const result = appendWorkflowRun(
      `Initialized.\n\n${initializationMarker(42)}`,
      run(),
      "success",
    );
    const paginate = vi.fn().mockResolvedValue([{ id: 1, body: result, user: bot }]);
    const outcome = await followInitialization({ paginate } as unknown as GitHubClient, 42);
    expect(outcome.outcome).toBe("success");
    expect(outcome.runId).toBe("123456789");
    expect(outcome.comment).toContain("Initialized.");
  });
});

function run(): { id: string; url: string } {
  return {
    id: "123456789",
    url: "https://github.com/lax-archive/lax/actions/runs/123456789",
  };
}
