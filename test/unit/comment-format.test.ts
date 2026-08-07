import { describe, expect, it } from "vitest";
import { codeBlock, findingsMarkdown, safeInline, tail } from "../../src/shared/comment-format.js";
import type { ValidationFinding } from "../../src/submission-validation/contracts.js";

const finding = (
  phase: ValidationFinding["phase"],
  rule: string,
  message: string,
): ValidationFinding => ({ phase, rule, message });

describe("comment formatting", () => {
  it("keeps a compile transcript's lines inside a fenced block", () => {
    const transcript =
      "info: building Proofs.Main\nProofs/Main.lean:9:2: error: unsolved goals\n⊢ False";
    const markdown = findingsMarkdown([finding("compile-proofs", "build", transcript)], "none");
    expect(markdown).toBe(`**compile-proofs** (\`build\`)\n\n\`\`\`text\n${transcript}\n\`\`\``);
  });

  it("keeps one-line findings — bad manifest fields — as bullets", () => {
    const markdown = findingsMarkdown(
      [
        finding("source", "manifest", "manifest.yaml: `title` must not be empty"),
        finding("source", "manifest", "manifest.yaml: unknown key `athors`"),
      ],
      "none",
    );
    expect(markdown.split("\n\n")).toEqual([
      "- **source** (`manifest`): manifest.yaml: `title` must not be empty",
      "- **source** (`manifest`): manifest.yaml: unknown key `athors`",
    ]);
  });

  it("cannot be escaped by backticks in the transcript", () => {
    const block = codeBlock("```\nnot a fence\n````", 1_000);
    expect(block.startsWith("`````text\n")).toBe(true);
    expect(block.endsWith("\n`````")).toBe(true);
  });

  it("strips control characters but keeps the lines of a block", () => {
    expect(codeBlock("a\u0007b\r\nc", 1_000)).toBe("```text\na b\nc\n```");
    expect(safeInline("a\nb\u0000 <script> @alice", 100)).toBe("a b script @\u200balice");
  });

  it("keeps the end of an over-long transcript", () => {
    const long = Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n");
    const kept = tail(long, 200);
    expect(kept.startsWith("[…earlier output omitted…]\n")).toBe(true);
    expect(kept.endsWith("line 499")).toBe(true);
    expect(kept.length).toBeLessThanOrEqual(200 + "[…earlier output omitted…]\n".length);
  });

  it("says so when it lists only some findings", () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      finding("inspect", "unproved", `statement ${index} is not proved`));
    const markdown = findingsMarkdown(many, "none");
    expect(markdown).toContain("statement 0 is not proved");
    expect(markdown).toContain("10 further findings omitted");
    expect(markdown.length).toBeLessThan(65_536);
  });

  it("falls back when a failed validation produced no finding at all", () => {
    expect(findingsMarkdown([], "Validation failed without a structured finding.")).toBe(
      "- Validation failed without a structured finding.",
    );
  });
});
