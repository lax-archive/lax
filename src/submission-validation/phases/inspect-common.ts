// What both content specs' classification share: the finding helpers over
// an inspector report (namespace, frontmatter grammar, docstring sections),
// the background axiom set, and the inputs a classifier takes. The spec-1
// rules live in inspect.ts and the spec-2 rules in inspect-spec2.ts; this
// module is what keeps each rule in exactly one place rather than copied to
// the other spec's loop (history/audit-20260903.md).

import type {
  AnnotationSection,
  ConceptEntry,
  FindingIntent,
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
  /** Each package's own modules, root included: what a private name must
   * be mangled with to be exempt from the namespace rule. */
  ownModules: { concepts: ReadonlySet<string>; proofs: ReadonlySet<string> };
  findings: FindingCollector;
}

export type Classifier = (input: ClassificationInput) => ProofEntry[];

/** Lean's own `isPrivateName`: a name is private iff it starts with the
 * `_private` component (`_private.<module>.0.<name>`), whatever its
 * un-mangled form says. Judged from the persisted name, never from a hook. */
export function isPrivateName(name: string): boolean {
  return name === "_private" || name.startsWith("_private.");
}

const SCRIPTS: ReadonlyArray<[string, RegExp]> = [
  ["Latin", /\p{Script=Latin}/u],
  ["Greek", /\p{Script=Greek}/u],
  ["Cyrillic", /\p{Script=Cyrillic}/u],
  ["Han", /\p{Script=Han}/u],
  ["Hiragana", /\p{Script=Hiragana}/u],
  ["Katakana", /\p{Script=Katakana}/u],
  ["Hangul", /\p{Script=Hangul}/u],
  ["Hebrew", /\p{Script=Hebrew}/u],
  ["Arabic", /\p{Script=Arabic}/u],
  ["Armenian", /\p{Script=Armenian}/u],
  ["Georgian", /\p{Script=Georgian}/u],
  ["Devanagari", /\p{Script=Devanagari}/u],
  ["Thai", /\p{Script=Thai}/u],
];
const NEUTRAL = /[\p{Script=Common}\p{Script=Inherited}]/u;
const LOWER_GREEK = /\p{Script=Greek}/u;

/** Why a canonical name is not one a reader can read as itself: not NFC, a
 * combining mark or format control anywhere, or a component mixing scripts.
 * Empty when the name is fine. Lower-case Greek is neutral (`hα`), Common
 * and Inherited characters are neutral (`ℕ`, digits, `_`), a script outside
 * the table counts as one script of its own. */
export function nameHygieneProblems(name: string): string[] {
  if (name.normalize("NFC") !== name) return ["is not in Unicode normal form C"];
  if (/[\p{M}\p{Cf}]/u.test(name)) return ["carries a combining mark or an invisible format character"];
  for (const component of name.split(".")) {
    const scripts = new Set<string>();
    for (const character of component) {
      if (NEUTRAL.test(character)) continue;
      if (LOWER_GREEK.test(character) && character === character.toLowerCase()) continue;
      const script = SCRIPTS.find(([, pattern]) => pattern.test(character))?.[0] ?? "another script";
      scripts.add(script);
    }
    if (scripts.size > 1) return [`mixes ${[...scripts].join(" and ")} in the component ${JSON.stringify(component)}`];
  }
  return [];
}

/** A persisted name without Lean's private mangling: `_private.<module>.0.<rest>`
 * → `<rest>` (`privateToUserName?`); any other name as it is. The module
 * component is matched up to the first `.0.`, which a canonical module name
 * never contains. */
export function unmangledName(name: string): string {
  if (!isPrivateName(name)) return name;
  const match = /^_private\.(?:[^.]+\.)*?0\.(.*)$/u.exec(name);
  return match === null ? name : match[1]!;
}


/** A declaration's name without its module prefix, for a signature. */
export function shortName(declaration: InspectorDeclaration): string {
  return declaration.name.startsWith(`${declaration.module}.`)
    ? declaration.name.slice(declaration.module.length + 1)
    : declaration.name;
}

/**
 * The namespace rule is the composition rule: Lean's `finalizeImport`
 * (`subsumesInfo`, v4.35) refuses two modules declaring the same constant
 * unless both are theorems of identical name, type, and level parameters,
 * so every record's declarations must be disjoint from every other
 * record's — now and in the future — and a prefix the record owns is the
 * one local condition that guarantees it. Compiler-realized reserved
 * theorems are exempt by the inspector's `origin` (`realized`), never by
 * their shape: they are regenerated identically, and the import tolerance
 * admits them. Private declarations cannot clash either — Lean mangles them
 * with the module name, and modules are unique per record (the root-module
 * rule) — so spec 2 exempts them (`exemptPrivateOf`, decision 10); spec 1
 * keeps spec.md's un-mangle-then-test reading until the spec says otherwise
 * (spec-notes.md). A `_private.` prefix alone is not provenance — a hostile
 * artifact can mint `_private.<someone else's module>.0.x` (codex review
 * 2026-10-04, finding 5) — so the exemption holds only for a name mangled
 * with one of the package's *own* modules; any other private-looking name
 * takes the ordinary prefix test on its un-mangled form.
 */
export function checkNamespace(
  declaration: InspectorDeclaration,
  prefix: string,
  label: string,
  findings: FindingCollector,
  options: { exemptPrivateOf?: ReadonlySet<string>; intent?: FindingIntent } = {},
): void {
  // Spec 2 (`exemptPrivateOf` given): every declaration the package
  // contributes is held to the prefix on its persisted name, and the one
  // fact consulted is its `origin` (contracts.ts DeclarationOrigin), never
  // the shape of the name or the presence of a display name (codex review
  // 2 2026-10-04, finding 1: `isInternalDetail` admits an authored
  // `proof_1`). Lean's generated names extend their parent's (`S.rec`,
  // `f.match_1`, `f.proof_1`), so an `auxiliary` passes the test the way
  // its parent did; what does not carry the prefix is authored outside it
  // or realized under an imported constant. The exemptions are provenance
  // Lean's own mangling or realization vouches for:
  //   - `private` mangled with one of the package's own modules, and
  //     `scoped` (macro scopes) of one of them;
  //   - a `realized` *theorem*: a realization Lean regenerates identically
  //     in every record and `finalizeImport` admits twice;
  //   - a `realized` non-theorem is a violation with its own message,
  //     since two records that both carry it cannot be imported together.
  const origin = options.exemptPrivateOf !== undefined ? declaration.origin : undefined;
  if (origin !== undefined) {
    if ((origin.kind === "private" || origin.kind === "scoped") && options.exemptPrivateOf!.has(origin.module)) return;
    if (origin.kind === "realized" && declaration.kind === "theorem") return;
  }
  const name = origin !== undefined ? (origin.kind === "private" ? unmangledName(declaration.name) : declaration.name) : declaration.userName;
  if (name === undefined || name === prefix || name.startsWith(`${prefix}.`)) return;
  if (origin?.kind === "realized") {
    // a definition Lean realized under an imported constant's namespace
    // (B2 in spike/axiomfree/namespace-review-20261004.md): `finalizeImport`
    // refuses two modules that both define it, so two records that both
    // ran the realizing tactic over the same enum could never be composed
    findings.violate(
      "namespace",
      `${label} declaration ${name} is a realized definition under an imported name; Lean refuses to import ` +
        "two records that both realize it, so the archive cannot admit it — use a different tactic",
      options.intent,
    );
    return;
  }
  findings.violate("namespace", `${label} declaration ${name} does not carry namespace ${prefix}`, options.intent);
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
