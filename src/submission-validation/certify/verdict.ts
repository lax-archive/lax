// The one reading of `lake comparator`'s exit code and transcript
// (history/audit-20260903.md: a rule lives at its boundary, not at the call
// sites). Both paths — the trusted container B and the local host run —
// hand their result here and act on the verdict; neither inspects the
// transcript itself.
//
// `lake comparator` (Lake/CLI/Check.lean, v4.35.0-rc3): exit 0 is the
// verdict; exit 1 is a rejection — a statement mismatch, an illegal axiom, a
// kernel rejection, or a build that did not succeed (`Child exited with 1`
// after the Lean errors) — reported as one `error: …` line on stderr; exit 2
// is "could not start": no manifest, no export file, no configuration, no
// bubblewrap. The validator has already accepted every proof the Challenge
// states, so an exit 1 is lax and the toolchain disagreeing: a violation on
// the `certify` phase that names the edge and says so, so a fixture dying in
// elaboration is noticed as such and never passes as a content verdict.

import { infrastructureFailure, type PipelineFailure } from "../failures.js";

export type ComparatorVerdict =
  | { kind: "certified" }
  | { kind: "violation"; rule: string; message: string }
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
  "lax generated for it, which is a disagreement between lax and Lean: please report it as a lax bug, quoting this message";

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
      rule: "not-a-theorem",
      message: `certificate theorem ${match[1]} is not a theorem in the Solution: \`${last}\`; ${REPORT}`,
    };
  }
  if ((match = /^Const not found in (challenge|solution): '(.+)'$/u.exec(last)) !== null) {
    return {
      kind: "violation",
      rule: "missing-constant",
      message: `the ${match[1]} export lacks ${match[2]}: \`${last}\`; ${REPORT}`,
    };
  }
  if ((match = /^Const does not match between challenge and target '(.+)'$/u.exec(last)) !== null) {
    return {
      kind: "violation",
      rule: "constant-mismatch",
      message:
        `${match[1]} is not the same constant in the Challenge's environment and in the Solution's — a proof ` +
        `package may not redeclare or shadow what the certificate names: \`${last}\`; ${REPORT}`,
    };
  }
  if ((match = /^Illegal axiom detected: '(.+)'$/u.exec(last)) !== null) {
    return {
      kind: "violation",
      rule: "illegal-axiom",
      message:
        `the Solution's proofs rest on the axiom ${match[1]}, which is not one of the background three the ` +
        `certificate permits: \`${last}\`; ${REPORT}`,
    };
  }
  // `Child exited with N` is the comparator's own child — the Solution
  // build or the exporter — and is read before the kernel shapes, which
  // end the same way (`<kernel> exited with N`).
  if (/^Child exited with \d+$/u.test(last)) {
    const lean = errors.slice(0, -1);
    return {
      kind: "violation",
      rule: "solution-build",
      message:
        "the generated Solution did not elaborate — the certificate lax wrote from the proofs' telescopes does " +
        "not apply the proofs the way Lean reads them, so lax's generator and classifier disagree with Lean; " +
        `${REPORT}. Lean said:\n${lean.length > 0 ? lean.map((line) => `error: ${line}`).join("\n") : transcript(result.output)}`,
    };
  }
  if (/kernel rejected the solution|exited with \d+$|Error while interacting with .* kernel/u.test(last)) {
    return {
      kind: "violation",
      rule: "kernel-rejected",
      message: `a kernel rejected the Solution's proofs: \`${last}\`; ${REPORT}`,
    };
  }
  return {
    kind: "violation",
    rule: "comparator",
    message: `\`lake comparator\` rejected the certificate: ${last || transcript(result.output)}; ${REPORT}`,
  };
}
