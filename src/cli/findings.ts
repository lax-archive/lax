import type { ValidationFinding } from "../submission-validation/contracts.js";
import { plural } from "./ui.js";

/**
 * Validation phases as the author's nouns. The pipeline's nineteen internal
 * phases are the machinery's names for its own stages; a finding is about the
 * author's `concepts/` or `proofs/` folder, their layout, or their statements,
 * and that is the only vocabulary a diagnosis needs.
 */
const PHASE_LABEL = new Map<string, string>([
  ["source", "source"],
  ["static", "layout"],
  ["resolution", "dependencies"],
  ["provision", "dependencies"],
  ["compile-concepts", "concepts"],
  ["compile-proofs", "proofs"],
  ["replay", "kernel replay"],
  ["inspect", "statements"],
  ["dialect", "dialect"],
  ["emit", "output"],
]);

export function phaseLabel(phase: string): string {
  return PHASE_LABEL.get(phase) ?? phase;
}

/** A findings block, ready for `ui.Notes.add(headline, ...body)`. */
export interface FindingGroup {
  headline: string;
  body: string[];
}

/**
 * Group findings of one severity into a headline and its indented body. The
 * same renderer serves `lax build` and `lax submit`: a compile error is the same
 * text whether the compiler ran on this machine or on the archive's runner, and
 * an author who has learned to read one has learned to read the other.
 *
 * ```
 * ! 2 warnings
 *   concepts · unused-import
 *     Lax50/Basic.lean imports Mathlib.Tactic but uses nothing from it
 * ```
 */
export function groupFindings(
  findings: readonly ValidationFinding[],
  severity: "error" | "warning",
): FindingGroup | undefined {
  const distinct = unique(findings);
  if (distinct.length === 0) return undefined;
  const body: string[] = [];
  for (const finding of distinct) {
    body.push(`${phaseLabel(finding.phase)} · ${finding.rule}`);
    // A compile transcript is its lines; keep them, indented under their rule.
    for (const message of finding.message.split(/\r?\n/u)) body.push(`  ${message}`);
  }
  return { headline: plural(distinct.length, severity), body };
}

function unique(findings: readonly ValidationFinding[]): ValidationFinding[] {
  return [
    ...new Map(
      findings.map((finding) => [
        `${finding.phase}\u0000${finding.rule}\u0000${finding.message}`,
        finding,
      ]),
    ).values(),
  ];
}
