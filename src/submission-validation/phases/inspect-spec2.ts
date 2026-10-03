// The spec-2 content rules (axiomfree-plan.md, "Content rules"; the draft
// spec's Concepts, Proofs, and Inspection Internals): what a statement and a
// proof are, judged from the inspector's facts and the archive context, here
// and nowhere else. The inspector reports facts (`laxStatement`, `isProp`,
// `levelParams`, `telescope`); this module is the one place that turns them
// into statements, proofs, helpers, and findings. The attribute's hook in
// LaxCore is never consulted: a workspace whose oleans carry a tag the hook
// would have refused is judged exactly like any other.
//
// Statement: a definition-kind declaration carrying the tag, of stored type
// literally `Sort 0`, with no binders, not private, in a concept module.
// Universe parameters are allowed. A tagged declaration failing any conjunct
// is a violation naming that rule; an untagged `Prop` definition is an
// auxiliary and produces nothing.
//
// Proof: a theorem whose telescope is non-null and whose every constant is a
// statement of the package's own concept package or of a concept package the
// proof package requires directly. A statement reachable only transitively
// is a violation ("require its package"); a private theorem of proof shape is
// a violation; every level argument of every statement in the chain is a
// universe parameter of the proof and the conclusion's are pairwise distinct.
// Everything else of theorem kind is a helper. Edge `{S₁..Sₖ} → C` with
// duplicates collapsed in `assumptions` while `telescope` keeps every
// position; `k = 0` is unconditional; a self-edge is a proof like any other.
//
// Hygiene, both packages: the `axiom` kind is a violation; every axiom set is
// a subset of the background three (`sorryAx` and the native-computation
// axioms are not background). Frontmatter anywhere in the proof package is a
// violation naming the spec-1 habit.

import type {
  InspectorDeclaration,
  LevelExpr,
  ProofEntry,
  ProofTelescope,
  StatementEntry,
} from "../contracts.js";
import type { FindingCollector } from "../findings.js";
import {
  BACKGROUND_AXIOMS,
  checkNamespace,
  isPrivateName,
  shortName,
  splitSections,
  type ClassificationInput,
} from "./inspect-common.js";

export function classifySpec2(input: ClassificationInput): ProofEntry[] {
  const { findings } = input;
  const ownStatements = new Set<string>();

  for (const declaration of input.conceptDeclarations) {
    checkNamespace(declaration, declaration.module, "concept", findings);
    checkAxiomHygiene(declaration, "concept", findings);
    if (declaration.doc?.hasFrontmatter)
      findings.violate(
        "annotation",
        `concept declaration ${display(declaration)} carries docstring frontmatter; a concept's annotation ` +
          "is its module docstring, and spec 2 has no proof frontmatter",
      );
    if (declaration.laxStatement !== true) continue;
    const problems = statementProblems(declaration);
    for (const problem of problems) findings.violate("statement", `${display(declaration)} ${problem}`);
    if (problems.length > 0) continue;
    const entry = input.byModule.get(declaration.module);
    if (entry === undefined) continue; // the root module: the root-module rule has fired
    ownStatements.add(declaration.name);
    entry.statements.push(statementEntry(declaration));
  }

  if (input.proofInventory === undefined) return [];
  const proofInventory = input.proofInventory;

  // The statements a proof may name: its own concept package's (judged
  // above), and those the database records for the concept packages the
  // proof package requires directly. A package reachable only through
  // another require is in `resolution.all` but not in `resolution.proofs`;
  // naming one of its statements is a violation, not a helper.
  const direct = new Map<string, string>();
  for (const dependency of input.resolution.proofs)
    if (dependency.kind === "concepts")
      for (const statement of dependency.statements) direct.set(statement, dependency.packageName);
  const transitive = new Map<string, string>();
  for (const dependency of input.resolution.all)
    if (dependency.kind === "concepts" && !direct.has(dependency.packageName))
      for (const statement of dependency.statements)
        if (!direct.has(statement)) transitive.set(statement, dependency.packageName);
  // A sibling concept package (nonstrict local builds only) has no record
  // to take statements from; a constant under its prefix is admitted as a
  // statement and the sibling's own build judges it.
  const siblingConcepts = new Set(input.siblings.proofs.filter((name) => !name.endsWith("Proofs")));
  const statementOf = (name: string): "own" | "direct" | "transitive" | "none" =>
    ownStatements.has(name) ? "own"
      : direct.has(name) || siblingConcepts.has(name.split(".")[0]!) ? "direct"
      : transitive.has(name) ? "transitive"
      : "none";

  const proofs: ProofEntry[] = [];
  for (const declaration of input.proofDeclarations) {
    checkNamespace(declaration, proofInventory.packageName, "proof", findings);
    checkAxiomHygiene(declaration, "proof", findings);
    if (declaration.laxStatement === true)
      findings.violate(
        "statement",
        `${display(declaration)} carries @[lax_statement] in the proof package; statements are declared ` +
          "in the concept package, and a proof package proves them",
      );
    if (declaration.doc?.hasFrontmatter)
      findings.violate(
        "frontmatter",
        `docstring of ${display(declaration)} carries yaml frontmatter; spec 2 has no proof frontmatter — ` +
          "a proof's conclusion and assumptions are its type (`theorem Q (h : S) : C`), and the spec-1 " +
          "`conclusion:`/`assumptions:` keys are gone",
      );
    const telescope = declaration.telescope;
    if (telescope === undefined || telescope === null) continue; // a helper
    const chain = [...telescope.hypotheses, telescope.conclusion];
    const kinds = chain.map((link) => statementOf(link.const));
    // a chain over something that is no statement anywhere is a helper
    if (kinds.includes("none")) continue;
    // a definition of proof shape is a helper too
    if (declaration.kind !== "theorem") continue;

    const where = `theorem ${display(declaration)}`;
    let ok = true;
    for (const [index, link] of chain.entries()) {
      if (kinds[index] !== "transitive") continue;
      ok = false;
      findings.violate(
        "proof",
        `${where} has the shape of a proof, but ${link.const} is a statement of ${transitive.get(link.const)}, ` +
          "which the proof package does not require directly — to assume or conclude a statement, require its package",
      );
    }
    if (isPrivateName(declaration.name)) {
      ok = false;
      findings.violate(
        "proof",
        `private ${where} has the shape of a proof (${describeEdge(telescope)}); the archive's certificate ` +
          "must name it from another module — drop `private`, or give it a type that is not a chain of statements if it is a helper",
      );
    }
    const params = new Set(declaration.levelParams ?? []);
    for (const link of chain) {
      for (const level of link.levels) {
        if (level[0] === "param" && params.has(level[1])) continue;
        ok = false;
        findings.violate(
          "proof",
          `${where} instantiates ${link.const} at universe level \`${renderLevel(level)}\`; every level ` +
            "argument of a statement in a proof's type must be a universe parameter of the proof",
        );
      }
    }
    const conclusionLevels = telescope.conclusion.levels.map(renderLevel);
    const repeated = conclusionLevels.find((level, index) => conclusionLevels.indexOf(level) !== index);
    if (repeated !== undefined) {
      ok = false;
      findings.violate(
        "proof",
        `${where} concludes ${telescope.conclusion.const}.{${conclusionLevels.join(", ")}} with \`${repeated}\` ` +
          "repeated; a proof concludes its statement in full generality, so the conclusion's level arguments " +
          "must be pairwise distinct universe parameters",
      );
    }
    if (!ok) continue;

    const recorded: ProofTelescope = {
      hypotheses: telescope.hypotheses.map((hypothesis) => ({
        statement: hypothesis.const,
        levels: hypothesis.levels.map(paramName),
        binder: hypothesis.binder,
      })),
      conclusion: {
        statement: telescope.conclusion.const,
        levels: telescope.conclusion.levels.map(paramName),
      },
    };
    const body = splitSections(declaration.doc?.description ?? "", where, findings);
    proofs.push({
      id: declaration.name,
      path: proofInventory.paths.get(declaration.module) ?? "",
      levelParams: [...(declaration.levelParams ?? [])],
      telescope: recorded,
      conclusion: recorded.conclusion.statement,
      assumptions: [...new Set(recorded.hypotheses.map((hypothesis) => hypothesis.statement))].sort(),
      description: body.description,
      ...(body.sections === undefined ? {} : { sections: body.sections }),
    });
  }
  return proofs;
}

/** Why a tagged declaration is not a statement: one message per failing
 * rule, empty when it is one. */
function statementProblems(declaration: InspectorDeclaration): string[] {
  const problems: string[] = [];
  if (declaration.kind !== "def")
    problems.push(`carries @[lax_statement] but is ${article(declaration.kind)}; a statement is a \`def\` of type \`Prop\``);
  if (isPrivateName(declaration.name))
    problems.push(
      "carries @[lax_statement] but is private; a statement is read by name from the packages that depend " +
        "on it — drop `private`",
    );
  if (declaration.isProp !== true) {
    if ((declaration.binders ?? 0) > 0)
      problems.push(
        `carries @[lax_statement] but takes ${declaration.binders} binder${declaration.binders === 1 ? "" : "s"}; ` +
          "a statement has no parameters — quantify inside the body with `∀`",
      );
    else
      problems.push(
        `carries @[lax_statement] but has type \`${declaration.signature ?? "?"}\`; a statement's type is ` +
          "literally `Prop`",
      );
  }
  return problems;
}

function statementEntry(declaration: InspectorDeclaration): StatementEntry {
  const levelParams = [...(declaration.levelParams ?? [])];
  const universes = levelParams.length === 0 ? "" : `.{${levelParams.join(", ")}}`;
  return {
    id: declaration.name,
    levelParams,
    signature: `${shortName(declaration)}${universes} : ${declaration.signature ?? "Prop"}`,
    body: declaration.body ?? "",
    ...(declaration.doc?.description ? { doc: declaration.doc.description } : {}),
    ...(declaration.startLine === undefined ? {} : { startLine: declaration.startLine }),
    ...(declaration.endLine === undefined ? {} : { endLine: declaration.endLine }),
  };
}

/** The `axiom` kind and the axiom set, one rule for both packages. An
 * axiom's own name is in its set; the kind finding covers that, so the set
 * walk skips it and names only what the declaration rests on. */
function checkAxiomHygiene(
  declaration: InspectorDeclaration,
  label: "concept" | "proof",
  findings: FindingCollector,
): void {
  if (declaration.kind === "axiom")
    findings.violate(
      "axiom-free",
      `${label} declaration ${display(declaration)} is an axiom; spec 2 declares no axioms — a statement is ` +
        "`@[lax_statement] def X : Prop := …` in the concept package, and a proof assumes statements as hypotheses",
    );
  for (const axiom of declaration.axioms) {
    if (BACKGROUND_AXIOMS.has(axiom)) continue;
    if (declaration.kind === "axiom" && axiom === declaration.name) continue;
    findings.violate(
      "axiom-free",
      `${label} declaration ${display(declaration)} depends on axiom ${axiom}; spec 2 admits only the background ` +
        `axioms ${[...BACKGROUND_AXIOMS].join(", ")}`,
    );
  }
}

function display(declaration: InspectorDeclaration): string {
  return declaration.userName ?? declaration.name;
}

function article(kind: string): string {
  return /^[aeiou]/u.test(kind) ? `an ${kind}` : `a ${kind}`;
}

function describeEdge(telescope: NonNullable<InspectorDeclaration["telescope"]>): string {
  const hypotheses = [...new Set(telescope.hypotheses.map((hypothesis) => hypothesis.const))];
  return `{${hypotheses.join(", ")}} → ${telescope.conclusion.const}`;
}

/** The parameter a validated level names: called only after the universe
 * rule held, so anything else is a programming error. */
function paramName(level: LevelExpr): string {
  if (level[0] !== "param") throw new Error(`a validated proof level is not a parameter: ${renderLevel(level)}`);
  return level[1];
}

/** A level in Lean's surface syntax, for findings: `u`, `0`, `u+1`,
 * `max u v`, `imax u v`, with compound operands parenthesized. */
export function renderLevel(level: LevelExpr): string {
  switch (level[0]) {
    case "zero":
      return "0";
    case "param":
      return level[1];
    case "mvar":
      return "?";
    case "succ": {
      const inner = renderLevel(level[1]);
      return level[1][0] === "max" || level[1][0] === "imax" ? `(${inner})+1` : `${inner}+1`;
    }
    case "max":
    case "imax": {
      const operand = (operandLevel: LevelExpr): string => {
        const text = renderLevel(operandLevel);
        return operandLevel[0] === "zero" || operandLevel[0] === "param" || operandLevel[0] === "mvar" ? text : `(${text})`;
      };
      return `${level[0]} ${operand(level[1])} ${operand(level[2])}`;
    }
  }
}
