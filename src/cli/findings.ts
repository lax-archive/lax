import type { ValidationFinding } from "../submission-validation/contracts.js";

/** Which run produced the findings; only the heading differs. */
export interface FindingsOrigin {
  /** Command name, e.g. `lax build`. */
  label: string;
  /** What was being done, e.g. `local validation`. */
  activity: string;
}

const LOCAL_BUILD: FindingsOrigin = { label: "lax build", activity: "local validation" };

/**
 * Format validation findings as one phase-grouped diagnostic. The same
 * renderer serves `lax build` and `lax submit`: a compile error is the same
 * text whether the compiler ran on this machine or on the validate runner, and
 * an author who has learned to read one has learned to read the other.
 */
export function formatFindings(
  warnings: ValidationFinding[],
  errors: ValidationFinding[],
  origin: FindingsOrigin = LOCAL_BUILD,
): string | undefined {
  const uniqueWarnings = unique(warnings);
  const uniqueErrors = unique(errors);
  if (uniqueWarnings.length === 0 && uniqueErrors.length === 0) return undefined;
  const totals = [
    count(uniqueErrors.length, "error"),
    count(uniqueWarnings.length, "warning"),
  ].filter((entry): entry is string => entry !== undefined);
  const lines = [`${origin.label}: found ${totals.join(" and ")} during ${origin.activity}`];
  appendSeverity(lines, "errors", uniqueErrors);
  appendSeverity(lines, "warnings", uniqueWarnings);
  return lines.join("\n");
}

function appendSeverity(
  lines: string[],
  label: "errors" | "warnings",
  findings: ValidationFinding[],
): void {
  if (findings.length === 0) return;
  lines.push(`  ${label}:`);
  const phases = new Map<string, ValidationFinding[]>();
  for (const finding of findings) {
    const group = phases.get(finding.phase) ?? [];
    group.push(finding);
    phases.set(finding.phase, group);
  }
  for (const [phase, group] of phases) {
    lines.push(`    ${phase}:`);
    for (const finding of group) {
      const message = finding.message.replace(/[\r\n]+/gu, "\n        ");
      lines.push(`      - [${finding.rule}] ${message}`);
    }
  }
}

function unique(findings: ValidationFinding[]): ValidationFinding[] {
  return [
    ...new Map(
      findings.map((finding) => [
        `${finding.phase}\u0000${finding.rule}\u0000${finding.message}`,
        finding,
      ]),
    ).values(),
  ];
}

function count(value: number, label: string): string | undefined {
  if (value === 0) return undefined;
  return `${value} ${label}${value === 1 ? "" : "s"}`;
}
