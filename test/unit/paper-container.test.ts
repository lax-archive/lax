// The trusted paper compiler's container invocation, through the runner
// seam: the TeX image is verified by its own pin before anything runs in it,
// and the container sees exactly the compile copy (writable), the marker
// package directory (read-only), and the compile environment — nothing of the
// Lean runtime. The command line is the one every executor shares
// (paper/compile.ts), so only the container-specific shape is asserted here.

import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../../src/submission-validation/config.js";
import { latexmkArguments } from "../../src/submission-validation/paper/compile.js";
import { containerPaperCompiler, PAPER_CONTAINER_PATHS } from "../../src/submission-validation/paper/container.js";
import { PAPER_IMAGE, PAPER_IMAGE_DIGEST } from "../../src/submission-validation/pins.js";
import type {
  ContainerInvocation,
  ContainerResult,
  ValidationRunner,
} from "../../src/submission-validation/sandbox/container.js";

function recordingRunner(result: Partial<ContainerResult> = {}): ValidationRunner & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async run(invocation: ContainerInvocation): Promise<ContainerResult> {
      calls.push(invocation);
      return { code: 0, output: "latexmk transcript", timedOut: false, ...result };
    },
    async verifyRuntime(): Promise<void> {
      calls.push("verify-runtime");
    },
    async verifyImage(image): Promise<void> {
      calls.push(`verify-image ${image.image} ${image.imageDigest}`);
    },
  };
}

describe("container paper compiler", () => {
  it("verifies the pinned TeX image, then compiles in it with only the paper mounts", async () => {
    const runner = recordingRunner();
    const compile = containerPaperCompiler(runner, DEFAULT_LIMITS, "/host/assets/tex");
    const args = latexmkArguments("xelatex", "main.tex");
    const result = await compile("/host/job/paper/src", args, 1_700_000_000);

    expect(result).toEqual({ code: 0, output: "latexmk transcript", timedOut: false });
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]).toBe(`verify-image ${PAPER_IMAGE} ${PAPER_IMAGE_DIGEST}`);
    const invocation = runner.calls[1] as ContainerInvocation;
    expect(invocation).toEqual({
      label: "paper-compile",
      image: { image: PAPER_IMAGE, imageDigest: PAPER_IMAGE_DIGEST },
      args: ["latexmk", ...args],
      mounts: [
        { source: "/host/job/paper/src", target: PAPER_CONTAINER_PATHS.work, writable: true },
        { source: "/host/assets/tex", target: PAPER_CONTAINER_PATHS.tex },
      ],
      workdir: PAPER_CONTAINER_PATHS.work,
      env: {
        // non-recursive, the in-container sty directory, TeX Live's default path appended
        TEXINPUTS: `${PAPER_CONTAINER_PATHS.tex}:`,
        SOURCE_DATE_EPOCH: "1700000000",
        FORCE_SOURCE_DATE: "1",
        HOME: "/tmp",
      },
      timeoutMs: DEFAULT_LIMITS.paperCompileTimeoutMs,
      maxOutputBytes: DEFAULT_LIMITS.maxOutputBytes,
    });
    // never the Lean network or a PATH of its own
    expect(invocation.network).toBeUndefined();
    expect(invocation.env).not.toHaveProperty("PATH");
  });

  it("hands the runner's verdict back, including a timeout", async () => {
    const runner = recordingRunner({ code: 137, output: "killed", timedOut: true });
    const compile = containerPaperCompiler(runner, DEFAULT_LIMITS, "/host/assets/tex");
    await expect(compile("/host/job/paper/src", latexmkArguments("pdflatex", "main.tex"), 0)).resolves.toEqual({
      code: 137,
      output: "killed",
      timedOut: true,
    });
  });
});
