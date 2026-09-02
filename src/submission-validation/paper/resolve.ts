// The join piece of the paper phase (paper-plan.md, "Pipeline placement"):
// once Inspect has produced the submission's own concept and proof ids, and
// resolution has settled which archive packages the submission directly
// requires, each located mark's id is resolved to a card. Own ids resolve
// against the inspection; foreign ids against the build outputs of packages
// in the union of `requiredByConcepts` and `requiredByProofs` — directly
// required only, exactly as for assumptions: to talk about it, require it.
// A submission id resolves under the same rule: it is the submission's own
// id or the record one of those directly required packages belongs to.
// Pure; the caller reads the archive snapshot.

import { submissionIdForPackage, type PaperMark } from "../contracts.js";
import type { LocatedMark } from "./extract.js";
import { markIdKind, markIdPackage } from "./rewrite.js";

/** The ids one package offers cards for. */
export interface CardIds {
  concepts: readonly string[];
  proofs: readonly string[];
}

export interface MarkResolutionContext {
  /** The submission's own id (`lax-261`, or `lax-0` for an offline scaffold). */
  submissionId: string;
  /** The submission's own concept package name (`Lax261`). */
  conceptPackage: string;
  /** Cards the submission itself produced, from Inspect. */
  own: CardIds;
  /** Directly required archive packages by package name, each with the
   * cards its recorded build output offers. A `LaxNProofs` entry offers
   * proofs, a `LaxN` entry concepts; the other list is empty. */
  required: ReadonlyMap<string, CardIds>;
}

export function resolvePaperMarks(
  located: readonly LocatedMark[],
  context: MarkResolutionContext,
): { marks: PaperMark[]; problems: string[] } {
  const marks: PaperMark[] = [];
  const problems: string[] = [];
  const proofPackage = `${context.conceptPackage}Proofs`;
  const requiredSubmissions = new Set(
    [...context.required.keys()].map((packageName) => submissionIdForPackage(packageName)),
  );
  for (const mark of located) {
    const kind = markIdKind(mark.id);
    if (kind === "submission") {
      if (mark.id === context.submissionId || requiredSubmissions.has(mark.id)) {
        marks.push({ id: mark.id, kind, begin: mark.begin, end: mark.end });
      } else {
        problems.push(
          `mark ${mark.id}: ${mark.id} is not this submission or one whose package this submission requires directly — ` +
            "a paper can mark only itself and the submissions in its lakefiles' requires; " +
            "mentioning anything else is a citation, not a mark",
        );
      }
      continue;
    }
    const packageName = markIdPackage(mark.id);
    let cards: CardIds | undefined;
    let owner: string;
    if (packageName === context.conceptPackage || packageName === proofPackage) {
      cards = context.own;
      owner = "this submission";
    } else {
      cards = context.required.get(packageName);
      owner = `package ${packageName}`;
      if (cards === undefined) {
        problems.push(
          `mark ${mark.id}: ${packageName} is not a package this submission requires directly — ` +
            "a paper can mark only its own concepts and proofs and those of packages in its " +
            "lakefiles' requires; mentioning anything else is a citation, not a mark",
        );
        continue;
      }
    }
    const ids = kind === "concept" ? cards.concepts : cards.proofs;
    if (ids.includes(mark.id)) {
      marks.push({ id: mark.id, kind, begin: mark.begin, end: mark.end });
      continue;
    }
    const conceptPrefix = statementOwner(mark.id, cards.concepts);
    problems.push(
      conceptPrefix !== undefined
        ? `mark ${mark.id}: statements are not markable; the concept is the unit — mark ${conceptPrefix} instead`
        : `mark ${mark.id}: ${owner} has no ${kind} with that id` +
            (kind === "proof" ? " (only proofs with a frontmatter have a card)" : ""),
    );
  }
  return { marks, problems };
}

/** The concept a statement id extends, if the id is a statement of a known
 * concept — the one mistake worth a sentence of its own. */
function statementOwner(id: string, concepts: readonly string[]): string | undefined {
  let candidate = id;
  while (candidate.includes(".")) {
    candidate = candidate.slice(0, candidate.lastIndexOf("."));
    if (concepts.includes(candidate)) return candidate;
  }
  return undefined;
}
