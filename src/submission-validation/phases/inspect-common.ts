// What both content specs' classification share: the finding helpers over
// an inspector report (namespace, frontmatter grammar, docstring sections),
// the background axiom set, and the inputs a classifier takes. The spec-1
// rules live in inspect.ts and the spec-2 rules in inspect-spec2.ts; this
// module is what keeps each rule in exactly one place rather than copied to
// the other spec's loop (history/audit-20260903.md).

import type {
  AnnotationSection,
  ConceptEntry,
  InspectorDeclaration,
  ModuleInventory,
  ParsedDoc,
  ProofEntry,
  ResolutionResult,
} from "../contracts.js";
import type { FindingCollector } from "../findings.js";
import { leanFacts } from "../lean-facts.js";

export const BACKGROUND_AXIOMS: ReadonlySet<string> = new Set(leanFacts().backgroundAxioms);

/** Sibling package names a nonstrict local build admits per package
 * (host/siblings.ts): imports from them are declared, and a sibling concept
 * package's statements are admissible. Empty in trusted validation. */
export interface SiblingPackages {
  concepts: string[];
  proofs: string[];
}

/** What a content spec's classifier judges: the de-duplicated declarations
 * of both packages, the concept entries (by module) it pushes statements
 * into, and the archive context the proof rules need. It returns the proof
 * entries; the statements land on the entries in place. */
export interface ClassificationInput {
  conceptDeclarations: InspectorDeclaration[];
  proofDeclarations: InspectorDeclaration[];
  byModule: Map<string, ConceptEntry>;
  /** undefined in a concepts-only build: no proof declarations are judged */
  proofInventory: ModuleInventory | undefined;
  resolution: ResolutionResult;
  siblings: SiblingPackages;
  findings: FindingCollector;
}

export type Classifier = (input: ClassificationInput) => ProofEntry[];

/** Lean's own `isPrivateName`: a name is private iff it starts with the
 * `_private` component (`_private.<module>.0.<name>`), whatever its
 * un-mangled form says. Judged from the persisted name, never from a hook. */
export function isPrivateName(name: string): boolean {
  return name === "_private" || name.startsWith("_private.");
}

/** A declaration's name without its module prefix, for a signature. */
export function shortName(declaration: InspectorDeclaration): string {
  return declaration.name.startsWith(`${declaration.module}.`)
    ? declaration.name.slice(declaration.module.length + 1)
    : declaration.name;
}

export function checkNamespace(
  declaration: InspectorDeclaration,
  prefix: string,
  label: string,
  findings: FindingCollector,
): void {
  const name = declaration.userName;
  if (name !== undefined && name !== prefix && !name.startsWith(`${prefix}.`))
    findings.violate("namespace", `${label} declaration ${name} does not carry namespace ${prefix}`);
}

export function checkFrontmatter(
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

export function splitSections(
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

export function scalar(doc: ParsedDoc, key: string): string | undefined {
  return doc.scalars.find(([name]) => name === key)?.[1];
}

export function list(doc: ParsedDoc, key: string): string[] | undefined {
  return doc.lists.find(([name]) => name === key)?.[1];
}
