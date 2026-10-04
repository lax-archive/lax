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
// is a violation ("require its package"); a theorem of proof shape written
// `private` is a violation, while one Lean generated (`f._proof_1`, an
// equation lemma — under a `private def` too) is a helper the certificate
// never names; every level argument of every
// statement in the chain is a universe parameter of the proof and the
// conclusion's are pairwise distinct.
// Everything else of theorem kind is a helper. Edge `{S₁..Sₖ} → C` with
// duplicates collapsed in `assumptions` while `telescope` keeps every
// position; `k = 0` is unconditional; a self-edge is a proof like any other.
//
// Hygiene, both packages: the `axiom` kind is a violation; every axiom set is
// a subset of the background three (`sorryAx` and the native-computation
// axioms are not background). Frontmatter anywhere in the proof package is a
// violation naming the spec-1 habit.
//
// Every finding here carries its intent (decision 10): the statement and
// proof rules decide what edge a theorem is — `translation`, the one
// correctness-critical reading outside the kernel, since the certificate
// generator renders whatever these rules admit and the judge verifies
// whatever it is handed. Namespace, hygiene, and frontmatter are archive
// standards, enforced whether or not correctness needs them; they take the
// phase's default. Private declarations are exempt from the namespace rule
// (they are module-mangled and cannot clash) and from nothing else.

import type {
  InspectorDeclaration,
  LevelExpr,
  ProofEntry,
  ProofTelescope,
  StatementEntry,
} from "../contracts.js";
import { leanName } from "../certify/lean-name.js";
import type { FindingCollector } from "../findings.js";
import {
  BACKGROUND_AXIOMS,
  checkNamespace,
  isPrivateName,
  nameHygieneProblems,
  shortName,
  splitSections,
  type ClassificationInput,
} from "./inspect-common.js";

export function classifySpec2(input: ClassificationInput): ProofEntry[] {
  const { findings } = input;
  const ownStatements = new Set<string>();

  for (const declaration of input.conceptDeclarations) {
    // the standards, over every declaration the package contributes — a
    // duplicated name included, each module's own body (inspect.ts
    // uniqueDeclarations)
    checkNamespace(declaration, declaration.module, "concept", findings, { exemptPrivateOf: input.ownModules.concepts });
    checkAxiomHygiene(declaration, "concept", findings);
    checkInitializer(declaration, "concept", findings);
    if (declaration.doc?.hasFrontmatter)
      findings.violate(
        "annotation",
        `concept declaration ${display(declaration)} carries docstring frontmatter; a concept's annotation ` +
          "is its module docstring, and spec 2 has no proof frontmatter",
      );
    const userLevel = checkCanonicalName(declaration, "concept", findings) && checkNameHygiene(declaration, "concept", findings);
    if (declaration.laxStatement !== true) continue;
    // an endpoint: user-level, canonical, legible, or no statement at all
    if (!checkEndpointName(declaration, "concept", findings) || !userLevel) continue;
    const problems = statementProblems(declaration);
    for (const problem of problems) findings.violate("statement", `${display(declaration)} ${problem}`, "translation");
    if (problems.length > 0) continue;
    const entry = input.byModule.get(declaration.module);
    if (entry === undefined) continue; // the root module: the root-module rule has fired
    if (ownStatements.has(declaration.name)) continue; // a duplicate: refused by inspect.ts, registered once
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
  const proofIds = new Set<string>();
  for (const declaration of input.proofDeclarations) {
    checkNamespace(declaration, proofInventory.packageName, "proof", findings, { exemptPrivateOf: input.ownModules.proofs });
    checkAxiomHygiene(declaration, "proof", findings);
    checkInitializer(declaration, "proof", findings);
    const userLevel = checkCanonicalName(declaration, "proof", findings) && checkNameHygiene(declaration, "proof", findings);
    // a house rule, not a reading: the classifier never takes a statement
    // from a proof package's tags, so no edge depends on it
    if (declaration.laxStatement === true)
      findings.violate(
        "marker",
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
    // a definition of proof shape is a helper
    if (declaration.kind !== "theorem") continue;
    // a chain naming a constant the inspector had to write escaped (a
    // non-canonical name, `isCanonicalName`) is refused outright rather
    // than read as a proof of the flattened text (codex review 2
    // 2026-10-04, finding 1); a canonical constant that is no registered
    // statement makes the theorem a helper below
    const escaped = chain.find((link) => link.const.includes("«"));
    if (escaped !== undefined) {
      findings.violate(
        "proof",
        `theorem ${display(declaration)} has the shape of a proof over ${escaped.const}, whose name the archive's ` +
          "canonical form cannot carry; an endpoint is a user-level definition with a plain dotted name",
        "translation",
      );
      continue;
    }
    const kinds = chain.map((link) => statementOf(link.const));
    // a chain over something that is no statement anywhere is a helper
    if (kinds.includes("none")) continue;
    // an endpoint: user-level, canonical, legible, or refused — or, if Lean
    // generated it, a helper
    if (!checkEndpointName(declaration, "proof", findings) || !userLevel) continue;

    const where = `theorem ${display(declaration)}`;
    let ok = true;
    for (const [index, link] of chain.entries()) {
      if (kinds[index] !== "transitive") continue;
      ok = false;
      findings.violate(
        "proof",
        `${where} has the shape of a proof, but ${link.const} is a statement of ${transitive.get(link.const)}, ` +
          "which the proof package does not require directly — to assume or conclude a statement, require its package",
        "translation",
      );
    }
    if (isPrivateName(declaration.name)) {
      ok = false;
      findings.violate(
        "proof",
        `private ${where} has the shape of a proof (${describeEdge(telescope)}); the archive's certificate ` +
          "must name it from another module — drop `private`, or give it a type that is not a chain of statements if it is a helper",
        "translation",
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
          "translation",
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
        "translation",
      );
    }
    if (!ok) continue;

    const recorded: ProofTelescope = {
      hypotheses: telescope.hypotheses.map((hypothesis) => ({
        statement: hypothesis.const,
        levels: hypothesis.levels.map(paramName),
      })),
      conclusion: {
        statement: telescope.conclusion.const,
        levels: telescope.conclusion.levels.map(paramName),
      },
    };
    const body = splitSections(declaration.doc?.description ?? "", where, findings);
    if (proofIds.has(declaration.name)) continue; // a duplicate: refused by inspect.ts, recorded once
    proofIds.add(declaration.name);
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

/** A canonical name as Lean prints it — components Lean cannot read bare in
 * `«»` — for a signature shown to a reader; a component the quotes cannot
 * carry is shown as it is (the certificate generator, not this display, is
 * where such a name is refused). */
function displayName(canonical: string): string {
  try {
    return leanName(canonical);
  } catch {
    return canonical;
  }
}

function statementEntry(declaration: InspectorDeclaration): StatementEntry {
  const levelParams = [...(declaration.levelParams ?? [])];
  const universes = levelParams.length === 0 ? "" : `.{${levelParams.map(displayName).join(", ")}}`;
  return {
    id: declaration.name,
    levelParams,
    // the report's names are canonical (unescaped); the signature is Lean
    // source for a reader, so it quotes them as Lean would
    signature: `${displayName(shortName(declaration))}${universes} : ${declaration.signature ?? "Prop"}`,
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

/** No `initialize` in a record (standards; F1 in
 * spike/axiomfree/namespace-review-20261004.md): an initializer registers a
 * name-keyed global registry — a persistent extension, an option, a simp
 * attribute, a syntax category — that Lean refuses at import when two
 * records chose the same name, which no name rule can see, and it runs
 * arbitrary IO in every importer's `lean`, a reader's `lax certify --run`
 * included. The inspector flags every declaration a module marks `@[init]`. */
function checkInitializer(declaration: InspectorDeclaration, label: "concept" | "proof", findings: FindingCollector): void {
  if (declaration.initializer !== true) return;
  findings.violate(
    "initialize",
    `${label} module ${declaration.module} declares an initializer (${display(declaration)}); a record declares no ` +
      "`initialize`, `register_option`, `register_simp_attr`, `declare_syntax_cat`, or persistent extension — " +
      "two records registering the same name cannot be imported together",
  );
}

/** The canonical-name rule (translation): a name the dotted canonical form
 * cannot carry unambiguously — a component with a `.` in it, a numeric
 * component — is refused, never flattened, because the certificate names
 * constants by that form and `Lax1.C.«A.B»` would otherwise read as
 * `Lax1.C.A.B` (codex review 2026-10-04, finding 1). The inspector wrote the
 * name escaped, so the author sees the `«»`. Returns whether the
 * declaration may be classified at all. */
function checkCanonicalName(declaration: InspectorDeclaration, label: "concept" | "proof", findings: FindingCollector): boolean {
  if (declaration.nonCanonical !== true) return true;
  // Lean's own scoped, realized, and auxiliary names (`foo._@.<module>._hyg.3`)
  // are non-canonical by construction and never translated; the endpoint
  // gate (`checkEndpointName`) keeps one from being a statement or a proof
  if (!isAuthoredOrigin(declaration)) return false;
  findings.violate(
    "name-not-canonical",
    `${label} declaration ${declaration.name} has a component Lean must quote; the archive names every constant ` +
      "by its plain dot-separated components, so a component containing a `.` cannot be told from a nested " +
      "namespace — rename the declaration",
    "translation",
  );
  return false;
}

/** The name-hygiene rule (translation; fable review 2026-10-04, finding
 * 1.3): the Challenge text is the reader's audit surface, so a name a reader
 * cannot tell from another is refused — a non-NFC name, a combining mark or
 * a format control (an invisible joiner), or a component mixing scripts
 * (a Cyrillic `а` in a Latin word; a Greek capital, which the escaper
 * writes bare). Lower-case Greek beside Latin (`hα`) is what Lean authors
 * write and is admitted; the letterlike block (`ℕ`) is Common. Applies to
 * the names the certificate can carry — those with a user-level name — and
 * to universe parameters. Returns whether the declaration may be
 * classified. */
function checkNameHygiene(declaration: InspectorDeclaration, label: "concept" | "proof", findings: FindingCollector): boolean {
  if (!isAuthoredOrigin(declaration)) return true;
  const problems = [
    ...nameHygieneProblems(declaration.name),
    ...(declaration.levelParams ?? []).flatMap((level) => nameHygieneProblems(level).map((problem) => `universe parameter ${level} ${problem}`)),
  ];
  if (problems.length === 0) return true;
  findings.violate(
    "name-hygiene",
    `${label} declaration ${display(declaration)} ${problems[0]}; the certificate's text is what a reader checks, ` +
      "so a name must read as itself — rename the declaration",
    "translation",
  );
  return false;
}

/** Authored by the module's own syntax, or written `private` (which has
 * its own rule and hint): what the authored rules — canonical, legible,
 * endpoint — apply to. Scoped declarations and what Lean generated are
 * not. */
function isAuthoredOrigin(declaration: InspectorDeclaration): boolean {
  const origin = declaration.origin;
  return origin?.kind === "authored" || (origin?.kind === "private" && origin.parent === undefined);
}

/** The constant Lean generated a declaration for, by its origin: an
 * `auxiliary` or `realized` one, or a private one the inspector reports
 * with a parent (the nested proof of a `private def`) — privacy says whose
 * module the name is in, not who wrote it. */
function generatedFor(declaration: InspectorDeclaration): string | undefined {
  const origin = declaration.origin;
  if (origin?.kind === "auxiliary" || origin?.kind === "realized" || origin?.kind === "private") return origin.parent;
  return undefined;
}

/** The endpoint gate (translation; codex review 2 2026-10-04, finding 1):
 * a statement or a proof is an authored declaration — by the inspector's
 * `origin`, the one provenance fact, never by the shape of its name or the
 * presence of a display name. The gate excludes; it refuses only what no
 * honest package produces. A theorem Lean generated under a constant of
 * the package or an import — an abstracted nested proof
 * (`def f (h : A) : {n // C} := ⟨0, …⟩` yields `f._proof_1 : A → C`), an
 * equation lemma, either under a `private def` — has the shape of a proof
 * whenever the abstracted proposition is a chain of statements, so a
 * theorem Lean generated (`generatedFor`) is a helper: the certificate
 * never names it, and refusing it would add no soundness (ultracode review
 * 2026-10-04, I1). A tag on what Lean generated is refused. So is a proof
 * shape under a macro-scoped name — honest code produces one (a hygienic
 * command macro's `theorem t` is `t._@.M._hyg.N`), but the certificate
 * could not name it, and a macro must give a proof a plain name
 * (`mkIdent`) — and one whose origin the inspector did not report. */
function checkEndpointName(declaration: InspectorDeclaration, label: "concept" | "proof", findings: FindingCollector): boolean {
  if (isAuthoredOrigin(declaration)) return true;
  const generated = generatedFor(declaration);
  if (label === "proof" && generated !== undefined) return false;
  const what = label === "concept" ? "carries @[lax_statement]" : "has the shape of a proof";
  const origin = declaration.origin;
  const why =
    origin === undefined ? "its origin is unknown"
      : origin.kind === "realized" ? `Lean realized it under ${origin.parent}`
      : generated !== undefined ? `Lean generated it for ${generated}`
      : origin.kind === "scoped" ? `it carries macro scopes of ${origin.module} — a macro must give a proof a plain name (\`mkIdent\`)`
      : `its origin is ${origin.kind}`;
  findings.violate(
    label === "concept" ? "statement" : "proof",
    `${label} declaration ${declaration.name} ${what} but is not an authored declaration — ${why}; an endpoint ` +
      "is a declaration written in the module's own syntax",
    "translation",
  );
  return false;
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
