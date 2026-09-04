import { describe, expect, it } from "vitest";
import {
  FINDING_MESSAGE_BYTES,
  FINDING_RULE_BYTES,
  oneLineMessage,
} from "../../src/submission-validation/artifact-schema.js";
import { FindingCollector } from "../../src/submission-validation/findings.js";
import {
  ONE_LINE_TAIL_BYTES,
  oneLineTail,
} from "../../src/submission-validation/paper/compile.js";

/** The rules the report schema enforces on a one-line field, restated here so
 * the test states the contract independently of the code that applies it. */
function schemaClean(value: string): boolean {
  return (
    value.trim() !== "" &&
    Buffer.byteLength(value, "utf8") <= FINDING_MESSAGE_BYTES &&
    value.normalize("NFC") === value &&
    !/[\u0000-\u001f\u007f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(value) &&
    !/[\ud800-\udfff]/u.test(value)
  );
}

describe("one-line finding messages", () => {
  it("satisfies every rule the report schema enforces on a message", () => {
    const hostile = [
      "line one\r\nline two\nline three",
      "a tab\there",
      "a page break \u000c and a DEL \u007f",
      "a zero width \u200b space and a bidi override \u202e",
      "a line separator \u2028 and a paragraph separator \u2029",
      "cafe\u0301.png",
      `a lone surrogate ${String.fromCharCode(0xd800)} here`,
      "\u0000\u0001",
    ];
    for (const value of hostile) {
      const message = oneLineMessage(value);
      expect({ value, clean: schemaClean(message) }).toEqual({ value, clean: true });
    }
    // NFD in, NFC out: the same file the author sees, spelled the one way the
    // schema accepts.
    expect(oneLineMessage("cafe\u0301.png")).toBe("café.png");
    // Line breaks stay visible; everything else the schema forbids becomes a
    // space, so words never run together.
    expect(oneLineMessage("line one\r\nline\ttwo")).toBe("line one ⏎ line two");
    // Text that sanitized away to nothing must still be a legal message.
    expect(oneLineMessage("  \t ")).toBe("(none)");
  });

  it("fits the byte budget by eliding the middle, keeping both informative ends", () => {
    const long = `the paper did not compile; the end of the transcript: ${"é".repeat(9_000)}END`;
    const fitted = oneLineMessage(long);
    expect(Buffer.byteLength(fitted, "utf8")).toBeLessThanOrEqual(FINDING_MESSAGE_BYTES);
    expect(fitted.startsWith("the paper did not compile")).toBe(true);
    expect(fitted.endsWith("END")).toBe(true);
    expect(fitted).toContain(" […] ");
    // Cut on a character boundary, never mid-sequence.
    expect(fitted).not.toContain("\ufffd");
    expect(fitted.normalize("NFC")).toBe(fitted);
  });

  it("keeps the end of a transcript tail, marked, under the tighter log budget", () => {
    const tail = oneLineTail("é".repeat(10_000), 12_000);
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(ONE_LINE_TAIL_BYTES);
    expect(tail.startsWith("[…] ")).toBe(true);
    expect(tail).not.toContain("\ufffd");
    expect(schemaClean(tail)).toBe(true);
  });
});

describe("finding collector", () => {
  it("sanitizes both halves of every finding it records", () => {
    const findings = new FindingCollector("paper");
    findings.warn("web-oracle", "the reader failed:\nexit 1");
    findings.violate("compile", "the paper did not compile:\r\n! Undefined control sequence");
    findings.warn(`rule\n${"x".repeat(400)}`, "a rule is a literal everywhere today");

    expect(findings.warnings[0]).toEqual({
      phase: "paper",
      rule: "web-oracle",
      message: "the reader failed: ⏎ exit 1",
    });
    expect(findings.violations[0]!.message).toBe(
      "the paper did not compile: ⏎ ! Undefined control sequence",
    );
    const trimmed = findings.warnings[1]!.rule;
    expect(Buffer.byteLength(trimmed, "utf8")).toBeLessThanOrEqual(FINDING_RULE_BYTES);
    expect(trimmed).not.toMatch(/[\r\n]/u);

    // Absorbing another collector moves already-sanitized findings, so the
    // guarantee survives the merge every phase does.
    const outer = new FindingCollector("emit");
    outer.absorb(findings);
    for (const finding of [...outer.warnings, ...outer.violations]) {
      expect(schemaClean(finding.rule)).toBe(true);
      expect(schemaClean(finding.message)).toBe(true);
    }
  });
});
