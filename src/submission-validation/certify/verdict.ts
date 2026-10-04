// The one reading of `lake comparator`'s exit code and transcript
// (history/audit-20260903.md: a rule lives at its boundary, not at the call
// sites). Both paths — the trusted judge container C and the local host run —
// hand their result here and act on the verdict; neither inspects the
// transcript itself.
//
// `lake comparator` (Lake/CLI/Check.lean, v4.35.0-rc3): exit 0 is the
// verdict; exit 1 is a rejection — a statement mismatch, an illegal axiom, a
// kernel rejection, or, when the comparator builds itself, a build that did
// not succeed (`Child exited with 1` after the Lean errors) — reported as
// one `error: …` line on stderr; exit 2 is "could not start": no manifest, no
// export file, no configuration, no bubblewrap. Both lax paths hand the
// comparator two finished exports, so it builds nothing and the Solution's
// own build failure is the phase's `solution-build` violation before the
// judge ever runs; the `Child exited` shape stays readable here for a
// comparator driven by hand. The validator has already accepted every proof
// the Challenge states, so an exit 1 is lax and the toolchain disagreeing: a
// violation on the `certify` phase that names the edge and says so, so a
// fixture dying in elaboration is noticed as such and never passes as a
// content verdict.

import type { FindingIntent } from "../contracts.js";
import { infrastructureFailure, type PipelineFailure } from "../failures.js";

/** Every refusal the comparator utters is the judge's: the proof does not
 * establish the edge the Challenge states (decision 10). */
export type ComparatorVerdict =
  | { kind: "certified" }
  | { kind: "violation"; rule: string; message: string; intent: FindingIntent }
  | { kind: "failure"; failure: PipelineFailure };

const ERROR_LINE = /^error: (.*)$/u;

/** The comparator's own error lines, in order; the last one is the verdict. */
function errorLines(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .map((line) => ERROR_LINE.exec(line.trim())?.[1])
    .filter((line): line is string => line !== undefined);
}

const REPORT =
  "the archive's validator accepted this record and the toolchain's `lake comparator` refused the certificate " +
  "lax generated for it; if your package builds cleanly with `lax build`, report it as a lax bug, quoting this message";

/** The transcript's lines, trimmed: the comparator's own stdout notices
 * (`<kernel> kernel rejected the solution`) live beside its `error:` lines. */
function lines(output: string): string[] {
  return output.split(/\r?\n/u).map((line) => line.trim());
}

/** The whole transcript, trimmed, for the message a finding carries. */
function transcript(output: string): string {
  return output.trim();
}

export function interpretComparatorRun(result: { code: number; output: string }): ComparatorVerdict {
  if (result.code === 0) return { kind: "certified" };
  const errors = errorLines(result.output);
  const last = errors.at(-1) ?? "";
  if (result.code === 2) {
    return {
      kind: "failure",
      failure: infrastructureFailure(
        `\`lake comparator\` could not start (exit 2): ${last || transcript(result.output) || "no output"}`,
      ),
    };
  }
  if (result.code !== 1) {
    return {
      kind: "failure",
      failure: infrastructureFailure(
        `\`lake comparator\` exited with ${result.code}, which is neither a verdict nor a refusal to start:\n${transcript(result.output)}`,
      ),
    };
  }
  let match: RegExpExecArray | null;
  if ((match = /^Challenge and solution theorem statement do not match: '(.+)'$/u.exec(last)) !== null) {
    return {
      kind: "violation",
      intent: "judge",
      rule: "statement-mismatch",
      message:
        `certificate theorem ${match[1]} does not state the same proposition in the Challenge (over the concept ` +
        `packages alone) and in the Solution (over the proof package): \`${last}\`; ${REPORT}`,
    };
  }
  if (
    (match = /^Challenge and solution constant kind don't match: '(.+)'$/u.exec(last)) !== null ||
    (match = /^Solution constant is not a theorem: '(.+)'$/u.exec(last)) !== null
  ) {
    return {
      kind: "violation",
      intent: "judge",
      rule: "not-a-theorem",
      message: `certificate theorem ${match[1]} is not a theorem in the Solution: \`${last}\`; ${REPORT}`,
    };
  }
  if ((match = /^Const not found in (challenge|solution): '(.+)'$/u.exec(last)) !== null) {
    return {
      kind: "violation",
      intent: "judge",
      rule: "missing-constant",
      message: `the ${match[1]} export lacks ${match[2]}: \`${last}\`; ${REPORT}`,
    };
  }
  if ((match = /^Const does not match between challenge and target '(.+)'$/u.exec(last)) !== null) {
    return {
      kind: "violation",
      intent: "judge",
      rule: "constant-mismatch",
      message:
        `${match[1]} is not the same constant in the Challenge's environment and in the Solution's — a proof ` +
        `package may not redeclare or shadow what the certificate names: \`${last}\`; ${REPORT}`,
    };
  }
  if ((match = /^Illegal axiom detected: '(.+)'$/u.exec(last)) !== null) {
    return {
      kind: "violation",
      intent: "judge",
      rule: "illegal-axiom",
      message:
        `the Solution's proofs rest on the axiom ${match[1]}, which is not one of the background three the ` +
        `certificate permits: \`${last}\`; ${REPORT}`,
    };
  }
  // `Child exited with N` is the comparator's own child — the Solution
  // build or the exporter — and is read before the kernel shapes, which
  // end the same way (`<kernel> exited with N`).
  const child = /^Child exited with (\d+)$/u.exec(last);
  if (child !== null) {
    // a child that did not exit 1 did not fail its job, it crashed or was
    // killed (134 is abort, 128+n a signal): nothing was judged
    if (child[1] !== "1") {
      return {
        kind: "failure",
        failure: infrastructureFailure(
          `the comparator's child stopped with exit ${child[1]}, which is a crash or a kill, not a build failure:\n${transcript(result.output)}`,
        ),
      };
    }
    const lean = errors.slice(0, -1);
    return {
      kind: "violation",
      intent: "judge",
      rule: "solution-build",
      message:
        "the generated Solution did not elaborate — the certificate lax wrote from the proofs' telescopes does " +
        "not apply the proofs the way Lean reads them, so lax's generator and classifier disagree with Lean; " +
        `${REPORT}. Lean said:\n${lean.length > 0 ? lean.map((line) => `error: ${line}`).join("\n") : transcript(result.output)}`,
    };
  }
  // A kernel's nonzero exit is `<kernel> exited with N` after the
  // comparator's own notice `<kernel> kernel rejected the solution`
  // (Lake/CLI/Check.lean runExternalKernel). The comparator says "rejected"
  // for every nonzero exit, a crash included, so the notice is the most it
  // can vouch for; without it — a launch failure, `Error while interacting
  // with … kernel`, any other stop — nothing was judged, and that is the
  // archive's failure to retry, never a finding against the author (codex
  // review 2026-10-04, finding 6; Palomar's reading of the same tool). When
  // Lean's own kernel accepted and a `--paranoid` checker did not, that is
  // a kernel disagreement for a maintainer to examine, not a verdict.
  const exited = /^(.+) exited with (\d+)$/u.exec(last);
  if (exited !== null) {
    const kernel = exited[1]!;
    const code = exited[2]!;
    const all = lines(result.output);
    if (all.includes(`${kernel} kernel rejected the solution`)) {
      // The notice is printed for *every* nonzero exit — Check.lean
      // runExternalKernel: `IO.println s!"{kernelName} kernel rejected the
      // solution"` then `return some s!"{kernelName} exited with {ret}"` —
      // so it does not tell a rejection from a crash. The kernels reject
      // with exit 1; 134 is abort, 128+n a signal, anything else
      // undocumented: a kernel that stopped that way judged nothing (codex
      // review 2 2026-10-04, "earlier fixes that remain incomplete").
      if (code !== "1") {
        return {
          kind: "failure",
          failure: infrastructureFailure(
            `the ${kernel} kernel stopped with exit ${code}, which is a crash or a kill rather than a rejection ` +
              `(a kernel rejects with exit 1), so nothing was judged:\n${transcript(result.output)}`,
          ),
        };
      }
      if (kernel !== "Lean default" && all.includes("Lean default kernel accepts the solution")) {
        return {
          kind: "failure",
          failure: infrastructureFailure(
            `kernel disagreement: Lean's kernel accepted the Solution and ${kernel} did not (\`${last}\`); ` +
              `a maintainer examines this, it is not a verdict on the submission:\n${transcript(result.output)}`,
          ),
        };
      }
      return {
        kind: "violation",
        intent: "judge",
        rule: "kernel-rejected",
        message: `${kernel}'s kernel rejected the Solution's proofs: \`${last}\`; ${REPORT}`,
      };
    }
    return {
      kind: "failure",
      failure: infrastructureFailure(
        `the ${kernel} kernel stopped without the comparator's rejection notice (\`${last}\`), so nothing was ` +
          `judged:\n${transcript(result.output)}`,
      ),
    };
  }
  if (/^Error while interacting with .* kernel/u.test(last)) {
    return {
      kind: "failure",
      failure: infrastructureFailure(`a kernel could not be run, so nothing was judged: \`${last}\`\n${transcript(result.output)}`),
    };
  }
  return {
    kind: "violation",
    intent: "judge",
    rule: "comparator",
    message: `\`lake comparator\` rejected the certificate: ${last || transcript(result.output)}; ${REPORT}`,
  };
}
