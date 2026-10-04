// The Challenge held to the telescope (decision 10; E1 in
// spike/axiomfree/namespace-review-20261004.md, the independent structural
// check of spike/axiomfree/codex-review-intents-20261004.md): after container
// A builds the Challenge, the inspector reads the built module — extensions
// disabled, as every inspection runs — and the host compares what each
// `Cert.<proof-id>` theorem *elaborated to* with what the record says the
// edge is. The generated text names the edge; a global `macro_rules` in any
// package the Challenge imports can rewrite that text's meaning before Lean
// stores it (a `macro_rules` for `theorem` turned `theorem Cert.p : 1 = 2 :=
// sorry` into `Cert.p : True`, axiom-free, with Challenge and Solution
// agreeing). The comparator then holds the Solution to the Challenge, so
// holding the Challenge to the telescope holds the whole certificate to the
// archive's reading. Structured data on both sides, never a text diff.
//
// The Solution is not read the same way: the comparator's type comparison
// holds every Solution theorem to its Challenge theorem, which this check
// has just held to the telescope, so the Solution is held transitively.

import type { InspectorDeclaration, InspectorReport, InspectorTelescope, LevelExpr, ProofEntry, ProofTelescope } from "../contracts.js";
import { renderLevel } from "../phases/inspect-spec2.js";
import { CHALLENGE_MODULE, certifiedProof, orderedProofs, theoremNameOf } from "./generate.js";

export interface ChallengeMismatch {
  kind: "violation";
  intent: "translation";
  rule: "challenge-mismatch";
  message: string;
}

/**
 * Every certificate theorem of the built Challenge, as the inspector read it,
 * against the record's telescopes: the same statement constants with the
 * same universe instances in the same binder positions, the same
 * conclusion, the same level parameters (binder kinds are not part of an
 * edge: the Solution applies the proof with `@`). The first
 * disagreement is the violation; `undefined` means the Challenge states
 * exactly the record's edges.
 */
export function checkChallengeReport(report: InspectorReport, proofs: readonly ProofEntry[]): ChallengeMismatch | undefined {
  const built = new Map<string, InspectorDeclaration>();
  for (const declaration of report.declarations)
    if (declaration.module === CHALLENGE_MODULE && !built.has(declaration.name)) built.set(declaration.name, declaration);
  for (const proof of orderedProofs(proofs.map(certifiedProof))) {
    const name = theoremNameOf(proof.id);
    const declaration = built.get(name);
    const recorded = { levelParams: proof.levelParams, telescope: proof.telescope };
    if (declaration === undefined) return mismatch(name, recorded, "is not declared in the built Challenge");
    if (declaration.nonCanonical === true || declaration.kind !== "theorem")
      return mismatch(name, recorded, `is ${declaration.kind === "theorem" ? "not a canonical name" : `a ${declaration.kind}, not a theorem`} in the built Challenge`);
    const levelParams = declaration.levelParams ?? [];
    if (!sameStrings(levelParams, proof.levelParams))
      return mismatch(name, recorded, `has universe parameters {${levelParams.join(", ")}} in the built Challenge`);
    const telescope = declaration.telescope;
    if (telescope === undefined || telescope === null)
      return mismatch(name, recorded, "elaborated to a type that is not a chain of statements in the built Challenge");
    const problem = compareTelescope(telescope, proof.telescope);
    if (problem !== undefined) return mismatch(name, recorded, `elaborated to ${describeBuilt(telescope)} in the built Challenge (${problem})`);
  }
  return undefined;
}

function compareTelescope(built: InspectorTelescope, recorded: ProofTelescope): string | undefined {
  if (built.hypotheses.length !== recorded.hypotheses.length)
    return `${built.hypotheses.length} hypotheses where the record has ${recorded.hypotheses.length}`;
  for (const [index, hypothesis] of built.hypotheses.entries()) {
    const expected = recorded.hypotheses[index]!;
    if (hypothesis.const !== expected.statement) return `hypothesis ${index + 1} is ${hypothesis.const}, not ${expected.statement}`;
    const levels = paramNames(hypothesis.levels);
    if (levels === undefined || !sameStrings(levels, expected.levels))
      return `hypothesis ${index + 1} instantiates ${hypothesis.const} at {${hypothesis.levels.map(renderLevel).join(", ")}}, not {${expected.levels.join(", ")}}`;
  }
  if (built.conclusion.const !== recorded.conclusion.statement)
    return `the conclusion is ${built.conclusion.const}, not ${recorded.conclusion.statement}`;
  const levels = paramNames(built.conclusion.levels);
  if (levels === undefined || !sameStrings(levels, recorded.conclusion.levels))
    return `the conclusion instantiates ${built.conclusion.const} at {${built.conclusion.levels.map(renderLevel).join(", ")}}, not {${recorded.conclusion.levels.join(", ")}}`;
  return undefined;
}

/** The parameter names of levels that are all parameters; `undefined` when
 * any is a concrete level or a compound. */
function paramNames(levels: readonly LevelExpr[]): string[] | undefined {
  const names: string[] = [];
  for (const level of levels) {
    if (level[0] !== "param") return undefined;
    names.push(level[1]);
  }
  return names;
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function universes(levels: readonly string[]): string {
  return levels.length === 0 ? "" : `.{${levels.join(", ")}}`;
}

function describeRecorded(recorded: { levelParams: readonly string[]; telescope: ProofTelescope }): string {
  const hypotheses = recorded.telescope.hypotheses.map((hypothesis) => `${hypothesis.statement}${universes(hypothesis.levels)}`);
  const conclusion = `${recorded.telescope.conclusion.statement}${universes(recorded.telescope.conclusion.levels)}`;
  return `{${hypotheses.join(", ")}} → ${conclusion}${universes(recorded.levelParams)}`;
}

function describeBuilt(telescope: InspectorTelescope): string {
  const render = (constant: string, levels: readonly LevelExpr[]): string =>
    `${constant}${levels.length === 0 ? "" : `.{${levels.map(renderLevel).join(", ")}}`}`;
  const hypotheses = telescope.hypotheses.map((hypothesis) => render(hypothesis.const, hypothesis.levels));
  return `{${hypotheses.join(", ")}} → ${render(telescope.conclusion.const, telescope.conclusion.levels)}`;
}

function mismatch(name: string, recorded: { levelParams: readonly string[]; telescope: ProofTelescope }, what: string): ChallengeMismatch {
  return {
    kind: "violation",
    intent: "translation",
    rule: "challenge-mismatch",
    message:
      `the certificate theorem ${name} states the edge ${describeRecorded(recorded)} in the record but ${what}; ` +
      "the Challenge lax wrote does not mean, once Lean reads it over the concept packages, what the record says the " +
      "edge is — a global `syntax`, `macro_rules`, or `elab` in a package the Challenge imports can do this; the " +
      "archive certifies only an edge whose Challenge elaborates to exactly the recorded telescope",
  };
}
