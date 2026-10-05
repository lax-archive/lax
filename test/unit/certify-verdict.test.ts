// The one reading of `lake comparator`'s exit code (certify/verdict.ts):
// exit 0 certifies, exit 2 is the archive's problem, and the exit-1 shapes
// the spike measured (spike/axiomfree/REPORT.md) each become a `certify`
// violation that names what the comparator named and says it is a lax bug —
// including the one that is really a Lean error in the generated Solution.

import { describe, expect, it } from "vitest";
import { interpretComparatorRun, validationVerdict } from "../../src/submission-validation/certify/verdict.js";

const transcript = (...lines: string[]): string => `${lines.join("\n")}\n`;

describe("the comparator verdict", () => {
  it("certifies on exit 0 whatever the transcript", () => {
    expect(interpretComparatorRun({ code: 0, output: "Your solution is okay!\n" })).toEqual({ kind: "certified" });
  });

  it("names the theorem whose statement differs", () => {
    const verdict = interpretComparatorRun({
      code: 1,
      output: transcript("Resolving dependencies", "error: Challenge and solution theorem statement do not match: 'Lax38Proofs.hasSucc'"),
    });
    expect(verdict).toMatchObject({ kind: "violation", rule: "statement-mismatch", intent: "judge" });
    expect((verdict as { message: string }).message).toContain("Lax38Proofs.hasSucc");
    expect((verdict as { message: string }).message).toContain("report it as a lax bug");
  });

  it("makes validation's sorryAx refusal the archive's failure, and leaves every other reading as it is", () => {
    // validation judges only proofs the inspector did not record pending, so
    // a `sorryAx` refusal there is the inspector and the judge disagreeing
    const sorry = validationVerdict({ code: 1, output: transcript("error: Illegal axiom detected: 'sorryAx'") });
    expect(sorry).toMatchObject({ kind: "failure", failure: { kind: "infrastructure", message: expect.stringContaining("did not record as pending") } });
    expect((sorry as { failure: { message: string } }).failure.message).toContain("this is a lax bug, not a fault of the submission");
    // an author's own axiom stays the author's refusal
    expect(validationVerdict({ code: 1, output: transcript("error: Illegal axiom detected: 'Lax38Proofs.cheat'") }))
      .toMatchObject({ kind: "violation", rule: "illegal-axiom", message: expect.stringContaining("Lax38Proofs.cheat") });
    // only the last error line is the verdict: a sorryAx mentioned earlier is not it
    expect(validationVerdict({
      code: 1,
      output: transcript("error: Illegal axiom detected: 'sorryAx'", "error: Challenge and solution theorem statement do not match: 'Lax38Proofs.hasSucc'"),
    })).toMatchObject({ kind: "violation", rule: "statement-mismatch" });
    for (const output of ["Your solution is okay!\n", transcript("error: Child exited with 134")]) {
      for (const code of [0, 1]) expect(validationVerdict({ code, output })).toEqual(interpretComparatorRun({ code, output }));
    }
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
      output: transcript("error: Challenge and solution constant kind don't match: 'Lax38Proofs.hasSucc'"),
    })).toMatchObject({ kind: "violation", rule: "not-a-theorem" });
    expect(interpretComparatorRun({ code: 1, output: transcript("error: Solution constant is not a theorem: 'Cert.X.y'") }))
      .toMatchObject({ kind: "violation", rule: "not-a-theorem" });
    expect(interpretComparatorRun({ code: 1, output: transcript("error: Const not found in solution: 'Cert.X.y'") }))
      .toMatchObject({ kind: "violation", rule: "missing-constant" });
    expect(interpretComparatorRun({ code: 1, output: transcript("Lean default kernel rejected the solution", "error: Lean default exited with 1") }))
      .toMatchObject({ kind: "violation", rule: "kernel-rejected", intent: "judge" });
  });

  it("reserves kernel-rejected for the comparator's own rejection notice; a kernel that did not run is the archive's failure", () => {
    // the exit line without the notice: a crash, an OOM, a sandbox refusal
    const silent = interpretComparatorRun({ code: 1, output: transcript("Running Lean default kernel on solution", "error: Lean default exited with 137") });
    expect(silent.kind).toBe("failure");
    if (silent.kind === "failure") {
      expect(silent.failure.kind).toBe("infrastructure");
      expect(silent.failure.message).toContain("nothing was judged");
    }
    // the launch failure the comparator reports as an exception
    const launch = interpretComparatorRun({
      code: 1,
      output: transcript("Error while interacting with nanoda kernel", "error: Error while interacting with nanoda kernel: no such file or directory (error code: 2)"),
    });
    expect(launch.kind).toBe("failure");
    if (launch.kind === "failure") expect(launch.failure.message).toContain("could not be run");
    // Lean's kernel accepted, an independent checker did not: a disagreement to examine
    const disagreement = interpretComparatorRun({
      code: 1,
      output: transcript("Lean default kernel accepts the solution", "nanoda kernel rejected the solution", "error: nanoda exited with 1"),
    });
    expect(disagreement.kind).toBe("failure");
    if (disagreement.kind === "failure") expect(disagreement.failure.message).toContain("kernel disagreement");
    // the rejection itself does not presume a lax bug any more
    const rejected = interpretComparatorRun({ code: 1, output: transcript("Lean default kernel rejected the solution", "error: Lean default exited with 1") });
    expect((rejected as { message: string }).message).toContain("builds cleanly with `lax build`");
  });

  it("a kernel or a child that did not exit 1 crashed or was killed; the rejection notice does not make it a verdict", () => {
    // the comparator prints its notice for every nonzero exit (Check.lean
    // runExternalKernel), so the exit code is what tells a rejection apart
    for (const code of ["134", "137", "255"]) {
      const crash = interpretComparatorRun({ code: 1, output: transcript("Lean default kernel rejected the solution", `error: Lean default exited with ${code}`) });
      expect(crash.kind, code).toBe("failure");
      if (crash.kind === "failure") {
        expect(crash.failure.kind).toBe("infrastructure");
        expect(crash.failure.message).toContain("crash or a kill");
      }
    }
    // a paranoid checker that crashed is not a disagreement either
    const paranoid = interpretComparatorRun({
      code: 1,
      output: transcript("Lean default kernel accepts the solution", "nanoda kernel rejected the solution", "error: nanoda exited with 134"),
    });
    expect(paranoid.kind).toBe("failure");
    if (paranoid.kind === "failure") expect(paranoid.failure.message).toContain("crash or a kill");
    // the comparator's own child (the build, the exporter) likewise
    const child = interpretComparatorRun({ code: 1, output: transcript("error: Child exited with 134") });
    expect(child.kind).toBe("failure");
    if (child.kind === "failure") expect(child.failure.message).toContain("crash or a kill");
    expect(interpretComparatorRun({ code: 1, output: transcript("error: Child exited with 1") })).toMatchObject({ kind: "violation", rule: "comparator-build" });
  });

  it("tells a module the comparator could not build apart, quoting Lean, as the translation's question", () => {
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
    // a reader's source-mode rerun: the archive's own judge builds nothing
    expect(verdict).toMatchObject({ kind: "violation", rule: "comparator-build", intent: "translation" });
    const message = (verdict as { message: string }).message;
    expect(message).toContain("could not build the Challenge or the solution module");
    expect(message).toContain("lax bug");
    expect(message).toContain("Solution.lean:6:60: Type mismatch");
  });

  it("words a build failure truthfully for a relative certificate, whose files the archive never built", () => {
    // `lax certify <statement> --run` over an ill-typed composition: the
    // Solution.lean is lax's local composition, not anything the archive judged
    const verdict = interpretComparatorRun({
      code: 1,
      output: transcript(
        "Building Solution",
        "error: Solution.lean:9:2: Application type mismatch",
        "error: build failed",
        "error: Child exited with 1",
      ),
    });
    expect(verdict).toMatchObject({ kind: "violation", rule: "comparator-build", intent: "translation" });
    const message = (verdict as { message: string }).message;
    expect(message).toContain("the solution module lax generated or named");
    expect(message).not.toContain("the archive built and judged");
    expect(message).toContain("Solution.lean:9:2: Application type mismatch");
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
