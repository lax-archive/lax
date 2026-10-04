// The certificate generator (axiomfree-plan.md, "Certify" 1; the draft spec's
// "Certification", "The bundle"): from a spec-2 record's proof entries — their
// telescopes and universe parameters, exactly as `build-output.json` records
// them — and the packages involved, the four files `lake comparator` judges.
//
//   Challenge.lean    imports the concept packages the edges name and nothing
//                     of any proof package; per proof one theorem named
//                     after the proof itself, `<proof-id>.{us} (h₁ : S₁) … :
//                     C := sorry`, with the proof's own level parameters;
//                     every hypothesis an explicit binder, whatever kind the
//                     proof declared it with — the comparator's comparison
//                     (`Expr.eqv`) ignores binder names and kinds
//   comparator.json   the theorem names, `solution_module` the proof
//                     package's root, no definition holes, the three
//                     background axioms
//   lakefile.toml     the environment's libraries at the row's pins and every
//                     involved package, as git requires (a database record's
//                     source triple) or path requires (a local build)
//   lake-manifest.json the complete manifest, so the comparator resolves
//                     nothing (host/warmstore.ts manifestText)
//
// There is no Solution file for a record (ultracode review 2026-10-04, C1):
// the comparator looks every theorem name up in the proof package's own
// export and holds the author's constant to the Challenge's directly. A
// *relative* certificate composes several proofs into one theorem that no
// package declares, so its bundle carries a fifth file, `Solution.lean`,
// and names its theorem `Cert.<statement-id>` (relativeCertificateFiles);
// the two bundle shapes differ by that one file.
//
// Pure: no filesystem, no environment. Deterministic by construction: proofs
// are emitted in id order, imports sorted, and every name goes through
// `leanName` — a universe parameter through `leanLevel` —
// (certify/lean-name.ts), never interpolated from a raw string.
// The trusted artifact parser regenerates the Challenge and the
// configuration from a record's own `proofs` and holds the record to them,
// which is why the content files take the proofs alone.

import { createHash } from "node:crypto";
import type { ProofEntry, ProofTelescope } from "../contracts.js";
import type { PinnedLibrary } from "../environments.js";
import { leanFacts, type LeanFacts } from "../lean-facts.js";
import type { SeededDependency } from "../host/warmstore.js";
import { leanLevel, leanName } from "./lean-name.js";

/** A proof as the generator needs it: a spec-2 entry with its telescope. */
export type CertifiedProof = Pick<ProofEntry, "id"> & {
  levelParams: string[];
  telescope: ProofTelescope;
};

/** Where a required package comes from: a database record's source triple
 * (the bundle a reader reruns) or a directory relative to the generated
 * project (a local build's own packages, symlinked under it). */
export type PackageSource =
  | { git: string; rev: string; subDir: string }
  | { path: string };

export interface CertifyPackage {
  name: string;
  source: PackageSource;
}

export const CHALLENGE_MODULE = "Challenge";
/** A relative certificate's composed Solution module; a record's solution
 * module is its proof package's root. */
export const SOLUTION_MODULE = "Solution";
export const CERTIFICATE_PACKAGE = "LaxCertificate";
/** The prefix of a relative certificate's theorem: `Cert.<statement-id>`. */
export const RELATIVE_THEOREM_PREFIX = "Cert";

/** Every file a bundle may hold, in the order the tar carries them (byte
 * order). */
export const BUNDLE_FILES = [
  "Challenge.lean",
  "Solution.lean",
  "comparator.json",
  "lake-manifest.json",
  "lakefile.toml",
] as const;
export type BundleFile = (typeof BUNDLE_FILES)[number];
/** A record's bundle: the four files, no Solution (the proof package is the
 * solution module). */
export const RECORD_BUNDLE_FILES = ["Challenge.lean", "comparator.json", "lake-manifest.json", "lakefile.toml"] as const;
export type RecordBundle = Record<(typeof RECORD_BUNDLE_FILES)[number], string>;
/** A relative certificate's bundle: the record shape plus `Solution.lean`. */
export type RelativeBundle = Record<BundleFile, string>;
export type Bundle = RecordBundle | RelativeBundle;

/** The members of a bundle in tar order — the record's four or a relative
 * certificate's five, never another set: the one place the two shapes are
 * told apart, for sealing and for reading a bundle back. */
export function bundleMembers(files: Readonly<Partial<Record<BundleFile, string>>>): Array<{ name: BundleFile; content: string }> {
  const present = BUNDLE_FILES.filter((name) => files[name] !== undefined);
  const shape = present.length === RECORD_BUNDLE_FILES.length ? RECORD_BUNDLE_FILES : BUNDLE_FILES;
  if (present.length !== shape.length || present.some((name, index) => name !== shape[index]))
    throw new Error(`a bundle holds ${RECORD_BUNDLE_FILES.join(", ")} (a record) or ${BUNDLE_FILES.join(", ")} (a relative certificate), not ${present.join(", ") || "nothing"}`);
  return present.map((name) => ({ name, content: files[name]! }));
}

/** A proof entry of a build output, narrowed to the spec-2 shape or refused:
 * a spec-1 entry has no telescope, and the generator is never asked for one. */
export function certifiedProof(proof: ProofEntry): CertifiedProof {
  if (proof.telescope === undefined || proof.levelParams === undefined)
    throw new Error(`proof ${proof.id} carries no telescope; only a spec-2 record is certified`);
  return { id: proof.id, levelParams: proof.levelParams, telescope: proof.telescope };
}

/** Proofs in the order every generated file lists them: by id. */
export function orderedProofs(proofs: readonly CertifiedProof[]): CertifiedProof[] {
  return [...proofs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** One edge as the certificate states it: the proof — which is also the
 * Challenge theorem's name — its hypotheses in binder order (duplicates
 * kept: exactly the theorem's binders), and its conclusion. Not stored —
 * derived for findings and for the website from the telescopes
 * (recorded-shape.ts). */
export interface CertificateEdge {
  proof: string;
  hypotheses: string[];
  conclusion: string;
}

/** The edges the certificate states, in Challenge order. */
export function edgesOf(proofs: readonly CertifiedProof[]): CertificateEdge[] {
  return orderedProofs(proofs).map((proof) => ({
    proof: proof.id,
    hypotheses: proof.telescope.hypotheses.map((hypothesis) => hypothesis.statement),
    conclusion: proof.telescope.conclusion.statement,
  }));
}

/** The Lake package a canonical name belongs to: its first component (the
 * namespace rule of phases/inspect-common.ts puts every declaration under its
 * package's prefix). */
export function packageOf(name: string): string {
  return name.split(".")[0]!;
}

/** The concept packages the edges name, sorted: what the Challenge imports. */
export function conceptPackagesOf(proofs: readonly CertifiedProof[]): string[] {
  const names = new Set<string>();
  for (const proof of proofs) {
    for (const hypothesis of proof.telescope.hypotheses) names.add(packageOf(hypothesis.statement));
    names.add(packageOf(proof.telescope.conclusion.statement));
  }
  return [...names].sort();
}

/** The proof packages the edges live in, sorted: a record's one, or what a
 * relative certificate's Solution imports. */
export function proofPackagesOf(proofs: readonly CertifiedProof[]): string[] {
  return [...new Set(proofs.map((proof) => packageOf(proof.id)))].sort();
}

const SUBSCRIPT_DIGITS = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"];

/** `.{«u», «v»}` for a level list, empty for none; every level is a
 * parameter name (never a concrete level — the universe rule) and goes
 * through `leanLevel`, quoted. */
export function universes(levels: readonly string[]): string {
  return levels.length === 0 ? "" : `.{${levels.map(leanLevel).join(", ")}}`;
}

/**
 * A constant referenced from inside a certificate theorem. A theorem named
 * `<proof-id>` or `Cert.<statement-id>` elaborates in the namespace its name
 * opens, where a statement's name could resolve relative to that namespace
 * — and, in a relative Solution's body, a proof's own name to the theorem
 * being declared (a recursive reference — "fail to show termination",
 * found by the first e2e run). `_root_` pins every reference to the global
 * name.
 */
export function rootName(canonical: string): string {
  return `_root_.${leanName(canonical)}`;
}

/**
 * A certificate theorem as the generator states it: its canonical name
 * (the proof's own id for an edge, `Cert.<statement-id>` for a relative
 * certificate), its universe parameters, and the chain it states. An edge's
 * is the proof's own; a relative certificate's is the implied edge `{given
 * statements} → statement`. An edge's name cannot clash inside the
 * Challenge: the Challenge imports concept packages only, and proof ids
 * live under `…Proofs`, a prefix no concept package declares under.
 */
export interface CertificateTheorem {
  name: string;
  levelParams: string[];
  telescope: ProofTelescope;
}

/** The theorem an edge states: the proof's chain under the proof's own
 * name, which is what the comparator looks up in the proof package. */
export function edgeTheorem(proof: CertifiedProof): CertificateTheorem {
  return { name: proof.id, levelParams: proof.levelParams, telescope: proof.telescope };
}

/** The name of the i-th hypothesis of a certificate theorem: `h₁`, `h₂`, … */
export function hypothesisName(index: number): string {
  return `h${String(index + 1).split("").map((digit) => SUBSCRIPT_DIGITS[Number(digit)]).join("")}`;
}

/** One theorem, statement only; `body` discharges it. Every hypothesis is
 * an explicit binder `(hᵢ : Sᵢ)`: the comparator compares types with
 * `Expr.eqv`, which ignores binder names and kinds, and a relative
 * Solution applies its proofs with `@`, so the kind a proof declared is
 * irrelevant and not recorded. A body spanning several lines (a composed
 * relative certificate) goes under `:=` on its own lines; a one-line body
 * (`sorry`) stays beside it. */
export function theoremText(statement: CertificateTheorem, body: string): string {
  const name = leanName(statement.name) + universes(statement.levelParams);
  const conclusion =
    rootName(statement.telescope.conclusion.statement) + universes(statement.telescope.conclusion.levels);
  const discharge = body.includes("\n") ? `:=\n${body}` : `:= ${body}`;
  if (statement.telescope.hypotheses.length === 0) return `theorem ${name} : ${conclusion} ${discharge}\n`;
  const binders = statement.telescope.hypotheses.map((hypothesis, index) =>
    `    (${hypothesisName(index)} : ${rootName(hypothesis.statement) + universes(hypothesis.levels)})\n`);
  return `theorem ${name}\n${binders.join("")}    : ${conclusion} ${discharge}\n`;
}

function imports(modules: readonly string[]): string {
  return modules.map((module) => `import ${leanName(module)}\n`).join("");
}

/** `Challenge.lean`: the edges stated over the concept packages alone, each
 * theorem under its proof's name. */
export function challengeText(proofs: readonly CertifiedProof[]): string {
  const ordered = orderedProofs(proofs);
  return (
    "-- The certificate challenge: every proof of the record, stated over its concept\n" +
    "-- packages alone. Generated by lax; `lake comparator` holds the proof package to it.\n" +
    imports(conceptPackagesOf(ordered)) +
    ordered.map((proof) => `\n${theoremText(edgeTheorem(proof), "sorry")}`).join("")
  );
}

/**
 * The three content files of a *relative* certificate (axiomfree-plan.md,
 * "CLI, authoring, website"; the draft spec's "Relative certificates"): one
 * theorem `Cert.<statement-id>` stating the implied edge `{given} →
 * statement`, discharged in the Solution by `body` — the proofs of the
 * witness forest applied to one another (certify/compose.ts). The Challenge
 * imports the concept packages the theorem names; the Solution the proof
 * packages the body applies. The bundle differs from a record's by this
 * one Solution file (and `Solution` as the solution module); same headers,
 * same escaping, so a reader reruns both the same way.
 */
export function relativeCertificateFiles(input: {
  theorem: CertificateTheorem;
  body: string;
  conceptPackages: readonly string[];
  proofPackages: readonly string[];
}): Pick<Record<BundleFile, string>, "Challenge.lean" | "Solution.lean" | "comparator.json"> {
  const concepts = [...new Set(input.conceptPackages)].sort();
  const proofs = [...new Set(input.proofPackages)].sort();
  return {
    "Challenge.lean":
      "-- The certificate challenge: one statement proven relative to the given ones, stated over\n" +
      "-- the concept packages alone. Generated by lax; `lake comparator` holds the Solution to it.\n" +
      imports(concepts) +
      `\n${theoremText(input.theorem, "sorry")}`,
    "Solution.lean":
      "-- The certificate solution: the Challenge's theorem, discharged by the archive's proofs\n" +
      "-- applied along the proof network's witness forest. Generated by lax.\n" +
      imports(proofs) +
      `\n${theoremText(input.theorem, input.body)}`,
    // Quoted as the source spells it: `lake comparator` reads the name with
    // `String.toName` (see theoremNamesOf).
    "comparator.json": comparatorConfigFor([leanName(input.theorem.name)], SOLUTION_MODULE),
  };
}

/** `comparator.json` of a record: its proofs' names, and the proof
 * package's root as the solution module — the root imports every module of
 * the package (the root-module rule), so its export reaches every proof.
 * `definition_names` is always empty — a spec-2 certificate has no
 * definition holes — and the permitted axioms are the background three
 * (lean-facts.ts). */
export function comparatorConfigText(proofs: readonly CertifiedProof[]): string {
  return comparatorConfigFor(theoremNamesOf(proofs), proofPackageRoot(proofs));
}

/** The one proof package a record's proofs live in: its root module (the
 * package name, phases/inventory.ts) is the record's solution module. */
export function proofPackageRoot(proofs: readonly CertifiedProof[]): string {
  const packages = proofPackagesOf(proofs);
  if (packages.length !== 1) throw new Error(`a record's proofs live in one proof package, not ${packages.join(", ") || "none"}`);
  return packages[0]!;
}

/** The configuration for any list of certificate theorems, in the order
 * given, judged against `solutionModule`. */
export function comparatorConfigFor(
  theoremNames: readonly string[],
  solutionModule: string,
  challengeModule: string = CHALLENGE_MODULE,
): string {
  return `${JSON.stringify(
    {
      challenge_module: challengeModule,
      solution_module: solutionModule,
      theorem_names: [...theoremNames],
      definition_names: [],
      permitted_axioms: [...leanFacts().backgroundAxioms],
    },
    null,
    2,
  )}\n`;
}

/**
 * The theorem names in `comparator.json` order, in Lean's own name syntax:
 * `lake comparator` reads `theorem_names` with `String.toName` and
 * `leanexport` decodes each target as a name literal (`Syntax.decodeNameLit`,
 * which panics on a name it cannot read), so a component Lean cannot read
 * bare is quoted here exactly as the generated source quotes it.
 */
export function theoremNamesOf(proofs: readonly CertifiedProof[]): string[] {
  return orderedProofs(proofs).map((proof) => leanName(proof.id));
}

/** The exporter's declaration list for a Challenge stating `theoremNames`
 * (in Lean's name syntax, as `theoremNamesOf` gives them): exactly what
 * `lake comparator` itself exports (lean-facts.ts comparatorExportTargets),
 * so a comparator handed this export finds every constant it looks up. */
export function comparatorExportTargets(theoremNames: readonly string[], facts: LeanFacts = leanFacts()): string[] {
  return [
    ...facts.comparatorExportTargets.slice(0, 4), // the Quot four
    ...theoremNames,
    ...facts.backgroundAxioms,
    ...facts.comparatorExportTargets.slice(4),
  ];
}

/** A TOML basic string: the names and URLs here never need more than this. */
function tomlString(value: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error("cannot emit a control character into lakefile.toml");
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

/**
 * `lakefile.toml`: the libraries at the row's pins, then the required
 * packages, then the libraries to build. `shape` picks the generated
 * modules: a record's bundle and the trusted path's container A build the
 * Challenge alone, a relative certificate the Challenge and its Solution.
 * The caller names the packages: a record's bundle requires its proof
 * package (the comparator's solution module), container A must never
 * (axiomfree-plan.md, "Certify" 2).
 */
export function lakefileText(
  libraries: readonly PinnedLibrary[],
  packages: readonly CertifyPackage[],
  shape: "record" | "relative",
): string {
  const targets = shape === "relative" ? [CHALLENGE_MODULE, SOLUTION_MODULE] : [CHALLENGE_MODULE];
  const requires = [
    ...libraries.map(
      (library) =>
        `[[require]]\nname = ${tomlString(library.name)}\ngit = ${tomlString(library.url())}\n` +
        `rev = ${tomlString(library.commit)}\n\n`,
    ),
    ...packages.map(
      (pkg) =>
        `[[require]]\nname = ${tomlString(pkg.name)}\n` +
        ("git" in pkg.source
          ? `git = ${tomlString(pkg.source.git)}\nrev = ${tomlString(pkg.source.rev)}\nsubDir = ${tomlString(pkg.source.subDir)}\n\n`
          : `path = ${tomlString(pkg.source.path)}\n\n`),
    ),
  ];
  return (
    `name = ${tomlString(CERTIFICATE_PACKAGE)}\n` +
    `defaultTargets = [${targets.map(tomlString).join(", ")}]\n\n` +
    requires.join("") +
    targets.map((target) => `[[lean_lib]]\nname = ${tomlString(target)}\n`).join("\n")
  );
}

/** The manifest entries the packages become (host/warmstore.ts SeededDependency). */
export function manifestDependencies(packages: readonly CertifyPackage[]): SeededDependency[] {
  return packages.map((pkg) =>
    "git" in pkg.source
      ? { name: pkg.name, url: pkg.source.git, rev: pkg.source.rev, subDir: pkg.source.subDir }
      : { name: pkg.name, dir: pkg.source.path },
  );
}

/** The sha256 of a generated text, bare hex, as every recorded digest is. */
export function textDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
