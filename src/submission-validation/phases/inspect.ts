import type {
  AnnotationSection,
  ConceptEntry,
  ContentSpecVersion,
  InspectionResult,
  InspectorDeclaration,
  InspectorReport,
  ModuleInventory,
  ProofEntry,
  ResolutionResult,
  StaticResult,
  ValidationScope,
} from "../contracts.js";
import { LIBRARY_ROOT_MODULES } from "../environments.js";
import { FindingCollector } from "../findings.js";
import { leanFacts } from "../lean-facts.js";
import {
  BACKGROUND_AXIOMS,
  checkArchiveName,
  checkFrontmatter,
  checkNamespace,
  list,
  scalar,
  shortName,
  splitSections,
  type ClassificationInput,
  type Classifier,
  type SiblingPackages,
} from "./inspect-common.js";
import { classifySpec2 } from "./inspect-spec2.js";

export type { SiblingPackages } from "./inspect-common.js";

const IMPORT_PREFIXES = leanFacts().coreImportRoots;

/** The content rules by spec: what a statement and a proof are. The
 * module-level rules above the declarations (root module, imports, concept
 * annotations) and the helper warning are the same under both. */
const CLASSIFIERS: Readonly<Record<ContentSpecVersion, Classifier>> = {
  1: classifySpec1,
  2: classifySpec2,
};

/** The root modules of the environment libraries each package requires
 * (contracts.ts ValidatedLakefile.libraries, through
 * environments.ts LIBRARY_ROOT_MODULES): importable beside the core roots.
 * `Mathlib` is a core root already, so a spec-1 package passes nothing new
 * here; a spec-2 package that requires LaxCore may import `LaxCore`. */
export interface LibraryRoots {
  concepts: string[];
  proofs: string[];
}

/** The library roots a static result's two lakefiles earn (both pipelines
 * pass this to judgeInspection; a package the scope left unread earns none). */
export function libraryRootsOf(result: StaticResult): LibraryRoots {
  const roots = (kind: "concepts" | "proofs"): string[] =>
    (result[kind]?.lakefile.libraries ?? []).map((name) => LIBRARY_ROOT_MODULES[name]);
  return { concepts: roots("concepts"), proofs: roots("proofs") };
}

export function judgeInspection(
  conceptReport: InspectorReport,
  proofReport: InspectorReport | undefined,
  conceptInventory: ModuleInventory,
  proofInventory: ModuleInventory | undefined,
  resolution: ResolutionResult,
  scope: ValidationScope = "both",
  siblings: SiblingPackages = { concepts: [], proofs: [] },
  libraryRoots: LibraryRoots = { concepts: [], proofs: [] },
  /** The content spec of the run's environment (environments.ts), which the
   * static phase proved the manifest names; spec 1 unless said otherwise. */
  specVersion: ContentSpecVersion = 1,
): { result: InspectionResult; findings: FindingCollector } {
  const findings = new FindingCollector("inspect");
  const conceptDeclarations = uniqueDeclarations(conceptReport.declarations, "concept", findings, specVersion);
  const proofDeclarations = uniqueDeclarations(proofReport?.declarations ?? [], "proof", findings, specVersion);
  const ownModules = {
    concepts: new Set([conceptInventory.rootModule, ...conceptInventory.modules]),
    proofs: new Set(proofInventory === undefined ? [] : [proofInventory.rootModule, ...proofInventory.modules]),
  };
  checkReportShape(conceptReport, "concept", findings);
  checkRootModule(conceptReport, conceptInventory, findings);
  if (specVersion === 2) checkGlobalSyntax(conceptReport, "concept", findings);
  checkImports(
    conceptReport,
    conceptInventory,
    new Set([
      ...resolution.concepts.map((entry) => entry.packageName),
      ...siblings.concepts,
      ...libraryRoots.concepts,
    ]),
    findings,
    new Set(siblings.proofs),
  );
  if (scope !== "concepts") {
    if (proofReport === undefined || proofInventory === undefined) {
      throw new Error("proof inspection is required outside a concepts-only build");
    }
    checkReportShape(proofReport, "proof", findings);
    checkRootModule(proofReport, proofInventory, findings);
    if (specVersion === 2) checkGlobalSyntax(proofReport, "proof", findings);
    checkImports(
      proofReport,
      proofInventory,
      new Set([
        conceptInventory.packageName,
        ...resolution.proofs.map((entry) => entry.packageName),
        ...siblings.proofs,
        ...libraryRoots.proofs,
      ]),
      findings,
      new Set(siblings.concepts),
    );
  }

  const concepts: ConceptEntry[] = [];
  const byModule = new Map<string, ConceptEntry>();
  for (const module of conceptReport.modules) {
    if (module.name === conceptInventory.rootModule) continue;
    let title = "";
    let type = "";
    let description = "";
    let sections: AnnotationSection[] | undefined;
    if (module.moduleDocs.length !== 1) {
      findings.violate("annotation", `concept ${module.name} must carry exactly one module docstring`);
    } else {
      const doc = module.moduleDocs[0]!;
      checkFrontmatter(doc, `concept ${module.name}`, ["title", "type"], [], findings);
      title = scalar(doc, "title") ?? "";
      type = scalar(doc, "type") ?? "";
      ({ description, sections } = splitSections(doc.description, `concept ${module.name}`, findings));
      if (title.trim() === "") findings.violate("annotation", `concept ${module.name} must declare a title`);
      if (type.trim() === "") findings.violate("annotation", `concept ${module.name} must declare a type`);
      if (description.trim() === "") findings.violate("annotation", `concept ${module.name} must have a description`);
    }
    const entry: ConceptEntry = {
      id: module.name,
      path: conceptInventory.paths.get(module.name) ?? "",
      title,
      type,
      description,
      ...(sections === undefined ? {} : { sections }),
      imports: [...new Set(module.imports)].filter((name) => !IMPORT_PREFIXES.includes(name.split(".")[0]!)).sort(),
      mathlibImports: [...new Set(module.imports)].filter((name) => name === "Mathlib" || name.startsWith("Mathlib.")).sort(),
      sourceText: "",
      statements: [],
    };
    concepts.push(entry);
    byModule.set(module.name, entry);
  }

  const proofs = CLASSIFIERS[specVersion]({
    conceptDeclarations,
    proofDeclarations,
    byModule,
    proofInventory: scope === "concepts" ? undefined : proofInventory,
    resolution,
    siblings,
    ownModules,
    findings,
  });
  if (scope !== "concepts") warnAboutUnusedLemmas(proofDeclarations, proofs, findings);
  // Decision 10: a spec-2 inspect finding answers one of two questions. The
  // classifier marked the ones that decide what edge a theorem is
  // (`translation`); everything else here is an archive standard.
  if (specVersion === 2) findings.defaultIntent("standards");
  concepts.sort((a, b) => a.id.localeCompare(b.id));
  proofs.sort((a, b) => a.id.localeCompare(b.id));
  return { result: { concepts, proofs }, findings };
}

/**
 * The spec-1 content rules: a statement is an axiom of a concept module, a
 * proof is a theorem whose docstring frontmatter names its `conclusion`, and
 * its assumptions are the statements in its axiom set.
 */
function classifySpec1(input: ClassificationInput): ProofEntry[] {
  const { findings, byModule, resolution, siblings, proofInventory } = input;
  const ownStatements = new Set<string>();
  for (const declaration of input.conceptDeclarations) {
    checkNamespace(declaration, declaration.module, "concept", findings);
    const allowed = new Set(BACKGROUND_AXIOMS);
    if (declaration.kind === "axiom") allowed.add(declaration.name);
    for (const axiom of declaration.axioms)
      if (!allowed.has(axiom))
        findings.violate("axiom-free", `concept declaration ${declaration.name} depends on axiom ${axiom}`);
    if (declaration.doc?.hasFrontmatter)
      findings.violate("annotation", `concept declaration ${declaration.name} carries proof frontmatter`);
    if (declaration.kind === "axiom" && checkArchiveName(declaration, "statement", findings)) {
      const entry = byModule.get(declaration.module);
      if (entry !== undefined) {
        ownStatements.add(declaration.name);
        entry.statements.push({
          id: declaration.name,
          signature: `${shortName(declaration)} : ${declaration.signature ?? ""}`,
          ...(declaration.doc?.description ? { doc: declaration.doc.description } : {}),
          ...(declaration.startLine === undefined ? {} : { startLine: declaration.startLine }),
          ...(declaration.endLine === undefined ? {} : { endLine: declaration.endLine }),
        });
      }
    }
  }
  // A concept module may declare any number of statements. The
  // `one-statement` cardinality gate that used to stand here (one-axiom-plan.md)
  // is deliberately gone: it existed to keep the concept the unit of the proof
  // network so the website could show one status per concept, and the website
  // now handles several statements per concept with anonymous per-statement
  // indices (rewrite.md, "multiple statements per concept"). Statement ids are
  // first-class everywhere downstream, so nothing else had to change. The
  // `type`-frontmatter consistency questions that plan also raised (does
  // `type: definition` forbid axioms, does `type: theorem` require one) are
  // deliberately punted, per rewrite.md — `type` stays an unchecked label.

  const upstreamStatements = new Set(
    resolution.proofs
      .filter((dependency) => dependency.kind === "concepts")
      .flatMap((dependency) => dependency.statements),
  );
  // A sibling concept package has no record to take statements from. Every
  // axiom a concept module declares is one of its statements (see the
  // concept loop above), so for a sibling the statement set is "an axiom
  // under its package prefix" — the kernel facts below still guard what the
  // name is. The archive never sees this: a nonstrict output is not
  // submittable (cli/build.ts), and the sibling's own build judges it.
  const siblingConcepts = new Set(siblings.proofs.filter((name) => !name.endsWith("Proofs")));
  const admissibleStatement = (name: string): boolean =>
    ownStatements.has(name) || upstreamStatements.has(name) || siblingConcepts.has(name.split(".")[0]!);
  const proofs: ProofEntry[] = [];
  for (const declaration of input.proofDeclarations) {
    if (proofInventory === undefined) break;
    checkNamespace(declaration, proofInventory.packageName, "proof", findings);
    for (const axiom of declaration.axioms)
      if (!BACKGROUND_AXIOMS.has(axiom) && !admissibleStatement(axiom))
        findings.violate("axiom-hygiene", `proof declaration ${declaration.name} depends on inadmissible axiom ${axiom}`);
    const doc = declaration.doc;
    if (doc === undefined) continue;
    if (!doc.hasFrontmatter) {
      // A declaration without frontmatter is a helper, so mistyped frontmatter
      // demotes an intended proof in silence; a stray `---` line is the only
      // remaining evidence of the intent.
      if (doc.description.split("\n").some((line) => line.trim() === "---"))
        findings.warn(
          "frontmatter",
          `docstring of ${declaration.name} contains a \`---\` line but was not recognized as ` +
            "frontmatter (the lines above it do not parse as `key: value`)",
        );
      continue;
    }
    const where = `proof ${declaration.name}`;
    checkFrontmatter(doc, where, ["conclusion"], ["assumptions"], findings);
    const conclusion = scalar(doc, "conclusion");
    if (conclusion === undefined) {
      findings.violate("proof", `${where} has no conclusion`);
      continue;
    }
    if (declaration.kind !== "theorem") findings.violate("proof", `${where} must be a theorem declaration`);
    const facts = declaration.conclusionFacts;
    if (facts === undefined) findings.violate("proof", `${where} has no inspected conclusion facts`);
    else {
      if (!facts.resolves) findings.violate("proof", `${where}: conclusion ${conclusion} does not resolve`);
      if (!facts.isAxiom) findings.violate("proof", `${where}: conclusion ${conclusion} is not an axiom`);
      if (!facts.originReachable) findings.violate("proof", `${where}: conclusion origin is not imported`);
      if (!facts.defeq) findings.violate("proof", `${where}: theorem type is not definitionally equal to its conclusion`);
    }
    if (!admissibleStatement(conclusion)) findings.violate("proof", `${where}: conclusion ${conclusion} is not an admitted statement`);
    const assumptions = [...new Set(declaration.axioms.filter((axiom) => !BACKGROUND_AXIOMS.has(axiom) && admissibleStatement(axiom)))].sort();
    const claimed = list(doc, "assumptions");
    if (claimed !== undefined && JSON.stringify([...new Set(claimed)].sort()) !== JSON.stringify(assumptions))
      findings.violate("proof", `${where}: declared assumptions do not match the inspected assumption set`);
    const body = splitSections(doc.description, where, findings);
    if (!checkArchiveName(declaration, "proof", findings)) continue;
    proofs.push({
      id: declaration.name,
      path: proofInventory.paths.get(declaration.module) ?? "",
      conclusion,
      assumptions,
      description: body.description,
      ...(body.sections === undefined ? {} : { sections: body.sections }),
    });
  }
  return proofs;
}

/**
 * A proof-package theorem without proof frontmatter is a helper lemma. Keep it
 * quiet when an annotated proof theorem uses it, directly or through other
 * helpers; otherwise make the ignored declaration visible without rejecting
 * the submission. Generated/internal theorem declarations have no userName
 * and are deliberately excluded from the author-facing warning.
 */
function warnAboutUnusedLemmas(
  declarations: InspectorDeclaration[],
  proofs: ProofEntry[],
  findings: FindingCollector,
): void {
  const byName = new Map(declarations.map((declaration) => [declaration.name, declaration]));
  const proofNames = new Set(proofs.map((proof) => proof.id));
  const reachable = new Set<string>();
  const pending = declarations
    .filter((declaration) => declaration.kind === "theorem" && proofNames.has(declaration.name))
    .map((declaration) => declaration.name);

  while (pending.length > 0) {
    const name = pending.pop()!;
    if (reachable.has(name)) continue;
    reachable.add(name);
    for (const used of byName.get(name)?.usedConstants ?? []) {
      if (byName.has(used) && !reachable.has(used)) pending.push(used);
    }
  }

  const unused = declarations
    .filter((declaration) =>
      declaration.kind === "theorem" &&
      declaration.userName !== undefined &&
      !declaration.doc?.hasFrontmatter &&
      !reachable.has(declaration.name))
    .sort((a, b) => a.userName!.localeCompare(b.userName!));
  for (const declaration of unused) {
    findings.warn(
      "unused-lemma",
      `helper lemma ${declaration.userName} is not used, directly or transitively, by any proof ` +
        "theorem in this submission; keep it only if this is intentional",
    );
  }
}

function checkReportShape(report: InspectorReport, label: string, findings: FindingCollector): void {
  const moduleNames = report.modules.map((module) => module.name);
  if (new Set(moduleNames).size !== moduleNames.length)
    findings.violate("inspector-report", `${label} inspector returned duplicate modules`);
}

/** Global syntax is a violation (standards; E1 in
 * spike/axiomfree/namespace-review-20261004.md): a `syntax`, `notation`,
 * `macro_rules`, or `elab` registered without `scoped` or `local` rewrites
 * every importer — the archive's generated Challenge included, where a
 * `macro_rules` for `theorem` can turn the stated edge into `True` with both
 * exports agreeing — and two records' tokens collide for every later
 * author. The inspector reports, per module, the extensions it registered
 * a global entry in (a syntax node kind is always global and is not one). */
function checkGlobalSyntax(report: InspectorReport, label: string, findings: FindingCollector): void {
  for (const module of report.modules) {
    const extensions = module.globalSyntax ?? [];
    if (extensions.length === 0) continue;
    findings.violate(
      "global-syntax",
      `${label} module ${module.name} registers global syntax (${extensions.map(describeSyntaxExtension).join(", ")}); ` +
        "a record declares every `syntax`, `notation`, `macro`, `macro_rules`, and `elab` as `scoped` or `local`",
    );
  }
}

const SYNTAX_EXTENSION_NAMES: Record<string, string> = {
  "Lean.Parser.parserExtension": "a parser or token",
  "Lean.Elab.macroAttribute": "a macro",
  "Lean.Elab.Term.termElabAttribute": "a term elaborator",
  "Lean.Elab.Command.commandElabAttribute": "a command elaborator",
  "Lean.Elab.Tactic.tacticElabAttribute": "a tactic elaborator",
};

function describeSyntaxExtension(name: string): string {
  return SYNTAX_EXTENSION_NAMES[name] ?? name;
}

/** The declarations a classifier judges. Spec 1: one per name, first wins
 * (Lean permits the same theorem in several module files). Spec 2: a
 * repeated name is a violation unless both copies are realized theorems —
 * a realization Lean regenerates identically in two modules, which
 * `finalizeImport`'s tolerance admits — judged from the inspector's
 * `origin`, never from an absent `userName` (an authored `proof_1` has
 * none either; codex review 2 2026-10-04, findings 1 and 4). Every
 * copy stays in the list: the standards rules (axiom hygiene above all)
 * run over each module's own body, and the classifier registers an
 * endpoint once. */
function uniqueDeclarations(
  declarations: InspectorDeclaration[],
  label: "concept" | "proof",
  findings: FindingCollector,
  specVersion: ContentSpecVersion,
): InspectorDeclaration[] {
  const seen = new Map<string, InspectorDeclaration>();
  const refused = new Set<string>();
  return declarations.filter((declaration) => {
    const first = seen.get(declaration.name);
    if (first === undefined) {
      seen.set(declaration.name, declaration);
      return true;
    }
    if (specVersion !== 2) return false;
    const realizedTheorems =
      first.kind === "theorem" && declaration.kind === "theorem" &&
      first.origin?.kind === "realized" && declaration.origin?.kind === "realized";
    if (!realizedTheorems && !refused.has(declaration.name)) {
      refused.add(declaration.name);
      findings.violate(
        "duplicate-name",
        `${label} declaration ${declaration.name} is declared twice (${first.kind} in ${first.module}, ` +
          `${declaration.kind} in ${declaration.module}); a record declares each name once`,
        "translation",
      );
    }
    return true;
  });
}

function checkRootModule(report: InspectorReport, inventory: ModuleInventory, findings: FindingCollector): void {
  const reported = [...new Set(report.modules.map((module) => module.name))].sort();
  const expected = [inventory.rootModule, ...inventory.modules].sort();
  if (JSON.stringify(reported) !== JSON.stringify(expected))
    findings.violate("inspector-report", `${inventory.packageName} inspector module inventory does not match Static validation`);
  const root = report.modules.find((module) => module.name === inventory.rootModule);
  if (root === undefined) {
    findings.violate("root-module", `inspector did not report root module ${inventory.rootModule}`);
    return;
  }
  const actual = [...new Set(root.imports)].filter((name) => name !== "Init").sort();
  if (JSON.stringify(actual) !== JSON.stringify(inventory.modules))
    findings.violate("root-module", `${inventory.rootModule} must import exactly its package modules`);
  if (root.declCount !== 0) findings.violate("root-module", `${inventory.rootModule} must declare nothing`);
  if (root.moduleDocs.length !== 0) findings.violate("root-module", `${inventory.rootModule} must have no module docstring`);
}

function checkImports(
  report: InspectorReport,
  inventory: ModuleInventory,
  required: Set<string>,
  findings: FindingCollector,
  /** siblings the *other* package of this submission declares: the likely
   * slip is a require written in concepts/lakefile.toml only */
  declaredElsewhere: Set<string> = new Set(),
): void {
  const allowed = new Set([inventory.packageName, ...IMPORT_PREFIXES, ...required]);
  const importable = [...allowed].sort().join(", ");
  const kind = inventory.packageName.endsWith("Proofs") ? "proofs" : "concepts";
  for (const module of report.modules) {
    if (module.name === inventory.rootModule) continue;
    for (const imported of new Set(module.imports)) {
      const prefix = imported.split(".")[0]!;
      if (allowed.has(prefix)) continue;
      findings.violate(
        "imports",
        declaredElsewhere.has(prefix)
          ? `module ${module.name} imports ${imported}, but ${kind}/lakefile.toml does not require ${prefix} — ` +
            `add the same \`[[require]]\` the other package carries; every package declares what it imports`
          : `module ${module.name} imports undeclared package module ${imported}; importable prefixes: ${importable}`,
      );
    }
  }
}

