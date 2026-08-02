import type {
  AnnotationSection,
  ConceptEntry,
  InspectionResult,
  InspectorDeclaration,
  InspectorReport,
  ModuleInventory,
  ParsedDoc,
  ProofEntry,
  ResolutionResult,
  ValidationScope,
} from "../contracts.js";
import { FindingCollector } from "../findings.js";

const BACKGROUND_AXIOMS = new Set(["propext", "Classical.choice", "Quot.sound"]);
const IMPORT_PREFIXES = ["Init", "Std", "Lean", "Mathlib"];

export function judgeInspection(
  conceptReport: InspectorReport,
  proofReport: InspectorReport | undefined,
  conceptInventory: ModuleInventory,
  proofInventory: ModuleInventory | undefined,
  resolution: ResolutionResult,
  scope: ValidationScope = "both",
): { result: InspectionResult; findings: FindingCollector } {
  const findings = new FindingCollector("inspect");
  checkReportShape(conceptReport, "concept", findings);
  checkRootModule(conceptReport, conceptInventory, findings);
  checkImports(conceptReport, conceptInventory, new Set(resolution.concepts.map((entry) => entry.packageName)), findings);
  if (scope !== "concepts") {
    if (proofReport === undefined || proofInventory === undefined) {
      throw new Error("proof inspection is required outside a concepts-only build");
    }
    checkReportShape(proofReport, "proof", findings);
    checkRootModule(proofReport, proofInventory, findings);
    checkImports(
      proofReport,
      proofInventory,
      new Set([conceptInventory.packageName, ...resolution.proofs.map((entry) => entry.packageName)]),
      findings,
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

  const ownStatements = new Set<string>();
  for (const declaration of conceptReport.declarations) {
    checkNamespace(declaration, declaration.module, "concept", findings);
    const allowed = new Set(BACKGROUND_AXIOMS);
    if (declaration.kind === "axiom") allowed.add(declaration.name);
    for (const axiom of declaration.axioms)
      if (!allowed.has(axiom))
        findings.violate("axiom-free", `concept declaration ${declaration.name} depends on axiom ${axiom}`);
    if (declaration.doc?.hasFrontmatter)
      findings.violate("annotation", `concept declaration ${declaration.name} carries proof frontmatter`);
    if (declaration.kind === "axiom") {
      const entry = byModule.get(declaration.module);
      if (entry !== undefined) {
        ownStatements.add(declaration.name);
        const short = declaration.name.startsWith(`${declaration.module}.`)
          ? declaration.name.slice(declaration.module.length + 1)
          : declaration.name;
        entry.statements.push({
          id: declaration.name,
          signature: `${short} : ${declaration.signature ?? ""}`,
          ...(declaration.doc?.description ? { doc: declaration.doc.description } : {}),
          ...(declaration.startLine === undefined ? {} : { startLine: declaration.startLine }),
          ...(declaration.endLine === undefined ? {} : { endLine: declaration.endLine }),
        });
      }
    }
  }
  for (const concept of concepts) {
    if (concept.statements.length > 1)
      findings.violate(
        "one-statement",
        `concept ${concept.id} declares ${concept.statements.length} statements; a concept declares at most one axiom`,
      );
  }

  const upstreamStatements = new Set(
    resolution.proofs
      .filter((dependency) => dependency.kind === "concepts")
      .flatMap((dependency) => dependency.statements),
  );
  const admissibleStatement = (name: string): boolean => ownStatements.has(name) || upstreamStatements.has(name);
  const proofs: ProofEntry[] = [];
  for (const declaration of proofReport?.declarations ?? []) {
    if (proofInventory === undefined) break;
    checkNamespace(declaration, proofInventory.packageName, "proof", findings);
    for (const axiom of declaration.axioms)
      if (!BACKGROUND_AXIOMS.has(axiom) && !admissibleStatement(axiom))
        findings.violate("axiom-hygiene", `proof declaration ${declaration.name} depends on inadmissible axiom ${axiom}`);
    const doc = declaration.doc;
    if (doc === undefined || !doc.hasFrontmatter) continue;
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
    proofs.push({
      id: declaration.name,
      path: proofInventory.paths.get(declaration.module) ?? "",
      conclusion,
      assumptions,
      description: body.description,
      ...(body.sections === undefined ? {} : { sections: body.sections }),
    });
  }
  concepts.sort((a, b) => a.id.localeCompare(b.id));
  proofs.sort((a, b) => a.id.localeCompare(b.id));
  return { result: { concepts, proofs }, findings };
}

function checkReportShape(report: InspectorReport, label: string, findings: FindingCollector): void {
  const moduleNames = report.modules.map((module) => module.name);
  if (new Set(moduleNames).size !== moduleNames.length)
    findings.violate("inspector-report", `${label} inspector returned duplicate modules`);
  const declarationNames = report.declarations.map((declaration) => declaration.name);
  if (new Set(declarationNames).size !== declarationNames.length)
    findings.violate("inspector-report", `${label} inspector returned duplicate declarations`);
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
): void {
  const allowed = new Set([inventory.packageName, ...IMPORT_PREFIXES, ...required]);
  for (const module of report.modules) {
    if (module.name === inventory.rootModule) continue;
    for (const imported of new Set(module.imports)) {
      if (!allowed.has(imported.split(".")[0]!))
        findings.violate("imports", `module ${module.name} imports undeclared package module ${imported}`);
    }
  }
}

function checkNamespace(
  declaration: InspectorDeclaration,
  prefix: string,
  label: string,
  findings: FindingCollector,
): void {
  const name = declaration.userName;
  if (name !== undefined && name !== prefix && !name.startsWith(`${prefix}.`))
    findings.violate("namespace", `${label} declaration ${name} does not carry namespace ${prefix}`);
}

function checkFrontmatter(
  doc: ParsedDoc,
  where: string,
  scalarKeys: string[],
  listKeys: string[],
  findings: FindingCollector,
): void {
  if (doc.error) findings.violate("frontmatter", `${where}: ${doc.error}`);
  const seen = new Set<string>();
  for (const [key] of [...doc.scalars, ...doc.lists]) {
    if (seen.has(key)) findings.violate("frontmatter", `${where}: duplicate key ${key}`);
    seen.add(key);
  }
  for (const [key] of doc.scalars) if (!scalarKeys.includes(key)) findings.violate("frontmatter", `${where}: unrecognized scalar ${key}`);
  for (const [key] of doc.lists) if (!listKeys.includes(key)) findings.violate("frontmatter", `${where}: unrecognized list ${key}`);
}

function splitSections(
  body: string,
  where: string,
  findings: FindingCollector,
): { description: string; sections?: AnnotationSection[] } {
  const segments: Array<{ title?: string; lines: string[] }> = [{ lines: [] }];
  let fence: string | undefined;
  for (const line of body.split("\n")) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
    if (fenceMatch !== null) {
      if (fence === undefined) fence = fenceMatch[1]!;
      else if (fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length) fence = undefined;
      segments.at(-1)!.lines.push(line);
      continue;
    }
    const heading = fence === undefined ? /^# +(\S.*?)\s*$/u.exec(line) : null;
    if (heading !== null) segments.push({ title: heading[1]!, lines: [] });
    else segments.at(-1)!.lines.push(line);
  }
  if (segments.length === 1) return { description: body };
  const leading = segments[0]!.lines.join("\n").trim();
  const named = segments.slice(1).map((segment) => ({ title: segment.title!, markdown: segment.lines.join("\n").trim() }));
  const seen = new Set<string>();
  for (const section of named) {
    const key = section.title.toLowerCase();
    if (seen.has(key)) findings.violate("annotation", `${where}: duplicate section ${section.title}`);
    seen.add(key);
  }
  const description = named.find((section) => section.title.toLowerCase() === "description");
  if (leading !== "" && description?.markdown) findings.violate("annotation", `${where}: description is provided twice`);
  const sections = named.filter((section) => section !== description);
  return {
    description: leading || description?.markdown || "",
    ...(sections.length === 0 ? {} : { sections }),
  };
}

function scalar(doc: ParsedDoc, key: string): string | undefined {
  return doc.scalars.find(([name]) => name === key)?.[1];
}

function list(doc: ParsedDoc, key: string): string[] | undefined {
  return doc.lists.find(([name]) => name === key)?.[1];
}
