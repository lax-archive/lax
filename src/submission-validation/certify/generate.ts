// The certificate generator (axiomfree-plan.md, "Certify" 1; the draft spec's
// "Certification", "The bundle"): from a spec-2 record's proof entries — their
// telescopes and universe parameters, exactly as `build-output.json` records
// them — and the packages involved, the five files `lake comparator` judges.
//
//   Challenge.lean    imports the concept packages the edges name and nothing
//                     of any proof package; per proof one theorem
//                     `Cert.<proof-id>.{us} (h₁ : S₁) … : C := sorry`, with
//                     the proof's own level parameters; every hypothesis an
//                     explicit binder, whatever kind the proof declared it
//                     with — `@` below makes the kind irrelevant
//   Solution.lean     imports the proof package; the same theorems, each
//                     discharged by `@<proof-id>.{us} h₁ … hₖ`
//   comparator.json   the theorem names, no definition holes, the three
//                     background axioms
//   lakefile.toml     the environment's libraries at the row's pins and every
//                     involved package, as git requires (a database record's
//                     source triple) or path requires (a local build)
//   lake-manifest.json the complete manifest, so the comparator resolves
//                     nothing (host/warmstore.ts manifestText)
//
// Pure: no filesystem, no environment. Deterministic by construction: proofs
// are emitted in id order, imports sorted, and every name goes through
// `leanName` — a universe parameter through `leanLevel` —
// (certify/lean-name.ts), never interpolated from a raw string.
// The trusted artifact parser regenerates the Challenge, the Solution, and
// the configuration from a record's own `proofs` and holds the record to
// them, which is why the three content files take the proofs alone.

import { createHash } from "node:crypto";
import type { ProofEntry, ProofTelescope } from "../contracts.js";
import type { PinnedLibrary } from "../environments.js";
import { leanFacts } from "../lean-facts.js";
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
export const SOLUTION_MODULE = "Solution";
export const CERTIFICATE_PACKAGE = "LaxCertificate";
/** The prefix of every certificate theorem: `Cert.<proof-id>`. */
export const THEOREM_PREFIX = "Cert";

/** The five files of a bundle, in the order the tar carries them. */
export const BUNDLE_FILES = [
  "Challenge.lean",
  "Solution.lean",
  "comparator.json",
  "lake-manifest.json",
  "lakefile.toml",
] as const;
export type BundleFile = (typeof BUNDLE_FILES)[number];

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

/** The certificate theorem's name for a proof. */
export function theoremNameOf(proofId: string): string {
  return `${THEOREM_PREFIX}.${proofId}`;
}

/** One edge as the certificate states it: the proof, its `Cert.` theorem, its
 * hypotheses in binder order (duplicates kept: exactly the theorem's binders),
 * and its conclusion. Not stored — derived for findings and for the website
 * from the telescopes (recorded-shape.ts). */
export interface CertificateEdge {
  proof: string;
  theorem: string;
  hypotheses: string[];
  conclusion: string;
}

/** The edges the certificate states, in Challenge order. */
export function edgesOf(proofs: readonly CertifiedProof[]): CertificateEdge[] {
  return orderedProofs(proofs).map((proof) => ({
    proof: proof.id,
    theorem: theoremNameOf(proof.id),
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

/** The proof packages the edges live in, sorted: what the Solution imports. */
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
 * A constant referenced from inside a certificate theorem. The theorem is
 * named `Cert.<proof-id>`, so its body elaborates in namespace
 * `Cert.<proof package>…`, where the proof's own name would resolve to the
 * theorem itself (a recursive reference — "fail to show termination", found
 * by the first e2e run) and a statement's could resolve to anything under
 * `Cert`. `_root_` pins every reference to the global name.
 */
export function rootName(canonical: string): string {
  return `_root_.${leanName(canonical)}`;
}

/**
 * A certificate theorem as the generator states it: its canonical name
 * (`Cert.<proof-id>` for an edge, `Cert.<statement-id>` for a relative
 * certificate — the two cannot collide, statement ids live in concept
 * namespaces and proof ids under `…Proofs`), its universe parameters, and
 * the chain it states. An edge's is the proof's own; a relative
 * certificate's is the implied edge `{given statements} → statement`.
 */
export interface CertificateTheorem {
  name: string;
  levelParams: string[];
  telescope: ProofTelescope;
}

/** The theorem an edge states: the proof's chain under `Cert.<proof-id>`. */
export function edgeTheorem(proof: CertifiedProof): CertificateTheorem {
  return { name: theoremNameOf(proof.id), levelParams: proof.levelParams, telescope: proof.telescope };
}

/** The name of the i-th hypothesis of a certificate theorem: `h₁`, `h₂`, … */
export function hypothesisName(index: number): string {
  return `h${String(index + 1).split("").map((digit) => SUBSCRIPT_DIGITS[Number(digit)]).join("")}`;
}

/** One theorem, statement only; `body` discharges it. Every hypothesis is
 * an explicit binder `(hᵢ : Sᵢ)`: the proof is applied with `@`, and the
 * kernel ignores binder info, so the kind the proof declared is irrelevant
 * and not recorded. A body spanning several lines (a composed relative
 * certificate) goes under `:=` on its own lines; a one-line body stays
 * beside it, as every edge's does. */
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

function theorem(proof: CertifiedProof, body: string): string {
  return theoremText(edgeTheorem(proof), body);
}

function imports(modules: readonly string[]): string {
  return modules.map((module) => `import ${leanName(module)}\n`).join("");
}

/** `Challenge.lean`: the edges stated over the concept packages alone. */
export function challengeText(proofs: readonly CertifiedProof[]): string {
  const ordered = orderedProofs(proofs);
  return (
    "-- The certificate challenge: every proof of the record, stated over its concept\n" +
    "-- packages alone. Generated by lax; `lake comparator` holds the Solution to it.\n" +
    imports(conceptPackagesOf(ordered)) +
    ordered.map((proof) => `\n${theorem(proof, "sorry")}`).join("")
  );
}

/** `Solution.lean`: the same theorems, each discharged by applying the proof
 * with `@` to its hypotheses in binder order. */
export function solutionText(proofs: readonly CertifiedProof[]): string {
  const ordered = orderedProofs(proofs);
  return (
    "-- The certificate solution: the Challenge's theorems, each discharged by the\n" +
    "-- record's own proof. Generated by lax.\n" +
    imports(proofPackagesOf(ordered)) +
    ordered
      .map((proof) => {
        const application = [
          `@${rootName(proof.id)}${universes(proof.levelParams)}`,
          ...proof.telescope.hypotheses.map((_hypothesis, index) => hypothesisName(index)),
        ].join(" ");
        return `\n${theorem(proof, application)}`;
      })
      .join("")
  );
}

/**
 * The three content files of a *relative* certificate (axiomfree-plan.md,
 * "CLI, authoring, website"; the draft spec's "Relative certificates"): one
 * theorem `Cert.<statement-id>` stating the implied edge `{given} →
 * statement`, discharged in the Solution by `body` — the proofs of the
 * witness forest applied to one another (certify/compose.ts). The Challenge
 * imports the concept packages the theorem names; the Solution the proof
 * packages the body applies. Same headers, same escaping, same configuration
 * shape as a record's bundle, so a reader reruns both the same way.
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
    "comparator.json": comparatorConfigFor([leanName(input.theorem.name)]),
  };
}

/** `comparator.json`: what `lake comparator` reads. `definition_names` is
 * always empty — a spec-2 certificate has no definition holes — and the
 * permitted axioms are the background three (lean-facts.ts). */
export function comparatorConfigText(proofs: readonly CertifiedProof[]): string {
  return comparatorConfigFor(theoremNamesOf(proofs));
}

/** The configuration for any list of certificate theorems, in the order given. */
export function comparatorConfigFor(theoremNames: readonly string[]): string {
  return `${JSON.stringify(
    {
      challenge_module: CHALLENGE_MODULE,
      solution_module: SOLUTION_MODULE,
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
  return orderedProofs(proofs).map((proof) => leanName(theoremNameOf(proof.id)));
}

/** A TOML basic string: the names and URLs here never need more than this. */
function tomlString(value: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error("cannot emit a control character into lakefile.toml");
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

/**
 * `lakefile.toml`: the libraries at the row's pins, then the required
 * packages, then the libraries to build. `side` picks the project: the whole
 * bundle, or the Challenge half alone — what the trusted path's container A
 * builds, which must never require the proof package (axiomfree-plan.md,
 * "Certify" 2). The caller names the packages of the side it wants.
 */
export function lakefileText(
  libraries: readonly PinnedLibrary[],
  packages: readonly CertifyPackage[],
  side: "bundle" | "challenge",
): string {
  const targets = side === "bundle" ? [CHALLENGE_MODULE, SOLUTION_MODULE] : [CHALLENGE_MODULE];
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
