// Composing a relative certificate (axiomfree-plan.md, "CLI, authoring,
// website"; the draft spec's "Relative certificates"): the implied edge
// `{given statements} → statement` as one theorem `Cert.<statement-id>`,
// discharged by the archive's proofs applied to one another along the
// witness forest `selectProofTree` (src/cli/prooftree.ts) chose — innermost
// first, each proof's hypotheses filled by the term for the statement it
// assumes, which is the certificate's own hypothesis when the statement is
// given and a further application otherwise.
//
// Pure: the selection is an input (a statement → witness proof map), so this
// module imports nothing of the CLI and is tested on fixtures alone. The
// composition is name-only and rests on the universe rule (spec 2, "Proofs"):
// a proof's conclusion is its statement at pairwise distinct universe
// parameters of the proof, so the instance a composition demands determines
// every parameter of the witness by substitution — and the comparator's
// rejection of an ill-typed composition is the test that the rule is right.

import type { CertifiedProof, CertificateTheorem } from "./generate.js";
import { packageOf, rootName, universes } from "./generate.js";
import { leanName } from "./lean-name.js";

/** A statement as the composition needs it: its id and universe parameters. */
export interface StatementRef {
  id: string;
  levelParams: string[];
}

export interface ComposeInput {
  /** The statement to certify. */
  target: StatementRef;
  /** The statements assumed, in `--relative-to` order; each becomes one
   * hypothesis of the certificate theorem. */
  given: readonly StatementRef[];
  /** Every proof the selection may name, by id. */
  proofs: ReadonlyMap<string, CertifiedProof>;
  /** The witness forest: for every statement the selection grounded (the
   * given ones excepted), the proof that proves it. */
  witness: ReadonlyMap<string, string>;
}

export interface ComposedCertificate {
  theorem: CertificateTheorem;
  /** The Solution body: the composed application — on one line while its
   * arguments are atoms, one argument per line once one is an application,
   * so a deep composition stays readable. */
  body: string;
  /** The proofs applied, in order of first application (outermost first). */
  proofsUsed: string[];
  /** The concept packages the theorem names and the proof packages the body
   * applies, each sorted — what the Challenge and the Solution import. */
  conceptPackages: string[];
  proofPackages: string[];
}

/** A composition the rules refuse; the message is the author's. */
export class CompositionError extends Error {}


/**
 * Compose the certificate, or throw a CompositionError naming the rule: the
 * target is among the given statements; a statement on the path has no
 * witness (the caller should have refused earlier, from the selection's
 * unresolved leaves); a witness has a universe parameter its conclusion does
 * not determine; a given statement is demanded at two universe instances (a
 * hypothesis has one); a polymorphic given statement is never demanded (its
 * instance would be arbitrary); the witness relation is cyclic.
 */
export function composeRelativeCertificate(input: ComposeInput): ComposedCertificate {
  const givenIds = new Set(input.given.map((statement) => statement.id));
  if (givenIds.size !== input.given.length) throw new CompositionError("a statement is given twice");
  if (givenIds.has(input.target.id))
    throw new CompositionError(`${input.target.id} is among the given statements; nothing is left to prove`);

  // what each given statement is demanded as, keyed by its level instance
  const demands = new Map<string, Map<string, string[]>>(input.given.map((statement) => [statement.id, new Map()]));
  const proofsUsed: string[] = [];
  const visiting = new Set<string>();

  const term = (statement: string, levels: readonly string[], depth: number): string => {
    const demanded = demands.get(statement);
    if (demanded !== undefined) {
      demanded.set(JSON.stringify(levels), [...levels]);
      // the hypothesis name is settled below, once every demand is known;
      // a placeholder keeps the layout
      return `\u0000${statement}\u0000`;
    }
    if (visiting.has(statement)) throw new CompositionError(`the witness forest is cyclic at ${statement}`);
    const proofId = input.witness.get(statement);
    if (proofId === undefined) throw new CompositionError(`${statement} has no proof in the witness forest`);
    const proof = input.proofs.get(proofId);
    if (proof === undefined) throw new CompositionError(`the witness ${proofId} of ${statement} is not a proof this CLI holds`);
    if (proof.telescope.conclusion.statement !== statement)
      throw new CompositionError(`${proofId} is the witness of ${statement} but concludes ${proof.telescope.conclusion.statement}`);
    const conclusionLevels = proof.telescope.conclusion.levels;
    if (conclusionLevels.length !== levels.length)
      throw new CompositionError(`${statement} is demanded at ${levels.length} universe levels, ${proofId} concludes it at ${conclusionLevels.length}`);
    const substitution = new Map<string, string>();
    conclusionLevels.forEach((parameter, index) => substitution.set(parameter, levels[index]!));
    for (const parameter of proof.levelParams) {
      if (!substitution.has(parameter))
        throw new CompositionError(
          `${proofId} has the universe parameter ${parameter}, which its conclusion ${statement} does not determine; ` +
            "a composition through it would have to choose a level, so it is not composed",
        );
    }
    const instantiate = (level: string): string => {
      const replaced = substitution.get(level);
      if (replaced === undefined)
        throw new CompositionError(`${proofId} instantiates a hypothesis at the level ${level}, which is not one of its parameters`);
      return replaced;
    };
    if (!proofsUsed.includes(proofId)) proofsUsed.push(proofId);
    visiting.add(statement);
    const head = `@${rootName(proofId)}${universes(proof.levelParams.map(instantiate))}`;
    const args = proof.telescope.hypotheses.map((hypothesis) => {
      const argument = term(hypothesis.statement, hypothesis.levels.map(instantiate), depth + 1);
      return argument.startsWith("@") ? `(${argument})` : argument;
    });
    visiting.delete(statement);
    // atoms — hypotheses and argument-less proofs — stay on the head's line;
    // a nested application puts every argument on a line of its own
    if (args.every((argument) => !/[\s]/u.test(argument))) return [head, ...args].join(" ");
    const indent = "  ".repeat(depth + 2);
    return head + args.map((argument) => `\n${indent}${argument}`).join("");
  };

  const body = term(input.target.id, input.target.levelParams, 0);

  // one hypothesis per given statement, in the order given, at the one
  // instance the composition demanded it — or, undemanded, at none
  const hypotheses = input.given.map((statement) => {
    const instances = [...demands.get(statement.id)!.values()];
    if (instances.length > 1) {
      throw new CompositionError(
        `${statement.id} is needed at ${instances.length} universe instances (${instances
          .map((levels) => leanName(statement.id) + universes(levels))
          .join(", ")}); a hypothesis has one — certify each instance separately`,
      );
    }
    if (instances.length === 0 && statement.levelParams.length > 0) {
      throw new CompositionError(
        `the composed proof of ${input.target.id} does not use ${statement.id}, and ${statement.id} is universe-polymorphic, ` +
          "so its hypothesis would have an arbitrary instance; drop it from --relative-to",
      );
    }
    return { statement: statement.id, levels: instances[0] ?? [], binder: "default" as const };
  });
  const names = new Map(input.given.map((statement, index) => [statement.id, `h${subscript(index + 1)}`]));
  const named = body.replace(/\u0000([^\u0000]+)\u0000/gu, (_match, statement: string) => names.get(statement)!);
  const indented = named.includes("\n") ? `  ${named}` : named;

  return {
    theorem: {
      name: `Cert.${input.target.id}`,
      levelParams: input.target.levelParams,
      telescope: {
        hypotheses,
        conclusion: { statement: input.target.id, levels: input.target.levelParams },
      },
    },
    body: indented,
    proofsUsed,
    conceptPackages: [...new Set([input.target.id, ...input.given.map((statement) => statement.id)].map(packageOf))].sort(),
    proofPackages: [...new Set(proofsUsed.map(packageOf))].sort(),
  };
}

const SUBSCRIPT = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"];

function subscript(value: number): string {
  return String(value).split("").map((digit) => SUBSCRIPT[Number(digit)]).join("");
}
