// The spec-2 content rules (src/submission-validation/phases/inspect-spec2.ts)
// over hand-written inspector reports: a table of the cases
// axiomfree-plan.md's stage 2 names, each judged through judgeInspection with
// the spec version the environment row carries, so the test exercises the
// same boundary the pipelines call.

import { describe, expect, it } from "vitest";
import type {
  BinderKind,
  InspectorDeclaration,
  InspectorReport,
  InspectorTelescope,
  LevelExpr,
  ModuleInventory,
  ProofEntry,
  ResolutionResult,
  ResolvedDependency,
  StatementEntry,
} from "../../src/submission-validation/contracts.js";
import { judgeInspection } from "../../src/submission-validation/phases/inspect.js";
import { renderLevel } from "../../src/submission-validation/phases/inspect-spec2.js";
import { COMMIT, REPOSITORY } from "../support/submission-validation.js";

const EMPTY_RESOLUTION: ResolutionResult = { concepts: [], proofs: [], all: [] };

function inventory(packageName: string, modules: string[]): ModuleInventory {
  const kind = packageName.endsWith("Proofs") ? "proofs" : "concepts";
  return {
    packageName,
    packageDir: kind,
    rootModule: packageName,
    modules,
    paths: new Map([
      [packageName, `${kind}/${packageName}.lean`],
      ...modules.map((module) => [module, `${kind}/${module.split(".").join("/")}.lean`] as const),
    ]),
  };
}

const CONCEPT_INVENTORY = inventory("Lax1", ["Lax1.Claim"]);
/** both packages require LaxCore, as every spec-2 package does */
const LIBRARY_ROOTS = { concepts: ["LaxCore"], proofs: ["LaxCore"] };
const PROOF_INVENTORY = inventory("Lax1Proofs", ["Lax1Proofs.Basic"]);

/** A declaration as a `--spec 2` report carries it: the four facts present,
 * a helper theorem unless said otherwise. */
function decl(overrides: Partial<InspectorDeclaration> & { name: string }): InspectorDeclaration {
  const module = overrides.module ?? (overrides.name.startsWith("Lax1Proofs") || overrides.name.includes(".Lax1Proofs.") ? "Lax1Proofs.Basic" : "Lax1.Claim");
  // the origin as the inspector would report it for the name: private by
  // its mangling, authored otherwise; a case states any other origin
  const mangled = /^_private\.(.+?)\.0\./u.exec(overrides.name);
  const origin: InspectorDeclaration["origin"] = mangled === null ? { kind: "authored" } : { kind: "private", module: mangled[1]! };
  return {
    kind: "theorem",
    userName: overrides.name,
    origin,
    axioms: [],
    usedConstants: [],
    laxStatement: false,
    isProp: false,
    levelParams: [],
    telescope: null,
    ...overrides,
    module,
  };
}

/** A tagged definition of statement shape. */
function statement(name: string, overrides: Partial<InspectorDeclaration> = {}): InspectorDeclaration {
  return decl({
    name,
    kind: "def",
    laxStatement: true,
    isProp: true,
    signature: "Prop",
    body: "True",
    binders: 0,
    doc: { hasFrontmatter: false, scalars: [], lists: [], description: `about ${name}` },
    ...overrides,
  });
}

type Link = [string, LevelExpr[]?, BinderKind?];

function chain(hypotheses: Link[], conclusion: [string, LevelExpr[]?]): InspectorTelescope {
  return {
    hypotheses: hypotheses.map(([name, levels, binder]) => ({ const: name, levels: levels ?? [], binder: binder ?? "default" })),
    conclusion: { const: conclusion[0], levels: conclusion[1] ?? [] },
  };
}

function reports(concepts: InspectorDeclaration[], proofs: InspectorDeclaration[], proofImports = ["Lax1.Claim"]): {
  concepts: InspectorReport;
  proofs: InspectorReport;
} {
  return {
    concepts: {
      modules: [
        { name: "Lax1", imports: ["Lax1.Claim"], moduleDocs: [], declCount: 0 },
        {
          name: "Lax1.Claim",
          imports: ["LaxCore", "Mathlib"],
          moduleDocs: [{
            hasFrontmatter: true,
            scalars: [["title", "The claim"], ["type", "theorem"]],
            lists: [],
            description: "The main description.",
          }],
          declCount: concepts.length,
        },
      ],
      declarations: concepts,
    },
    proofs: {
      modules: [
        { name: "Lax1Proofs", imports: ["Lax1Proofs.Basic"], moduleDocs: [], declCount: 0 },
        { name: "Lax1Proofs.Basic", imports: proofImports, moduleDocs: [], declCount: proofs.length },
      ],
      declarations: proofs,
    },
  };
}

function dependency(packageName: string, statements: string[], requiredPackages: string[] = []): ResolvedDependency {
  return {
    packageName,
    submissionId: `lax-${packageName.replace(/\D/gu, "")}`,
    kind: "concepts",
    source: { repository: REPOSITORY, commit: COMMIT, folder: "." },
    state: "registered",
    statements,
    requiredPackages,
  };
}

interface Case {
  name: string;
  concepts: InspectorDeclaration[];
  proofs: InspectorDeclaration[];
  resolution?: ResolutionResult;
  proofImports?: string[];
  /** `[rule, substring]` per expected violation, in any order; `[]` for none. */
  violations: Array<[string, string]>;
  statements?: Array<Partial<StatementEntry>>;
  proofEntries?: Array<Partial<ProofEntry>>;
  warnings?: string[];
}

const A = "Lax1.Claim.A";
const B = "Lax1.Claim.B";
const C = "Lax1.Claim.C";
const AIMPC = "Lax1.Claim.AimpC";
const POLY = "Lax1.Claim.Poly";
const POLY2 = "Lax1.Claim.Poly2";

const CASES: Case[] = [
  {
    name: "a tagged closed Prop def is a statement",
    concepts: [statement(A, { startLine: 10, endLine: 11 })],
    proofs: [],
    violations: [],
    statements: [{ id: A, levelParams: [], signature: "A : Prop", body: "True", doc: `about ${A}`, startLine: 10, endLine: 11 }],
  },
  {
    name: "an untagged Prop def is an auxiliary",
    concepts: [decl({ name: "Lax1.Claim.Aux", kind: "def", isProp: true })],
    proofs: [],
    violations: [],
    statements: [],
  },
  {
    name: "a tagged def with binders is told to quantify inside",
    concepts: [statement("Lax1.Claim.P", { isProp: false, signature: "Nat → Prop", binders: 1, body: "fun n => Eq n n" })],
    proofs: [],
    violations: [["statement", "Lax1.Claim.P carries @[lax_statement] but takes 1 binder; a statement has no parameters — quantify inside the body with `∀`"]],
    statements: [],
  },
  {
    name: "a tagged Type def is not a statement",
    concepts: [statement("Lax1.Claim.T", { isProp: false, signature: "Type", body: "Nat" })],
    proofs: [],
    violations: [["statement", "Lax1.Claim.T carries @[lax_statement] but has type `Type`; a statement's type is literally `Prop`"]],
    statements: [],
  },
  {
    name: "a tagged theorem is not a statement",
    concepts: [statement("Lax1.Claim.t", { kind: "theorem", isProp: false, signature: "True", body: undefined })],
    proofs: [],
    // one violation per failing conjunct: the kind, and the type (a theorem's
    // stored type is its proposition, never `Prop` itself)
    violations: [
      ["statement", "Lax1.Claim.t carries @[lax_statement] but is a theorem; a statement is a `def` of type `Prop`"],
      ["statement", "Lax1.Claim.t carries @[lax_statement] but has type `True`; a statement's type is literally `Prop`"],
    ],
    statements: [],
  },
  {
    name: "a tagged private def is judged private from its name, whatever the hook let through",
    concepts: [statement("_private.Lax1.Claim.0.Lax1.Claim.Hidden", { userName: "Lax1.Claim.Hidden" })],
    proofs: [],
    violations: [["statement", "Lax1.Claim.Hidden carries @[lax_statement] but is private; a statement is read by name from the packages that depend on it — drop `private`"]],
    statements: [],
  },
  {
    // decision 10: a private name is module-mangled and cannot clash with
    // another record's, so the namespace rule — the composition rule — has
    // nothing to say about it; every other rule still applies
    name: "a private declaration outside the namespace is admitted in either package",
    concepts: [
      statement(A),
      decl({ name: "_private.Lax1.Claim.0.aux", userName: "aux", kind: "def", isProp: true }),
    ],
    proofs: [decl({ name: "_private.Lax1Proofs.Basic.0.hidden_helper", userName: "hidden_helper" })],
    violations: [],
    statements: [{ id: A }],
  },
  {
    // codex review 2026-10-04, finding 5: a `_private.` prefix is not
    // provenance — only a name mangled with one of the package's own
    // modules is exempt; anything else takes the ordinary prefix test
    name: "a private-looking name under someone else's module is not exempt",
    concepts: [statement(A)],
    proofs: [decl({ name: "_private.Lax9Proofs.Basic.0.hidden", userName: "hidden" })],
    violations: [["namespace", "proof declaration hidden does not carry namespace Lax1Proofs"]],
  },
  {
    // codex review 2026-10-04, finding 1: `Lax1.Claim.«A.B»` and
    // `Lax1.Claim.A.B` flatten to one canonical string; the inspector
    // writes the first escaped and flagged, and it is refused, not merged
    name: "a name the canonical form cannot carry is refused, and the plain one beside it survives",
    concepts: [
      statement("Lax1.Claim.«A.B»", { nonCanonical: true }),
      decl({ name: "Lax1.Claim.A.B", kind: "def", isProp: true }),
    ],
    proofs: [],
    violations: [["name-not-canonical", "concept declaration Lax1.Claim.«A.B» has a component Lean must quote"]],
    statements: [],
  },
  {
    name: "two reserved theorems of one name are the realized-duplicate case and keep the first; anything else is refused",
    concepts: [
      statement(A),
      // realized in two modules, reported with the realized origin and no
      // userName: Lean merges them (an absent userName alone is not
      // provenance — an authored `proof_1` has none either)
      decl({ name: "Lax1.Claim.foo.eq_1", module: "Lax1.Claim", userName: undefined, origin: { kind: "realized", parent: "Lax1.Claim.foo" } }),
      decl({ name: "Lax1.Claim.foo.eq_1", module: "Lax1.Claim", userName: undefined, origin: { kind: "realized", parent: "Lax1.Claim.foo" } }),
      decl({ name: "Lax1.Claim.twice", kind: "def", isProp: true }),
      decl({ name: "Lax1.Claim.twice", kind: "theorem" }),
      // two authored theorems of one name (D2): the record's id would
      // describe one and the Solution apply the other
      decl({ name: "Lax1.Claim.lemma", module: "Lax1.Claim" }),
      decl({ name: "Lax1.Claim.lemma", module: "Lax1.Claim" }),
    ],
    proofs: [],
    violations: [
      ["duplicate-name", "concept declaration Lax1.Claim.twice is declared twice (def in Lax1.Claim, theorem in Lax1.Claim)"],
      ["duplicate-name", "concept declaration Lax1.Claim.lemma is declared twice (theorem in Lax1.Claim, theorem in Lax1.Claim)"],
    ],
    statements: [{ id: A }],
  },
  {
    name: "a realized definition under an imported name is a namespace violation; under the package's own prefix it is nothing",
    concepts: [statement(A)],
    proofs: [
      // bv_decide's normalizer realizes `<enum>.enumToBitVec` as a public
      // def under the enum's namespace (namespace review, B2)
      decl({ name: "Col.enumToBitVec", kind: "def", origin: { kind: "realized", parent: "Col" } }),
      decl({ name: "Lax1Proofs.Shade.enumToBitVec", kind: "def", origin: { kind: "realized", parent: "Lax1Proofs.Shade" } }),
    ],
    violations: [["namespace", "proof declaration Col.enumToBitVec is a realized definition under an imported name; Lean refuses to import two records that both realize it"]],
  },
  {
    name: "a name a reader cannot read as itself is refused: a combining mark, an invisible joiner, a script mix, a Greek capital lookalike; hα and ℕ are fine",
    concepts: [statement(A), statement("Lax1.Claim.hα"), statement("Lax1.Claim.ℕbound"), statement("Lax1.Claim.Fermat\u034f")],
    proofs: [
      decl({ name: "Lax1Proofs.Ferm\u0430t" }), // Cyrillic а
      decl({ name: "Lax1Proofs.Prime\u039frder" }), // Greek capital Omicron
      decl({ name: "Lax1Proofs.e\u0301tale" }), // e + combining acute: not NFC
      decl({ name: "Lax1Proofs.levels", levelParams: ["u\u034f"] }),
    ],
    violations: [
      ["name-hygiene", "concept declaration Lax1.Claim.Fermat\u034f carries a combining mark or an invisible format character"],
      ["name-hygiene", "proof declaration Lax1Proofs.Ferm\u0430t mixes Latin and Cyrillic in the component \"Ferm\u0430t\""],
      ["name-hygiene", "proof declaration Lax1Proofs.Prime\u039frder mixes Latin and Greek in the component \"Prime\u039frder\""],
      // the collector writes every message in NFC (findings.ts), so the
      // name shows composed here while the rule saw it decomposed
      ["name-hygiene", "proof declaration Lax1Proofs.\u00e9tale is not in Unicode normal form C"],
      ["name-hygiene", "proof declaration Lax1Proofs.levels universe parameter u\u034f carries a combining mark"],
    ],
    statements: [{ id: A }, { id: "Lax1.Claim.hα" }, { id: "Lax1.Claim.ℕbound" }],
  },
  {
    name: "an initializer anywhere in a record is a violation (F1)",
    concepts: [statement(A), decl({ name: "Lax1.Claim.myExt", kind: "opaque", initializer: true })],
    proofs: [decl({ name: "_private.Lax1Proofs.Basic.0.Lax1Proofs.initFn._@.Lax1Proofs.Basic._hyg.12", kind: "def", userName: undefined, initializer: true })],
    violations: [
      ["initialize", "concept module Lax1.Claim declares an initializer (Lax1.Claim.myExt)"],
      ["initialize", "proof module Lax1Proofs.Basic declares an initializer (_private.Lax1Proofs.Basic.0.Lax1Proofs.initFn._@.Lax1Proofs.Basic._hyg.12)"],
    ],
    statements: [{ id: A }],
  },
  {
    name: "a private declaration keeps every rule but the namespace one",
    concepts: [statement(A)],
    proofs: [decl({ name: "_private.Lax1Proofs.Basic.0.hidden_helper", userName: "hidden_helper", axioms: ["sorryAx"] })],
    violations: [["axiom-free", "proof declaration hidden_helper depends on axiom sorryAx"]],
  },
  {
    name: "the marker in the proof package is a violation",
    concepts: [statement(A)],
    proofs: [statement("Lax1Proofs.S")],
    violations: [["marker", "Lax1Proofs.S carries @[lax_statement] in the proof package; statements are declared in the concept package"]],
  },
  {
    name: "a proof of AimpC is the edge {} → AimpC, not {A} → C",
    concepts: [statement(A), statement(C), statement(AIMPC, { body: "Lax1.Claim.A → Lax1.Claim.C" })],
    proofs: [decl({ name: "Lax1Proofs.aimpc", telescope: chain([], [AIMPC]), usedConstants: [AIMPC] })],
    violations: [],
    proofEntries: [{ id: "Lax1Proofs.aimpc", conclusion: AIMPC, assumptions: [], telescope: { hypotheses: [], conclusion: { statement: AIMPC, levels: [] } } }],
  },
  {
    name: "explicit, implicit, strict-implicit, and instance binders are recorded in order",
    concepts: [statement(A), statement(B), statement(C), statement(AIMPC)],
    proofs: [decl({
      name: "Lax1Proofs.binders",
      telescope: chain([[C, [], "default"], [B, [], "implicit"], [A, [], "strictImplicit"], [AIMPC, [], "instImplicit"]], [C]),
    })],
    violations: [],
    proofEntries: [{
      id: "Lax1Proofs.binders",
      conclusion: C,
      assumptions: [A, AIMPC, B, C],
      telescope: {
        hypotheses: [
          { statement: C, levels: [], binder: "default" },
          { statement: B, levels: [], binder: "implicit" },
          { statement: A, levels: [], binder: "strictImplicit" },
          { statement: AIMPC, levels: [], binder: "instImplicit" },
        ],
        conclusion: { statement: C, levels: [] },
      },
    }],
  },
  {
    name: "duplicate hypotheses collapse in assumptions and keep their positions in the telescope",
    concepts: [statement(A), statement(C)],
    proofs: [decl({ name: "Lax1Proofs.dup", telescope: chain([[A], [A]], [C]) })],
    violations: [],
    proofEntries: [{
      id: "Lax1Proofs.dup",
      assumptions: [A],
      telescope: { hypotheses: [{ statement: A, levels: [], binder: "default" }, { statement: A, levels: [], binder: "default" }], conclusion: { statement: C, levels: [] } },
    }],
  },
  {
    name: "a self-edge is a proof like any other",
    concepts: [statement(A)],
    proofs: [decl({ name: "Lax1Proofs.self", telescope: chain([[A]], [A]) })],
    violations: [],
    proofEntries: [{ id: "Lax1Proofs.self", conclusion: A, assumptions: [A] }],
  },
  {
    name: "a conclusion with a repeated level variable proves a special case",
    concepts: [statement(POLY2, { levelParams: ["u", "v"] })],
    proofs: [decl({ name: "Lax1Proofs.rep", levelParams: ["w"], telescope: chain([], [POLY2, [["param", "w"], ["param", "w"]]]) })],
    violations: [["proof", "theorem Lax1Proofs.rep concludes Lax1.Claim.Poly2.{w, w} with `w` repeated; a proof concludes its statement in full generality"]],
    proofEntries: [],
  },
  {
    name: "a hypothesis at a concrete, successor, or max level is a violation naming the level",
    concepts: [statement(POLY, { levelParams: ["u"] }), statement(A)],
    proofs: [
      decl({ name: "Lax1Proofs.zero", levelParams: [], telescope: chain([[POLY, [["zero"]]]], [A]) }),
      decl({ name: "Lax1Proofs.succ", levelParams: ["u"], telescope: chain([[POLY, [["succ", ["param", "u"]]]]], [A]) }),
      decl({ name: "Lax1Proofs.max", levelParams: ["u", "v"], telescope: chain([[POLY, [["max", ["param", "u"], ["param", "v"]]]]], [A]) }),
      decl({ name: "Lax1Proofs.foreign", levelParams: [], telescope: chain([[POLY, [["param", "u"]]]], [A]) }),
    ],
    violations: [
      ["proof", "theorem Lax1Proofs.zero instantiates Lax1.Claim.Poly at universe level `0`; every level argument of a statement in a proof's type must be a universe parameter of the proof"],
      ["proof", "theorem Lax1Proofs.succ instantiates Lax1.Claim.Poly at universe level `u+1`"],
      ["proof", "theorem Lax1Proofs.max instantiates Lax1.Claim.Poly at universe level `max u v`"],
      ["proof", "theorem Lax1Proofs.foreign instantiates Lax1.Claim.Poly at universe level `u`"],
    ],
    proofEntries: [],
  },
  {
    name: "a universe-polymorphic proof over its own parameters is recorded with parameter names",
    concepts: [statement(POLY, { levelParams: ["u"] }), statement(POLY2, { levelParams: ["u", "v"] })],
    proofs: [decl({ name: "Lax1Proofs.poly", levelParams: ["a", "b"], telescope: chain([[POLY, [["param", "a"]]], [POLY, [["param", "b"]]]], [POLY2, [["param", "a"], ["param", "b"]]]) })],
    violations: [],
    proofEntries: [{
      id: "Lax1Proofs.poly",
      levelParams: ["a", "b"],
      telescope: {
        hypotheses: [{ statement: POLY, levels: ["a"], binder: "default" }, { statement: POLY, levels: ["b"], binder: "default" }],
        conclusion: { statement: POLY2, levels: ["a", "b"] },
      },
      assumptions: [POLY],
      conclusion: POLY2,
    }],
  },
  {
    name: "a statement of a directly required package is assumable",
    concepts: [statement(C)],
    proofs: [decl({ name: "Lax1Proofs.direct", telescope: chain([["Lax2.X.s"]], [C]) })],
    proofImports: ["Lax1.Claim", "Lax2.X"],
    resolution: { concepts: [], proofs: [dependency("Lax2", ["Lax2.X.s"])], all: [dependency("Lax2", ["Lax2.X.s"])] },
    violations: [],
    proofEntries: [{ id: "Lax1Proofs.direct", conclusion: C, assumptions: ["Lax2.X.s"] }],
  },
  {
    name: "a statement reachable only transitively is a violation, not a helper",
    concepts: [statement(C)],
    proofs: [decl({ name: "Lax1Proofs.far", telescope: chain([["Lax3.Y.t"]], [C]) })],
    proofImports: ["Lax1.Claim", "Lax2.X"],
    resolution: {
      concepts: [],
      proofs: [dependency("Lax2", ["Lax2.X.s"], ["Lax3"])],
      all: [dependency("Lax2", ["Lax2.X.s"], ["Lax3"]), dependency("Lax3", ["Lax3.Y.t"])],
    },
    violations: [["proof", "theorem Lax1Proofs.far has the shape of a proof, but Lax3.Y.t is a statement of Lax3, which the proof package does not require directly — to assume or conclude a statement, require its package"]],
    proofEntries: [],
  },
  {
    name: "a private theorem of proof shape is a violation with a hint",
    concepts: [statement(A), statement(C)],
    proofs: [decl({ name: "_private.Lax1Proofs.Basic.0.Lax1Proofs.hidden", userName: "Lax1Proofs.hidden", telescope: chain([[A]], [C]) })],
    violations: [["proof", "private theorem Lax1Proofs.hidden has the shape of a proof ({Lax1.Claim.A} → Lax1.Claim.C); the archive's certificate must name it from another module — drop `private`"]],
    proofEntries: [],
  },
  {
    name: "a helper whose type is a ∀ but not a chain of statements is a helper and warns when unused",
    concepts: [statement(A)],
    proofs: [
      decl({ name: "Lax1Proofs.helper", telescope: null }),
      decl({ name: "Lax1Proofs.overTrue", telescope: chain([["True"]], [A]) }),
      decl({ name: "Lax1Proofs.defShape", kind: "def", telescope: chain([[A]], [A]) }),
    ],
    violations: [],
    proofEntries: [],
    warnings: [
      "helper lemma Lax1Proofs.helper is not used, directly or transitively, by any proof theorem in this submission; keep it only if this is intentional",
      "helper lemma Lax1Proofs.overTrue is not used, directly or transitively, by any proof theorem in this submission; keep it only if this is intentional",
    ],
  },
  {
    name: "frontmatter on any proof-package declaration names the spec-1 habit",
    concepts: [statement(A)],
    proofs: [
      decl({ name: "Lax1Proofs.habit", telescope: chain([], [A]), doc: { hasFrontmatter: true, scalars: [["conclusion", A]], lists: [], description: "old style" } }),
      decl({ name: "Lax1Proofs.emptyFm", doc: { hasFrontmatter: true, scalars: [], lists: [], description: "a helper with an empty block" } }),
    ],
    violations: [
      ["frontmatter", "docstring of Lax1Proofs.habit carries yaml frontmatter; spec 2 has no proof frontmatter — a proof's conclusion and assumptions are its type (`theorem Q (h : S) : C`), and the spec-1 `conclusion:`/`assumptions:` keys are gone"],
      ["frontmatter", "docstring of Lax1Proofs.emptyFm carries yaml frontmatter"],
    ],
  },
  {
    name: "the axiom kind is a violation in either package, used or not",
    concepts: [statement(A), decl({ name: "Lax1.Claim.ax", kind: "axiom", axioms: ["Lax1.Claim.ax"], signature: "True" })],
    proofs: [decl({ name: "Lax1Proofs.ax", kind: "axiom", axioms: ["Lax1Proofs.ax"], telescope: chain([], [A]) })],
    violations: [
      ["axiom-free", "concept declaration Lax1.Claim.ax is an axiom; spec 2 declares no axioms"],
      ["axiom-free", "proof declaration Lax1Proofs.ax is an axiom; spec 2 declares no axioms"],
    ],
    statements: [{ id: A }],
    proofEntries: [],
  },
  {
    name: "sorry through a helper and a native-computation axiom are not background",
    concepts: [statement(A)],
    proofs: [
      decl({ name: "Lax1Proofs.leaky", axioms: ["sorryAx"] }),
      decl({ name: "Lax1Proofs.viaLeaky", telescope: chain([], [A]), usedConstants: ["Lax1Proofs.leaky"], axioms: ["propext", "sorryAx"] }),
      decl({ name: "Lax1Proofs.native", telescope: chain([], [A]), axioms: ["Lean.ofReduceBool"] }),
    ],
    violations: [
      ["axiom-free", "proof declaration Lax1Proofs.leaky depends on axiom sorryAx; spec 2 admits only the background axioms propext, Classical.choice, Quot.sound"],
      ["axiom-free", "proof declaration Lax1Proofs.viaLeaky depends on axiom sorryAx"],
      ["axiom-free", "proof declaration Lax1Proofs.native depends on axiom Lean.ofReduceBool"],
    ],
  },
  {
    name: "a statement in the concept package resting on sorry is a violation too",
    concepts: [statement(A, { axioms: ["sorryAx"] })],
    proofs: [],
    violations: [["axiom-free", "concept declaration Lax1.Claim.A depends on axiom sorryAx"]],
  },
  // ── provenance-based ownership (codex review 2 2026-10-04, finding 1) ──
  {
    name: "the dependency side of the internal-name scenario: a def under another record's namespace is a namespace violation however internal its name looks",
    concepts: [decl({ name: "Lax2.C.A.B.proof_1", kind: "def", isProp: true, userName: undefined })],
    proofs: [],
    violations: [["namespace", "concept declaration Lax2.C.A.B.proof_1 does not carry namespace Lax1.Claim"]],
    statements: [],
  },
  {
    name: "the record side: an authored tagged def with an internal-looking, non-canonical name is refused by the canonical rule, never flattened",
    concepts: [statement("Lax1.Claim.«A.B».proof_1", { nonCanonical: true, userName: undefined })],
    proofs: [],
    violations: [["name-not-canonical", "concept declaration Lax1.Claim.«A.B».proof_1 has a component Lean must quote"]],
    statements: [],
  },
  {
    name: "a tagged declaration Lean generated (an auxiliary of an own declaration) is refused as an endpoint by its origin",
    concepts: [statement("Lax1.Claim.A.proof_1", { userName: undefined, origin: { kind: "auxiliary", parent: "Lax1.Claim.A" } })],
    proofs: [],
    violations: [["statement", "Lax1.Claim.A.proof_1 carries @[lax_statement] but is not an authored declaration — Lean generated it for Lax1.Claim.A"]],
    statements: [],
  },
  {
    name: "a tagged declaration Lean realized is refused as an endpoint by its origin, whatever its display name",
    concepts: [statement("Lax1.Claim.A.eq_1", { origin: { kind: "realized", parent: "Lax1.Claim.A" } })],
    proofs: [],
    violations: [["statement", "Lax1.Claim.A.eq_1 carries @[lax_statement] but is not an authored declaration — Lean realized it under Lax1.Claim.A"]],
    statements: [],
  },
  {
    name: "a proof over a constant the inspector had to escape is refused, not read as a proof of the flattened name",
    concepts: [statement(A)],
    proofs: [decl({ name: "Lax1Proofs.p", telescope: chain([], ["Lax1.Claim.«A.B».proof_1"]) })],
    violations: [["proof", "theorem Lax1Proofs.p has the shape of a proof over Lax1.Claim.«A.B».proof_1, whose name the archive's canonical form cannot carry"]],
    proofEntries: [],
  },
  {
    name: "a proof over a canonical constant that is no registered statement is a helper, however internal the constant looks",
    concepts: [statement(A)],
    proofs: [decl({ name: "Lax1Proofs.p", telescope: chain([], ["Lax1.Claim.A.B.proof_1"]) })],
    violations: [],
    proofEntries: [],
  },
  {
    // `def f (h : A) : {n // A} := ⟨0, …⟩` abstracts its nested proof into
    // `f._proof_1 : A → A`; an equation lemma can have the same shape. The
    // certificate never names either, so the gate excludes rather than
    // refuses (ultracode review 2026-10-04, I1)
    name: "a theorem of proof shape that Lean generated or realized is a helper, never an edge and never refused",
    concepts: [statement(A)],
    proofs: [
      decl({ name: "Lax1Proofs.f", kind: "def" }),
      decl({ name: "Lax1Proofs.f._proof_1", userName: undefined, origin: { kind: "auxiliary", parent: "Lax1Proofs.f" }, telescope: chain([[A]], [A]) }),
      decl({ name: "Lax1Proofs.f.eq_1", userName: undefined, origin: { kind: "realized", parent: "Lax1Proofs.f" }, telescope: chain([], [A]) }),
    ],
    violations: [],
    proofEntries: [],
  },
  {
    // `private def f (h : A) : {n // A} := ⟨0, …⟩` abstracts into
    // `_private.<module>.0.f._proof_1 : A → A`; the inspector reports it
    // private with the parent it was generated for, so the private-proof
    // rule — about theorems written `private` — never sees it (ultracode
    // review 2026-10-04, I1 follow-up)
    name: "a theorem of proof shape Lean generated under a private parent is a helper, not a private proof",
    concepts: [statement(A)],
    proofs: [
      decl({ name: "_private.Lax1Proofs.Basic.0.Lax1Proofs.f", userName: "Lax1Proofs.f", kind: "def" }),
      decl({
        name: "_private.Lax1Proofs.Basic.0.Lax1Proofs.f._proof_1",
        userName: undefined,
        origin: { kind: "private", module: "Lax1Proofs.Basic", parent: "Lax1Proofs.f" },
        telescope: chain([[A]], [A]),
      }),
    ],
    violations: [],
    proofEntries: [],
  },
  {
    name: "a theorem of proof shape under macro scopes or of an unreported origin is refused as an endpoint",
    concepts: [statement(A)],
    proofs: [
      decl({ name: "Lax1Proofs.p._@.Lax1Proofs.Basic._hyg.3", userName: undefined, nonCanonical: true, origin: { kind: "scoped", module: "Lax1Proofs.Basic" }, telescope: chain([], [A]) }),
      decl({ name: "Lax1Proofs.q", origin: undefined, telescope: chain([], [A]) }),
    ],
    violations: [
      ["proof", "proof declaration Lax1Proofs.p._@.Lax1Proofs.Basic._hyg.3 has the shape of a proof but is not an authored declaration — it carries macro scopes of Lax1Proofs.Basic — a macro must give a proof a plain name (`mkIdent`)"],
      ["proof", "proof declaration Lax1Proofs.q has the shape of a proof but is not an authored declaration — its origin is unknown"],
    ],
    proofEntries: [],
  },
  {
    name: "an honest package's generated names all carry the prefix or an origin Lean vouches for, and pass",
    concepts: [
      statement(A),
      // `structure`/`inductive` internals extend the type's name
      decl({ name: "Lax1.Claim.S", kind: "inductive", userName: "Lax1.Claim.S" }),
      decl({ name: "Lax1.Claim.S.rec", kind: "rec", userName: undefined, origin: { kind: "auxiliary", parent: "Lax1.Claim.S" } }),
      decl({ name: "Lax1.Claim.S.mk.injEq", kind: "theorem", userName: undefined, origin: { kind: "auxiliary", parent: "Lax1.Claim.S.mk" } }),
    ],
    proofs: [
      decl({ name: "Lax1Proofs.f", kind: "def" }),
      // `match` compiles to `<fn>.match_<n>`, `decreasing_by` to `<fn>.proof_<n>`
      decl({ name: "Lax1Proofs.f.match_1", kind: "def", userName: undefined, origin: { kind: "auxiliary", parent: "Lax1Proofs.f" } }),
      decl({ name: "Lax1Proofs.f.proof_1", kind: "theorem", userName: undefined, origin: { kind: "auxiliary", parent: "Lax1Proofs.f" } }),
      // equation lemmas are realized under the function, own or imported
      decl({ name: "Lax1Proofs.f.eq_1", kind: "theorem", userName: undefined, origin: { kind: "realized", parent: "Lax1Proofs.f" } }),
      decl({ name: "Nat.add.eq_1", kind: "theorem", userName: undefined, origin: { kind: "realized", parent: "Nat.add" } }),
      decl({ name: "Nat.add.congr_simp", kind: "theorem", userName: undefined, origin: { kind: "realized", parent: "Nat.add" } }),
      // a matcher's splitter is private per module, under its own module
      decl({ name: "_private.Lax1Proofs.Basic.0.Nat.add.match_1.splitter", kind: "def", userName: undefined }),
      // an auto-named instance under the namespace, a private helper
      decl({ name: "Lax1Proofs.instDecidableEqS", kind: "def" }),
      decl({ name: "_private.Lax1Proofs.Basic.0.Lax1Proofs.helper", userName: "Lax1Proofs.helper" }),
      // a macro-scoped auxiliary: non-canonical by construction, never translated
      decl({ name: "Lax1Proofs.foo._@.Lax1Proofs.Basic._hyg.3", kind: "def", userName: undefined, nonCanonical: true, origin: { kind: "scoped", module: "Lax1Proofs.Basic" } }),
    ],
    violations: [],
  },
  {
    name: "a private or scoped name of another module is held to the prefix on its un-mangled form",
    concepts: [statement(A)],
    proofs: [
      decl({ name: "_private.Lax2Proofs.Basic.0.Lax2Proofs.helper", userName: "Lax2Proofs.helper" }),
      decl({ name: "Lax2Proofs.foo._@.Lax2Proofs.Basic._hyg.3", kind: "def", userName: undefined, nonCanonical: true, origin: { kind: "scoped", module: "Lax2Proofs.Basic" } }),
    ],
    violations: [
      ["namespace", "proof declaration Lax2Proofs.helper does not carry namespace Lax1Proofs"],
      ["namespace", "proof declaration Lax2Proofs.foo._@.Lax2Proofs.Basic._hyg.3 does not carry namespace Lax1Proofs"],
    ],
  },
  {
    name: "two authored copies of one theorem name are refused, and each module's body is judged: the sorry copy fails hygiene",
    concepts: [statement(A)],
    proofs: [
      decl({ name: "Lax1Proofs.h.proof_1", userName: undefined }),
      decl({ name: "Lax1Proofs.h.proof_1", userName: undefined, axioms: ["sorryAx"] }),
    ],
    violations: [
      ["duplicate-name", "proof declaration Lax1Proofs.h.proof_1 is declared twice"],
      ["axiom-free", "proof declaration Lax1Proofs.h.proof_1 depends on axiom sorryAx"],
    ],
  },
  {
    name: "two realized copies of one theorem are the realization Lean admits from two modules",
    concepts: [statement(A)],
    proofs: [
      decl({ name: "Nat.add.eq_1", userName: undefined, origin: { kind: "realized", parent: "Nat.add" } }),
      decl({ name: "Nat.add.eq_1", userName: undefined, origin: { kind: "realized", parent: "Nat.add" } }),
    ],
    violations: [],
  },
];

describe("spec-2 classification", () => {
  for (const testCase of CASES) {
    it(testCase.name, () => {
      const fixture = reports(testCase.concepts, testCase.proofs, testCase.proofImports);
      const judged = judgeInspection(
        fixture.concepts,
        fixture.proofs,
        CONCEPT_INVENTORY,
        PROOF_INVENTORY,
        testCase.resolution ?? EMPTY_RESOLUTION,
        "both",
        undefined,
        LIBRARY_ROOTS,
        2,
      );
      const actual = judged.findings.violations.map((finding) => `[${finding.rule}] ${finding.message}`);
      expect(actual).toHaveLength(testCase.violations.length);
      // decision 10: the rules that decide what edge a theorem is answer
      // `translation`; every other inspect finding is an archive standard
      for (const finding of [...judged.findings.violations, ...judged.findings.warnings]) {
        const translation = ["statement", "proof", "name-not-canonical", "name-hygiene", "duplicate-name"].includes(finding.rule);
        expect(finding.intent, `${finding.rule}: ${finding.message}`).toBe(translation ? "translation" : "standards");
      }
      for (const [rule, substring] of testCase.violations) {
        expect(actual.some((line) => line.startsWith(`[${rule}] `) && line.includes(substring)), `${rule}: ${substring}\n${actual.join("\n")}`).toBe(true);
      }
      if (testCase.statements !== undefined) {
        const statements = judged.result.concepts.flatMap((concept) => concept.statements);
        expect(statements).toHaveLength(testCase.statements.length);
        for (const [index, expected] of testCase.statements.entries()) expect(statements[index]).toMatchObject(expected);
      }
      if (testCase.proofEntries !== undefined) {
        expect(judged.result.proofs).toHaveLength(testCase.proofEntries.length);
        for (const [index, expected] of testCase.proofEntries.entries()) expect(judged.result.proofs[index]).toMatchObject(expected);
      }
      if (testCase.warnings !== undefined) {
        expect(judged.findings.warnings.map((finding) => finding.message)).toEqual(testCase.warnings);
      }
    });
  }

  it("a module registering global syntax is a violation; scoped and local syntax leave no global entry (E1)", () => {
    const fixture = reports([statement(A)], [decl({ name: "Lax1Proofs.helper" })]);
    fixture.proofs.modules[1]!.globalSyntax = ["Lean.Parser.parserExtension", "Lean.Elab.macroAttribute"];
    fixture.concepts.modules[1]!.globalSyntax = ["Lean.Elab.Term.termElabAttribute"];
    const judged = judgeInspection(fixture.concepts, fixture.proofs, CONCEPT_INVENTORY, PROOF_INVENTORY, EMPTY_RESOLUTION, "both", undefined, LIBRARY_ROOTS, 2);
    const actual = judged.findings.violations.map((finding) => `[${finding.rule}] ${finding.message}`);
    expect(actual).toEqual([
      "[global-syntax] concept module Lax1.Claim registers global syntax (a term elaborator); a record declares every `syntax`, `notation`, `macro`, `macro_rules`, and `elab` as `scoped` or `local`",
      "[global-syntax] proof module Lax1Proofs.Basic registers global syntax (a parser or token, a macro); a record declares every `syntax`, `notation`, `macro`, `macro_rules`, and `elab` as `scoped` or `local`",
    ]);
    for (const finding of judged.findings.violations) expect(finding.intent).toBe("standards");
    const quiet = reports([statement(A)], [decl({ name: "Lax1Proofs.helper" })]);
    quiet.proofs.modules[1]!.globalSyntax = [];
    expect(judgeInspection(quiet.concepts, quiet.proofs, CONCEPT_INVENTORY, PROOF_INVENTORY, EMPTY_RESOLUTION, "both", undefined, LIBRARY_ROOTS, 2).findings.violations).toEqual([]);
  });

  it("records a proof entry in the documented key order with levelParams and telescope", () => {
    const fixture = reports([statement(A), statement(C)], [decl({
      name: "Lax1Proofs.q",
      telescope: chain([[A]], [C]),
      doc: { hasFrontmatter: false, scalars: [], lists: [], description: "By hand.\n\n# Strategy\n\nDirect." },
    })]);
    const judged = judgeInspection(fixture.concepts, fixture.proofs, CONCEPT_INVENTORY, PROOF_INVENTORY, EMPTY_RESOLUTION, "both", undefined, LIBRARY_ROOTS, 2);
    expect(judged.findings.violations).toEqual([]);
    const proof = judged.result.proofs[0]!;
    expect(Object.keys(proof)).toEqual(["id", "path", "levelParams", "telescope", "conclusion", "assumptions", "description", "sections"]);
    expect(proof).toEqual({
      id: "Lax1Proofs.q",
      path: "proofs/Lax1Proofs/Basic.lean",
      levelParams: [],
      telescope: { hypotheses: [{ statement: A, levels: [], binder: "default" }], conclusion: { statement: C, levels: [] } },
      conclusion: C,
      assumptions: [A],
      description: "By hand.",
      sections: [{ title: "Strategy", markdown: "Direct." }],
    });
    const recorded = judged.result.concepts[0]!.statements[0]!;
    expect(Object.keys(recorded)).toEqual(["id", "levelParams", "signature", "body", "doc"]);
  });

  it("a universe-polymorphic statement's signature names its parameters", () => {
    const fixture = reports([statement(POLY2, { levelParams: ["u", "v"], body: "∀ (x : Sort u) (x : Sort v), True" })], []);
    const judged = judgeInspection(fixture.concepts, fixture.proofs, CONCEPT_INVENTORY, PROOF_INVENTORY, EMPTY_RESOLUTION, "both", undefined, LIBRARY_ROOTS, 2);
    expect(judged.result.concepts[0]!.statements[0]).toMatchObject({ signature: "Poly2.{u, v} : Prop", levelParams: ["u", "v"] });
  });

  it("the spec-1 rules are untouched by the spec-2 facts: an axiom is still a statement under spec 1", () => {
    // The same report judged under spec 1 reads the spec-1 shape (axioms as
    // statements, frontmatter as proofs) and never sees the spec-2 facts.
    const fixture = reports(
      [decl({ name: "Lax1.Claim.s", kind: "axiom", axioms: ["Lax1.Claim.s"], signature: "True" })],
      [decl({
        name: "Lax1Proofs.p",
        doc: { hasFrontmatter: true, scalars: [["conclusion", "Lax1.Claim.s"]], lists: [], description: "spec 1" },
        conclusionFacts: { resolves: true, isAxiom: true, originModule: "Lax1.Claim", originReachable: true, defeq: true },
      })],
    );
    const judged = judgeInspection(fixture.concepts, fixture.proofs, CONCEPT_INVENTORY, PROOF_INVENTORY, EMPTY_RESOLUTION, "both", undefined, LIBRARY_ROOTS, 1);
    expect(judged.findings.violations).toEqual([]);
    expect(judged.result.concepts[0]!.statements.map((entry) => entry.id)).toEqual(["Lax1.Claim.s"]);
    expect(judged.result.proofs.map((proof) => [proof.conclusion, proof.telescope])).toEqual([["Lax1.Claim.s", undefined]]);
  });

  it("renders levels in Lean's surface syntax for findings", () => {
    expect(renderLevel(["zero"])).toBe("0");
    expect(renderLevel(["param", "u"])).toBe("u");
    expect(renderLevel(["succ", ["succ", ["param", "u"]]])).toBe("u+1+1");
    expect(renderLevel(["succ", ["max", ["param", "u"], ["param", "v"]]])).toBe("(max u v)+1");
    expect(renderLevel(["imax", ["succ", ["param", "u"]], ["zero"]])).toBe("imax (u+1) 0");
  });
});
