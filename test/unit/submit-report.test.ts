// The submit report's paper row (TODO "Paper layer" follow-up): a manifest
// that declares a paper gets the row the local build shows, settled with
// the archive's own numbers from the validation report; flows that cannot
// know up front (resume, explicit source) surface the same facts as a
// closing aside. The vocabulary is `lax build`'s, plus the web view's fate.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { paperSummary, SubmitReport } from "../../src/cli/commands.js";
import * as ui from "../../src/cli/ui.js";
import type { RemoteValidationReport } from "../../src/cli/run-artifacts.js";
import type { ValidationFinding } from "../../src/submission-validation/contracts.js";

function okReport(overrides: Partial<RemoteValidationReport> = {}): RemoteValidationReport {
  return { ok: true, warnings: [], violations: [], ...overrides };
}

/** Everything `ui` printed, ANSI-free. */
function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  });
  const errors = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(((chunk: string | Uint8Array): boolean => {
      lines.push(...String(chunk).replace(/\n$/u, "").split("\n"));
      return true;
    }) as typeof process.stderr.write);
  return {
    lines,
    restore: () => {
      log.mockRestore();
      errors.mockRestore();
    },
  };
}

describe("the submit report's paper row", () => {
  beforeEach(() => {
    ui.configure({ color: false });
  });

  it("settles the declared row with the archive's numbers, between the archive rows", async () => {
    const output = capture();
    try {
      const submit = new SubmitReport("lax-61", { local: false, account: false, source: false, paper: true });
      const follow = submit.follow();
      follow.onStage?.({ row: "validate", detail: "Compile" });
      await follow.onValidationReport?.(okReport({ paper: { pages: 6, marks: 12, webBytes: 1_258_291 } }));
      follow.onStage?.({ row: "publish" });
      submit.succeed();
    } finally {
      output.restore();
    }
    const text = output.lines.join("\n");
    expect(text).toContain("✓ Compiled the paper");
    expect(text).toContain("6 pages · 12 marks · web view derived (1.2 MiB)");
    expect(text.indexOf("Rebuilt in the archive")).toBeLessThan(text.indexOf("Compiled the paper"));
    expect(text.indexOf("Compiled the paper")).toBeLessThan(text.indexOf("Wrote the public record"));
    // The facts settle the row; no aside repeats them.
    expect(text).not.toContain("Paper  ");
  });

  it("carries the facts as a closing aside when no row was declared", async () => {
    const output = capture();
    try {
      const submit = new SubmitReport("lax-61", { local: false, account: false, source: false });
      const follow = submit.follow();
      await follow.onValidationReport?.(okReport({ paper: { pages: 6, marks: 12 } }));
      submit.succeed();
    } finally {
      output.restore();
    }
    const text = output.lines.join("\n");
    expect(text).not.toContain("Compiled the paper");
    expect(text).toContain("Paper  6 pages · 12 marks");
    expect(text.indexOf("lax-61 is a draft")).toBeLessThan(text.indexOf("Paper  "));
  });

  it("hides a declared row that never got its facts", async () => {
    const output = capture();
    try {
      const submit = new SubmitReport("lax-61", { local: false, account: false, source: false, paper: true });
      const follow = submit.follow();
      follow.onStage?.({ row: "validate" });
      // The report never arrives (upload lag past the window); publish begins.
      follow.onStage?.({ row: "publish" });
      submit.succeed();
    } finally {
      output.restore();
    }
    const text = output.lines.join("\n");
    expect(text).not.toContain("Compiled the paper");
    expect(text).not.toContain("Compiling the paper");
    expect(text).toContain("Wrote the public record");
  });

  it("hides the declared row on a failed validation", async () => {
    const output = capture();
    try {
      const submit = new SubmitReport("lax-61", { local: false, account: false, source: false, paper: true });
      const follow = submit.follow();
      follow.onStage?.({ row: "validate" });
      expect(() =>
        follow.onValidationReport?.({
          ok: false,
          warnings: [],
          violations: [{ phase: "paper", rule: "compile", message: "the paper did not compile" }],
        }),
      ).toThrow("did not pass the archive's checks");
    } finally {
      output.restore();
    }
    const text = output.lines.join("\n");
    expect(text).not.toContain("Compiling the paper");
    expect(text).toContain("lax-61 was not published");
  });
});

describe("the submit report's warnings", () => {
  beforeEach(() => {
    ui.configure({ color: false });
  });

  it("prints a warning both runs found exactly once", async () => {
    const superseded: ValidationFinding = {
      phase: "resolution",
      rule: "superseded-dependency",
      message: "lax-3 (Lax3) is superseded by lax-12 — consider building on the latest version",
    };
    const output = capture();
    try {
      const submit = new SubmitReport("lax-61", { local: false, account: false, source: false });
      // The local build and the archive check the same things against the
      // same archive, so the same warning arrives twice.
      submit.carry([superseded]);
      const follow = submit.follow();
      await follow.onValidationReport?.(
        okReport({
          warnings: [superseded, { phase: "inspect", rule: "abstract", message: "short" }],
        }),
      );
      submit.succeed();
    } finally {
      output.restore();
    }
    const text = output.lines.join("\n");
    expect(text.split(superseded.message).length - 1).toBe(1);
    expect(text).toContain("2 warnings");
    expect(text).not.toContain("1 warning\n");
  });
});

describe("the paper summary vocabulary", () => {
  it("matches the local build's row and names the web view's fate", () => {
    expect(paperSummary({ pages: 1, marks: 1 }, [])).toBe("1 page · 1 mark");
    expect(paperSummary({ pages: 6, marks: 12 }, [])).toBe("6 pages · 12 marks");
    expect(paperSummary({ pages: 6, marks: 12, webBytes: 123_456 }, [])).toBe(
      "6 pages · 12 marks · web view derived (0.1 MiB)",
    );
    // A web-* warning is the skip signal; its reason rides the notes block.
    expect(
      paperSummary({ pages: 6, marks: 12 }, [
        { phase: "paper", rule: "web-oracle", message: "the streams diverge" },
      ]),
    ).toBe("6 pages · 12 marks · web view skipped");
    // No bundle and no web warning: the manifest opted out, and the summary
    // stays as silent about it as the derivation was.
    expect(
      paperSummary({ pages: 6, marks: 12 }, [
        { phase: "inspect", rule: "abstract", message: "short" },
      ]),
    ).toBe("6 pages · 12 marks");
  });
});
