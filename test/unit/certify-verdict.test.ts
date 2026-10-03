// The one reading of `lake comparator`'s exit code (certify/verdict.ts):
// exit 0 certifies, exit 2 is the archive's problem, and the exit-1 shapes
// the spike measured (spike/axiomfree/REPORT.md) each become a `certify`
// violation that names what the comparator named and says it is a lax bug —
// including the one that is really a Lean error in the generated Solution.

import { describe, expect, it } from "vitest";
import { interpretComparatorRun } from "../../src/submission-validation/certify/verdict.js";

const transcript = (...lines: string[]): string => `${lines.join("\n")}\n`;

describe("the comparator verdict", () => {
  it("certifies on exit 0 whatever the transcript", () => {
    expect(interpretComparatorRun({ code: 0, output: "Your solution is okay!\n" })).toEqual({ kind: "certified" });
  });

  it("names the theorem whose statement differs", () => {
    const verdict = interpretComparatorRun({
      code: 1,
      output: transcript("Resolving dependencies", "error: Challenge and solution theorem statement do not match: 'Cert.Lax38Proofs.hasSucc'"),
    });
    expect(verdict).toMatchObject({ kind: "violation", rule: "statement-mismatch" });
    expect((verdict as { message: string }).message).toContain("Cert.Lax38Proofs.hasSucc");
    expect((verdict as { message: string }).message).toContain("report it as a lax bug");
  });

  it("names the illegal axiom, the shadowed constant, and a target that is no theorem", () => {
    expect(interpretComparatorRun({ code: 1, output: transcript("error: Illegal axiom detected: 'sorryAx'") }))
      .toMatchObject({ kind: "violation", rule: "illegal-axiom", message: expect.stringContaining("sorryAx") });
    expect(interpretComparatorRun({
      code: 1,
      output: transcript("error: Const does not match between challenge and target 'Lax38.Order.HasSucc'"),
    })).toMatchObject({ kind: "violation", rule: "constant-mismatch", message: expect.stringContaining("Lax38.Order.HasSucc") });
    expect(interpretComparatorRun({
      code: 1,
      output: transcript("error: Challenge and solution constant kind don't match: 'Cert.Lax38Proofs.hasSucc'"),
    })).toMatchObject({ kind: "violation", rule: "not-a-theorem" });
    expect(interpretComparatorRun({ code: 1, output: transcript("error: Solution constant is not a theorem: 'Cert.X.y'") }))
      .toMatchObject({ kind: "violation", rule: "not-a-theorem" });
    expect(interpretComparatorRun({ code: 1, output: transcript("error: Const not found in solution: 'Cert.X.y'") }))
      .toMatchObject({ kind: "violation", rule: "missing-constant" });
    expect(interpretComparatorRun({ code: 1, output: transcript("Lean default kernel rejected the solution", "error: Lean default exited with 1") }))
      .toMatchObject({ kind: "violation", rule: "kernel-rejected" });
  });

  it("tells a Solution that did not elaborate apart, quoting Lean", () => {
    const verdict = interpretComparatorRun({
      code: 1,
      output: transcript(
        "Building Solution",
        "error: Solution.lean:6:60: Type mismatch",
        "  trivial",
        "has type",
        "  True",
        "but is expected to have type",
        "  Lax38.Order.HasSucc",
        "error: build failed",
        "error: Child exited with 1",
      ),
    });
    expect(verdict).toMatchObject({ kind: "violation", rule: "solution-build" });
    const message = (verdict as { message: string }).message;
    expect(message).toContain("the generated Solution did not elaborate");
    expect(message).toContain("lax bug");
    expect(message).toContain("Solution.lean:6:60: Type mismatch");
  });

  it("reports exit 2 and anything else as the archive's failure, never a verdict", () => {
    const missing = interpretComparatorRun({
      code: 2,
      output: transcript("error: '/cert/project' has no `lake-manifest.json`, and `lake comparator` resolves dependencies inside a sandbox"),
    });
    expect(missing.kind).toBe("failure");
    if (missing.kind === "failure") {
      expect(missing.failure.kind).toBe("infrastructure");
      expect(missing.failure.message).toContain("could not start (exit 2)");
      expect(missing.failure.message).toContain("lake-manifest.json");
    }
    const odd = interpretComparatorRun({ code: 3, output: "" });
    expect(odd.kind).toBe("failure");
  });
});
