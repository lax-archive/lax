import { describe, expect, it } from "vitest";
import { labelled, renderComment } from "../../src/cli/render.js";
import { appendWorkflowRun, resultMarker } from "../../src/shared/workflow-comments.js";

const run = { id: "31160822139", url: "https://github.com/lax-archive/lax/actions/runs/31160822139" };

describe("comment rendering for the terminal", () => {
  it("drops markers and the run link the CLI prints itself", () => {
    const body = appendWorkflowRun(
      `Updated **lax-14** from its validated immutable source.\n\n` +
        "Archive commit: `b1f7a5f`. The Website rebuild event was accepted.\n\n" +
        resultMarker(5001),
      run,
      "success",
    );
    expect(renderComment(body)).toBe(
      "Updated lax-14 from its validated immutable source.\n\n" +
        "Archive commit: b1f7a5f. The Website rebuild event was accepted.",
    );
  });

  it("keeps a fenced transcript verbatim, indented", () => {
    const body =
      "Submission validation failed for **lax-14**.\n\n" +
      "**compile-proofs** (`build`)\n\n" +
      "```text\nProofs/Main.lean:9:2: error: unsolved goals\n⊢ False\n```\n";
    expect(renderComment(body)).toBe(
      "Submission validation failed for lax-14.\n\n" +
        "compile-proofs (build)\n\n" +
        "    Proofs/Main.lean:9:2: error: unsolved goals\n" +
        "    ⊢ False",
    );
  });

  it("lets no escape sequence or hidden character through", () => {
    const body = "```text\n\u001b[31mred\u001b]0;title\u0007\n\u202ereversed\u200b\n```";
    const rendered = renderComment(body);
    expect(rendered).not.toMatch(/[\u001b\u202e\u200b]/u);
    expect(rendered).toContain("red");
  });

  it("renders links a terminal can act on and keeps list shape", () => {
    expect(renderComment("- see [the run](https://github.com/x/y/actions/runs/1)")).toBe(
      "- see the run (https://github.com/x/y/actions/runs/1)",
    );
  });

  it("labels the first line and indents the rest", () => {
    expect(labelled("lax submit", "first\n\nsecond")).toBe("lax submit: first\n\n  second");
  });
});
