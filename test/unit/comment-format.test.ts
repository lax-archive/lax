import { describe, expect, it } from "vitest";
import { safeInline, safeTranscript, tail } from "../../src/shared/comment-format.js";

describe("comment formatting", () => {
  it("defuses one line of untrusted text", () => {
    expect(safeInline("a\nb\u0000 <script> @alice", 100)).toBe("a b script @\u200balice");
  });

  it("strips control characters but keeps a transcript's lines", () => {
    expect(safeTranscript("a\u0007b\r\nc", 1_000)).toBe("a b\nc");
  });

  it("keeps the end of an over-long transcript", () => {
    const long = Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n");
    const kept = tail(long, 200);
    expect(kept.startsWith("[…earlier output omitted…]\n")).toBe(true);
    expect(kept.endsWith("line 499")).toBe(true);
    expect(kept.length).toBeLessThanOrEqual(200 + "[…earlier output omitted…]\n".length);
  });
});
