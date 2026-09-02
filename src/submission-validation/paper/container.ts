// The trusted executor of the paper phase: latexmk inside the pinned TeX Live
// image (pins.ts, PAPER_IMAGE), through the same hardened ContainerRunner the
// Lean phases use — read-only root, no capabilities, no network, memory and
// pid caps, the workspace watchdog — but from a second image that carries
// no Lean and mounts none of the Lean runtime. The container sees exactly
// three things: the job's compile copy of the paper folder (writable, it is
// where latexmk writes), the directory holding the archive's marker packages
// (`laxmark.sty`, `laxreflow.sty`) and nothing else (read-only, on
// TEXINPUTS), and /tmp. The arguments and environment are the
// ones paper/compile.ts gives every executor; the host path (host/paper.ts)
// runs the same command with the machine's own latexmk.

import type { ValidationLimits } from "../config.js";
import { PAPER_IMAGE, PAPER_IMAGE_DIGEST } from "../pins.js";
import type { ContainerImage, ValidationRunner } from "../sandbox/container.js";
import { paperCompileEnvironment } from "./compile.js";
import type { PaperCompiler } from "./phase.js";

/** The digest-pinned TeX Live image as the runner wants it. */
export function paperImage(): ContainerImage {
  return { image: PAPER_IMAGE, imageDigest: PAPER_IMAGE_DIGEST };
}

/** Stable in-container paths of the paper compile's two mounts. */
export const PAPER_CONTAINER_PATHS = {
  /** The compile copy of `paper.folder`; latexmk's working directory. */
  work: "/paper",
  /** The directory holding the marker packages (`laxmark.sty`,
   * `laxreflow.sty`), on TEXINPUTS. */
  tex: "/opt/lax/tex",
} as const;

/**
 * The container compiler. Pulls the TeX image on first use (only a
 * paper-bearing submission ever pays for it) and asserts its pinned digest
 * before anything runs in it. `HOME=/tmp` because the runner's `--user` has
 * no home directory in the image and luaotfload/mktexfmt want one.
 */
export function containerPaperCompiler(
  runner: ValidationRunner,
  limits: ValidationLimits,
  styDir: string,
): PaperCompiler {
  return async (cwd, args, sourceDateEpoch) => {
    const image = paperImage();
    await runner.verifyImage(image);
    const result = await runner.run({
      label: "paper-compile",
      image,
      args: ["latexmk", ...args],
      mounts: [
        { source: cwd, target: PAPER_CONTAINER_PATHS.work, writable: true },
        { source: styDir, target: PAPER_CONTAINER_PATHS.tex },
      ],
      workdir: PAPER_CONTAINER_PATHS.work,
      env: { ...paperCompileEnvironment(PAPER_CONTAINER_PATHS.tex, sourceDateEpoch), HOME: "/tmp" },
      timeoutMs: limits.paperCompileTimeoutMs,
      maxOutputBytes: limits.maxOutputBytes,
    });
    return { code: result.code, output: result.output, timedOut: result.timedOut };
  };
}
