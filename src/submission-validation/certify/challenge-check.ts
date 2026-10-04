// The Challenge held to the telescope (decision 10; E1 in
// spike/axiomfree/namespace-review-20261004.md, the independent structural
// check of spike/axiomfree/codex-review-intents-20261004.md): after container
// A builds the Challenge, the inspector reads the built module — extensions
// disabled, as every inspection runs — and the host compares what each
// certificate theorem (named after its proof) *elaborated to* with what the
// record says the edge is. The generated text names the edge; a global
// `macro_rules` in any package the Challenge imports can rewrite that text's
// meaning before Lean stores it (a `macro_rules` for `theorem` turned
// `theorem Cert.p : 1 = 2 := sorry` into `Cert.p : True`, axiom-free, with
// Challenge and Solution agreeing). The comparator then holds the proof
// package to the Challenge, so holding the Challenge to the telescope holds
// the whole certificate to the archive's reading. Structured data on both
// sides, never a text diff.
//
// The proof package is not read again here: the comparator's type
// comparison holds every proof to its Challenge theorem, which this check
// has just held to the telescope, so the proof is held transitively.
//
// One step, three callers (ultracode review 2026-10-04, S2): container A2,
// the host path behind `lax build` (certify/host.ts), and a reader's `lax
// certify --run` (cli/certify-hold.ts), which holds a record's edges, one
// edge, or a relative certificate's `Cert.<statement-id>` alike. Each runs
// the per-environment inspector over its own built Challenge with
// `challengeInspectorArguments` and hands the report here; what the
// Challenge must state is the list of certificate theorems the bundle was
// generated from, never re-read from the Challenge text.

import fs from "node:fs";
import type { InspectorDeclaration, InspectorLink, InspectorReport, InspectorTelescope, LevelExpr, ProofTelescope } from "../contracts.js";
import { infrastructureFailure } from "../failures.js";
import { parseInspectorReport } from "../phases/inspect-runner.js";
import { renderLevel } from "../phases/inspect-spec2.js";
import { CHALLENGE_MODULE, type CertificateTheorem } from "./generate.js";

export interface ChallengeMismatch {
  kind: "violation";
  intent: "translation";
  rule: "challenge-mismatch";
  message: string;
}

export interface ChallengeBuildViolation {
  kind: "violation";
  intent: "translation";
  rule: "challenge-build";
  message: string;
}

/** The inspector's argument shape over the built Challenge
 * (phases/inspect-runner.ts inspectorArguments): the spec, the report, the
 * module list — the one generated module, which is its own root. The
 * container's copy is in sandbox/tools/run-certify.mjs, which cannot import
 * this. */
export function challengeInspectorArguments(report: string): string[] {
  return ["--spec", "2", report, CHALLENGE_MODULE];
}

/**
 * A Challenge that did not build over the concept packages — wherever it was
 * built. The Challenge names only statements and no proof code is present in
 * its build, so the failure is never the proof's. It is either lax's — the
 * translation disagreeing with Lean about what the telescopes say — or the
 * concept package's own: a concept initializer that aborts during `lake
 * build Challenge`, a concept module that does not import cleanly. The
 * second is decision 8's trusted-author assumption (axiomfree-plan.md): the
 * archive does not defend against a concept package the record itself
 * depends on, so the finding stays `translation` and the wording asks for a
 * report only when the concept packages build on their own (verification
 * review 2026-10-04).
 */
export function challengeBuildViolation(transcript: string): ChallengeBuildViolation {
  return {
    kind: "violation",
    intent: "translation",
    rule: "challenge-build",
    message:
      "the generated Challenge did not build over the concept packages — the statements lax named from the " +
      "proofs' telescopes do not elaborate the way Lean reads them; if every concept package the record " +
      "requires builds cleanly with `lax build`, lax's generator and classifier disagree with Lean: report it as " +
      `a lax bug, quoting this message. The transcript:\n${transcript.trim()}`,
  };
}

/** The inspector's report over the built Challenge, as the inspection left
 * it: a plain bounded file, parsed as every spec-2 report is
 * (phases/inspect-runner.ts). Missing or unreadable is the archive's — or,
 * for a reader's rerun, the tooling's — problem, never a verdict on the
 * record. */
export function readChallengeReport(filename: string, maxBytes: number): InspectorReport {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filename);
  } catch {
    throw infrastructureFailure("the Challenge inspection report was not produced");
  }
  if (!stat.isFile() || stat.size > maxBytes) throw infrastructureFailure("the Challenge inspection report is missing or oversized");
  try {
    return parseInspectorReport(JSON.parse(fs.readFileSync(filename, "utf8")) as unknown, 2);
  } catch (error) {
    throw infrastructureFailure(`could not read the Challenge inspection report: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The step every caller takes once its inspector has written `report`:
 * read it and hold the Challenge it describes to `theorems`. */
export function holdChallenge(report: string, maxBytes: number, theorems: readonly CertificateTheorem[]): ChallengeMismatch | undefined {
  return checkChallengeReport(readChallengeReport(report, maxBytes), theorems);
}

/**
 * Every certificate theorem of the built Challenge, as the inspector read it,
 * against the theorems the bundle was generated from — a record's edges
 * (`edgeTheorem`), or a relative certificate's one implied edge: the same
 * statement constants with the same universe instances in the same binder
 * positions, the same conclusion, the same level parameters (binder kinds
 * are not part of an edge: the comparator's `Expr.eqv` ignores them). The
 * first disagreement, in name order, is the violation; `undefined` means the
 * Challenge states exactly those theorems.
 */
export function checkChallengeReport(report: InspectorReport, theorems: readonly CertificateTheorem[]): ChallengeMismatch | undefined {
  const built = new Map<string, InspectorDeclaration>();
  for (const declaration of report.declarations)
    if (declaration.module === CHALLENGE_MODULE && !built.has(declaration.name)) built.set(declaration.name, declaration);
  const ordered = [...theorems].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const theorem of ordered) {
    const name = theorem.name;
    const declaration = built.get(name);
    const recorded = { levelParams: theorem.levelParams, telescope: theorem.telescope };
    if (declaration === undefined) return mismatch(name, recorded, "is not declared in the built Challenge");
    if (declaration.nonCanonical === true || declaration.kind !== "theorem")
      return mismatch(name, recorded, `is ${declaration.kind === "theorem" ? "not a canonical name" : `a ${declaration.kind}, not a theorem`} in the built Challenge`);
    const levelParams = declaration.levelParams ?? [];
    if (!sameStrings(levelParams, theorem.levelParams))
      return mismatch(name, recorded, `has universe parameters {${levelParams.join(", ")}} in the built Challenge`);
    const telescope = declaration.telescope;
    if (telescope === undefined || telescope === null)
      return mismatch(name, recorded, "elaborated to a type that is not a chain of statements in the built Challenge");
    const problem = compareTelescope(telescope, theorem.telescope);
    if (problem !== undefined) return mismatch(name, recorded, `elaborated to ${describeBuilt(telescope)} in the built Challenge (${problem})`);
  }
  return undefined;
}

function compareTelescope(built: InspectorTelescope, recorded: ProofTelescope): string | undefined {
  if (built.hypotheses.length !== recorded.hypotheses.length)
    return `${built.hypotheses.length} hypotheses where the record has ${recorded.hypotheses.length}`;
  for (const [index, hypothesis] of built.hypotheses.entries()) {
    const expected = recorded.hypotheses[index]!;
    if (!names(hypothesis, expected.statement)) return `hypothesis ${index + 1} is ${constant(hypothesis)}, not ${expected.statement}`;
    const levels = paramNames(hypothesis.levels);
    if (levels === undefined || !sameStrings(levels, expected.levels))
      return `hypothesis ${index + 1} instantiates ${hypothesis.const} at {${hypothesis.levels.map(renderLevel).join(", ")}}, not {${expected.levels.join(", ")}}`;
  }
  if (!names(built.conclusion, recorded.conclusion.statement))
    return `the conclusion is ${constant(built.conclusion)}, not ${recorded.conclusion.statement}`;
  const levels = paramNames(built.conclusion.levels);
  if (levels === undefined || !sameStrings(levels, recorded.conclusion.levels))
    return `the conclusion instantiates ${built.conclusion.const} at {${built.conclusion.levels.map(renderLevel).join(", ")}}, not {${recorded.conclusion.levels.join(", ")}}`;
  return undefined;
}

/** Whether a built link is the recorded statement: its printed name is the
 * statement's and reads back as the constant (a `nonCanonical` link's text
 * names another constant than its own). */
function names(link: InspectorLink, statement: string): boolean {
  return link.nonCanonical !== true && link.const === statement;
}

function constant(link: InspectorLink): string {
  return link.nonCanonical === true ? `a constant printed ${link.const} that is not that name` : link.const;
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
      `the certificate theorem ${name} states the edge ${describeRecorded(recorded)} by the archive's records but ${what}; ` +
      "the Challenge lax wrote does not mean, once Lean reads it over the concept packages, what the record says the " +
      "edge is — a global `syntax`, `macro_rules`, or `elab` in a package the Challenge imports can do this; the " +
      "archive certifies only an edge whose Challenge elaborates to exactly the recorded telescope",
  };
}
