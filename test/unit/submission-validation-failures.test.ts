import { describe, expect, it } from "vitest";
import {
  compilationFailure,
  containerBoundaryFailure,
  replayFailure,
  submittedSourceFailure,
  validationExitCode,
} from "../../src/submission-validation/failures.js";

describe("submission validation failure ownership", () => {
  it("keeps ordinary compiler and kernel diagnostics as submission findings", () => {
    expect(compilationFailure("Main.lean:3:2: error: type mismatch", "compile failed"))
      .toMatchObject({ kind: "submission", retryable: false });
    expect(replayFailure("kernel rejected declaration Lax7.bad", "replay failed"))
      .toMatchObject({ kind: "submission", retryable: false });
  });

  it("recognizes read-only cache writes and missing replay artifacts as LAX failures", () => {
    expect(compilationFailure(
      "error: /deps/lax-7/concepts/package/.lake/build/lib/lean/Lax7.trace: Read-only file system",
      "compile failed",
    )).toMatchObject({ kind: "infrastructure", retryable: false });
    expect(compilationFailure(
      "error: /opt/lax/warm/.lake/packages/mathlib/.lake/build/lib/lean/Mathlib.olean.hash: EACCES",
      "compile failed",
    )).toMatchObject({ kind: "infrastructure", retryable: false });
    expect(replayFailure("unknown module prefix 'Lax7.NewModule'", "replay failed"))
      .toMatchObject({ kind: "infrastructure", retryable: false });
  });

  it("separates enforced capacity from container startup failures", () => {
    expect(containerBoundaryFailure(
      { code: 124, output: "", timedOut: true },
      "compile timed out",
      "compile ran out of memory",
    )).toMatchObject({ kind: "resource-limit", message: "compile timed out" });
    expect(containerBoundaryFailure(
      { code: 137, output: "Killed", timedOut: false },
      "compile timed out",
      "compile ran out of memory",
    )).toMatchObject({ kind: "resource-limit", message: "compile ran out of memory" });
    expect(containerBoundaryFailure(
      { code: 125, output: "Cannot connect to the Docker daemon", timedOut: false },
      "compile timed out",
      "compile ran out of memory",
    )).toMatchObject({ kind: "infrastructure", retryable: true });
  });

  it("treats source transport outages as retryable but bad source coordinates as authored", () => {
    expect(submittedSourceFailure(new Error("fatal: could not resolve host github.com")))
      .toMatchObject({ kind: "infrastructure", retryable: true });
    expect(submittedSourceFailure(new Error("requested commit is not present in the fetched repository")))
      .toMatchObject({ kind: "submission", retryable: false });
  });

  it("reserves exit 2 for a submission verdict and exit 1 for no verdict", () => {
    expect(validationExitCode({ ok: true })).toBe(0);
    expect(validationExitCode({ ok: false })).toBe(2);
    expect(validationExitCode({
      ok: false,
      failure: {
        kind: "resource-limit",
        retryable: false,
        phase: "compile-concepts",
        rule: "compile",
        message: "memory limit",
      },
    })).toBe(1);
  });
});
