import type { IssueBinding, SourceLocation } from "../shared/types.js";
import type { LibraryName } from "./environments.js";
import {
  isObject,
  requireExactKeys,
  validateCommit,
  validateFolder,
  validateRepositoryUrl,
  validateSubmissionId,
  ValidationError,
} from "../shared/validation.js";

export type ValidationPhase =
  | "source"
  | "static"
  | "resolution"
  | "provision"
  | "compile-concepts"
  | "compile-proofs"
  | "replay"
  | "inspect"
  | "certify"
  | "paper"
  | "emit";

export type ValidationScope = "both" | "concepts" | "proofs";

export interface ValidationRequest {
  requestVersion: 1;
  id: string;
  source: SourceLocation;
  archiveSha: string;
  /** Trusted remote validation binds the manifest to its control-plane issue. */
  issue?: IssueBinding;
  /** Narrow migration flag for commands emitted by an issue-number-based CLI. */
  legacyManifestWithoutIssue?: true;
}

/**
 * Which question a spec-2 finding answers (axiomfree-plan.md, decision 10):
 * `judge` — the proof does not establish the edge (the comparator and its
 * kernels); `translation` — the theorem is not the edge the record claims
 * (statement-hood, statement-name resolution, the universe rule, the
 * generator's own refusals); `standards` — an archive standard, never a
 * correctness failure (namespace, axiom hygiene, frontmatter, imports, root
 * module, unused lemmas). Absent on every spec-1 finding and on the phases
 * shared by both specs.
 */
export type FindingIntent = "judge" | "translation" | "standards";

export interface ValidationFinding {
  phase: ValidationPhase;
  rule: string;
  message: string;
  intent?: FindingIntent;
}

/**
 * A validation that could not produce an ordinary content verdict. Submission
 * mistakes remain in `violations`; this describes capacity exhaustion or a
 * failure of the Archive's own machinery. It is optional so successful v1
 * reports keep their exact authenticated schema and older CLIs can still read
 * unsuccessful reports while a control-plane/CLI rollout is in progress.
 */
export interface ValidationFailure {
  kind: "resource-limit" | "infrastructure";
  retryable: boolean;
  phase: ValidationPhase;
  rule: string;
  message: string;
}

export interface ValidationRuntimeIdentity {
  /** The archive environment this run was validated in: the id of a row of
   * environments.ts, which is also the manifest's `leanVersion`. The pin
   * fields below are that row's, re-derived from the table by every reader
   * rather than trusted from the report. */
  environment: string;
  image: string;
  imageDigest: string;
  layoutVersion: number;
  leanToolchain: string;
  leanVersion: string;
  mathlibRepository: string;
  mathlibCommit: string;
}

export interface SubmissionAuthor {
  name: string;
  orcid?: string;
  github?: string;
}

export interface SubmissionManifest {
  specVersion: string;
  id: string;
  leanVersion: string;
  mathlibVersion: string;
  title: string;
  authors: SubmissionAuthor[];
  bibEntries: string[];
  /** Omit this submission from discovery surfaces while keeping its pages addressable. */
  unlisted?: boolean;
  /** Suppress authorship and source links on presentation surfaces. */
  anonymous?: boolean;
  /** The registered submission this one replaces as its single successor. */
  supersedes?: string;
  /** The LaTeX document the archive compiles and shows beside the cards. */
  paper?: PaperManifest;
}

export type PaperEngine = "pdflatex" | "lualatex" | "xelatex";

/** The manifest's `paper` block: where the document lives and how it is
 * compiled. The vocabulary mirrors arXiv's 00README (compiler, entry file). */
export interface PaperManifest {
  /** Relative to the submission root; `.` for the root itself. */
  folder: string;
  /** Relative to `folder`; a plain `.tex` filename or a contained path. */
  main: string;
  engine: PaperEngine;
  /** The derived web view's opt-out (paper-web-plan.md, "Author-facing
   * contract"): `false` means the reflow derivation is not attempted at all.
   * Absent means true — the derived view is on by default. */
  web?: boolean;
}

/** One numbered marker the rewriter emitted, in document order. */
export interface PaperMarkTableEntry {
  n: number;
  id: string;
  /** Where the `% lax begin` line was, for findings. */
  file: string;
  line: number;
}

/** What the static gate settles about a declared paper before any TeX runs:
 * the rewritten sources and the numbered mark table. Ids are checked for
 * shape only here; whether they name a card is the paper phase's join. */
export interface StaticPaper {
  manifest: PaperManifest;
  /** Every regular file under `paper.folder`, relative to it, POSIX-separated. */
  files: string[];
  /** The `.tex` files in rewrite order (main first, then the rest sorted). */
  texFiles: string[];
  /** Rewritten `.tex` texts by relative path — markers replaced by `\laxmark`. */
  rewritten: Map<string, string>;
  marks: PaperMarkTableEntry[];
}

/** A point in PDF user space: 1-based page, points from the bottom-left
 * corner, and the TeX mode the marker was typeset in (`v` between
 * paragraphs, `h` inside a line) — geometry alone cannot tell a vertical-mode
 * destination from an inline one pushed to a line start. */
export interface PaperMarkPoint {
  page: number;
  x: number;
  y: number;
  mode: "v" | "h";
}

/** What a mark's card shows, decided from the id's spelling: a concept
 * (`Lax261.Treewidth`), a proof (`Lax261Proofs.Q`), or a whole submission
 * (`lax-261` — title and a link to its page). */
export type PaperMarkKind = "concept" | "proof" | "submission";

export interface PaperMark {
  id: string;
  kind: PaperMarkKind;
  begin: PaperMarkPoint;
  end: PaperMarkPoint;
}

export interface PaperPdf {
  digest: string;
  bytes: number;
  pages: number;
  /** Digest-addressed ghcr blob of the PDF layer; absent in local builds,
   * which write `paper.pdf` beside `build-output.json` instead. */
  registryBlob?: string;
}

/** The pinned deriver that produced a web bundle (paper-web-plan.md,
 * "Recorded shape"): the fork identity and the sha256 of the exact
 * `latex.proto` text bundled — the site build's schema gate keys on it. */
export interface PaperWebFormat {
  tool: string;
  /** The reflowtex fork commit (`REFLOWTEX_REV` at derivation time). */
  rev: string;
  /** sha256 of the bundled `schema/latex.proto` bytes, bare hex. */
  schema: string;
}

/** The derived web bundle: a content address, not a reproducibility claim
 * (the deliberate opposite of the PDF digest — see the plan's digest
 * stance). A re-derivation may produce a new digest. */
export interface PaperWebBundle {
  digest: string;
  bytes: number;
  /** Digest-addressed ghcr blob of the web layer; published records only. */
  registryBlob?: string;
}

/** The `paper.web` key of `build-output.json`, present iff the reflow
 * derivation succeeded. Deliberately absent: block lists, font maps, and
 * any web-side mark coordinates — markers ride inside the blobs as stream
 * nodes and the existing `marks` table stays the single truth. */
export interface PaperWebOutput {
  format: PaperWebFormat;
  bundle: PaperWebBundle;
}

/** The `paper` key of `build-output.json`, present iff the manifest declares
 * a paper. `marks` keep mark-number (document) order. */
export interface PaperOutput {
  folder: string;
  main: string;
  engine: PaperEngine;
  pdf: PaperPdf;
  /** `[width, height]` per page, in points. */
  pageSizes: Array<[number, number]>;
  marks: PaperMark[];
  /** Present iff the web derivation succeeded; never required. */
  web?: PaperWebOutput;
}

export interface GitRequire {
  name: string;
  git: string;
  rev: string;
  subDir?: string;
}

/** A `path` require on another local submission's package — a *sibling*.
 * Admitted only by a non-strict local build (`lax build --nonstrict`); the
 * archive refuses every path require but the proof package's own
 * `../concepts` edge, so trusted validation never produces one. */
export interface PathRequire {
  name: string;
  /** as written: relative to the requiring package's directory */
  path: string;
}

export interface ValidatedLakefile {
  packageName: string;
  /** the environment's pinned libraries this package requires, in require
   * order — every required one, plus the allowed ones it chose (the
   * libraries rule, validators/lakefile.ts); their root modules are what
   * the package may import beyond its declared submissions */
  libraries: LibraryName[];
  gitRequires: GitRequire[];
  /** the proof package's own `{ path = "../concepts" }` edge — the only
   * `path` require the archive admits */
  hasConceptPathRequire: boolean;
  /** sibling path requires; always empty under strict validation */
  pathRequires: PathRequire[];
}

export interface ModuleInventory {
  packageName: string;
  packageDir: string;
  rootModule: string;
  modules: string[];
  paths: Map<string, string>;
}

export interface StaticPackage {
  lakefile: ValidatedLakefile;
  inventory: ModuleInventory;
}

export interface StaticResult {
  manifest?: SubmissionManifest;
  abstract?: string;
  concepts?: StaticPackage;
  proofs?: StaticPackage;
  /** Present iff the manifest declares a paper and its static checks passed. */
  paper?: StaticPaper;
}

export interface ArchiveSourceRecord {
  id: string;
  state: "init" | "draft" | "registered" | "deleted";
  /** Immutable Archive creation time; environment closure is keyed to this,
   * so an existing init stub does not lose its environment while unfinished. */
  createdAt: string;
  source?: SourceLocation;
  buildOutput?: Record<string, unknown>;
  /** Numeric owner ids; empty when the copy carries no readable owner list. */
  owners: number[];
}

export interface ResolvedDependency {
  packageName: string;
  submissionId: string;
  kind: "concepts" | "proofs";
  source: SourceLocation;
  state: "draft" | "registered";
  capture?: PublishedCapture;
  statements: string[];
  requiredPackages: string[];
}

export interface ResolutionResult {
  concepts: ResolvedDependency[];
  proofs: ResolvedDependency[];
  all: ResolvedDependency[];
}

export interface CapturedFile {
  path: string;
  bytes: number;
  sha256: string;
}

/**
 * The `references` layer of a spec-2 record's OCI manifest: the concept
 * sources and their `.ilean` files — what the website addresses by name,
 * 0.2% of a capture's bytes — sealed as one small tar beside the capture, so
 * a reader fetches and digest-verifies it whole instead of reconstructing
 * ranged reads from a per-file inventory. `registryBlob` is added by the
 * publisher and must carry exactly `digest`.
 */
export interface CaptureReferences {
  digest: string;
  bytes: number;
  registryBlob?: string;
}

export interface CaptureManifest {
  formatVersion: 1;
  digest: string;
  sourceCommit: string;
  /** The pins the capture was built under. Present in every validation
   * report and in a spec-1 record; a spec-2 record stores neither — its
   * environment is the row `inputs.manifest.leanVersion` names
   * (recorded-shape.ts) — so a capture read from a record of unknown spec
   * may lack them. */
  leanToolchain?: string;
  mathlibCommit?: string;
  /** The per-file inventory of the sealed tar. Present in every validation
   * report and in a spec-1 record; a spec-2 record stores none — the tar's
   * own listing, read after its digest is verified, is the inventory
   * (recorded-shape.ts; spike/axiomfree/build-output-investigation-20261003.md). */
  files?: CapturedFile[];
  /** Spec 2 only: the sealed tar's size and member count, and the
   * `references` layer beside it. */
  bytes?: number;
  fileCount?: number;
  references?: CaptureReferences;
}

export interface PublishedCapture extends CaptureManifest {
  /** Digest-addressed ghcr blob reference: `ghcr.io/<repository>@sha256:<digest>`.
   * The embedded digest MUST equal the capture manifest's own digest — the
   * parsers below and archive/snapshot.ts enforce it fail-closed, so a
   * consumer can only ever fetch the exact bytes the database record hashes.
   * Tags never appear here: they are mutable and only for discoverability. */
  registryBlob: string;
}

// Lean's identifier grammar (`isLetterLike`, `isSubScriptAlnum`, `isIdFirst`,
// `isIdRest` in Init/Meta/Defs.lean; identical in v4.33.0 through v4.35.0):
// the characters `Name.toString` leaves bare in a component.
const LEAN_LETTER_LIKE =
  "\\u03b1-\\u03ba\\u03bc-\\u03c9" + // lower Greek, but λ
  "\\u0391-\\u039f\\u03a1\\u03a2\\u03a4-\\u03a9" + // upper Greek, but Π and Σ
  "\\u03ca-\\u03fb" + // Coptic
  "\\u1f00-\\u1ffe" + // polytonic Greek
  "\\u2100-\\u214f" + // the letterlike block (ℕ, ℘)
  "\\u{1d49c}-\\u{1d59f}" + // script, double-struck, fraktur Latin
  "\\u00c0-\\u00d6\\u00d8-\\u00f6\\u00f8-\\u00ff" + // Latin-1 letters, but × and ÷
  "\\u0100-\\u017f"; // Latin Extended-A
const LEAN_ID_FIRST = `A-Za-z_${LEAN_LETTER_LIKE}`;
const LEAN_ID_REST = `${LEAN_ID_FIRST}0-9'!?\\u2080-\\u2089\\u2090-\\u209c\\u1d62-\\u1d6a\\u2c7c`;
const LEAN_ID_COMPONENT = `[${LEAN_ID_FIRST}][${LEAN_ID_REST}]*`;

/** The archive's name grammar, the one every rule shares: a name exactly as
 * Lean's escaped `Name.toString` prints it when no component needs `«»` —
 * dot-separated components, each a plain Lean identifier (`good?`, `main!`,
 * `℘`, `h₁` and `étale` included), never `_` alone. It is the shape of every
 * concept, proof, and statement id and every universe parameter in a build
 * output, hence of every concept or proof mark id in a paper (submission
 * marks use the `lax-N` record id instead); the spec-2 classifier refuses an
 * endpoint outside it as a finding (phases/inspect-spec2.ts), the schema
 * (artifact-schema.ts `identifier`) and lax-website's `LEAN_NAME` hold
 * every recorded name to it, and the certificate generator splits on its
 * dots (certify/lean-name.ts). A component Lean prints quoted (`«定理»`,
 * `«A.B»`, `«λ»`) or numeric is outside it: such a name round-trips through
 * `String.toName` but is no archive name. */
export const LEAN_NAME_PATTERN = new RegExp(`^(?!_$)${LEAN_ID_COMPONENT}(?:\\.${LEAN_ID_COMPONENT})*$`, "u");

const CAPTURE_BLOB_PATTERN =
  /^ghcr\.io\/([a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+)@sha256:([0-9a-f]{64})$/u;

/** Parse an untrusted capture blob reference; undefined when malformed. */
export function parseCaptureBlobReference(
  value: string,
): { repository: string; digest: string } | undefined {
  if (value.length > 512) return undefined;
  const match = CAPTURE_BLOB_PATTERN.exec(value);
  return match === null ? undefined : { repository: match[1]!, digest: match[2]! };
}

/** The content spec of an archive environment (environments.ts): what a
 * statement and a proof *are*. The archive JSON schemas keep their own
 * `specVersion: "1"`; this is the number the row carries and the manifest
 * repeats as a string. */
export type ContentSpecVersion = 1 | 2;

export interface StatementEntry {
  id: string;
  signature: string;
  /** Spec 2 only: the statement's universe parameters, in declaration
   * order (`[]` for a monomorphic one). Absent from a spec-1 record. */
  levelParams?: string[];
  /** Spec 2 only: the tagged definition's body, pretty-printed with core
   * notation by the inspector. Absent from a spec-1 record. */
  body?: string;
  startLine?: number;
  endLine?: number;
  doc?: string;
}

/**
 * A universe level as the inspector reports it (lean/inspector/Main.lean
 * `jsonOfLevel`): a tagged array, so a level is matched structurally rather
 * than parsed from text. `mvar` never occurs in a stored type and is kept
 * only so the encoding is total.
 */
export type LevelExpr =
  | ["zero"]
  | ["succ", LevelExpr]
  | ["max", LevelExpr, LevelExpr]
  | ["imax", LevelExpr, LevelExpr]
  | ["param", string]
  | ["mvar"];

/**
 * The inspector's syntactic read of a stored type that is a chain of
 * `∀`-binders over bare constants ending in a bare constant: a fact, not a
 * judgment — whether the constants are statements is the validator's
 * question (phases/inspect-spec2.ts).
 */
export interface InspectorTelescope {
  hypotheses: InspectorLink[];
  conclusion: InspectorLink;
}

/** One link of an InspectorTelescope: the constant as Lean's escaped
 * `Name.toString` prints it, its level arguments, and `nonCanonical` when
 * that text does not read back as the constant (the inspector's
 * `isCanonicalName`): such a link is never the constant its text names — the
 * text may even be a different, canonical name — so it is no statement
 * anywhere and matches no recorded name. */
export interface InspectorLink {
  const: string;
  levels: LevelExpr[];
  nonCanonical?: true;
}

/**
 * A proof's telescope as `build-output.json` records it (spec 2): the same
 * chain once the validator has judged every constant a statement and every
 * level a universe parameter of the proof, so levels are parameter names.
 * Hypotheses keep binder order and duplicates; `ProofEntry.conclusion` and
 * `assumptions` are derived from it. The comparator compares types with
 * `Expr.eqv`, which ignores binder names and kinds, so they are not part of
 * an edge and are not recorded.
 */
export interface ProofTelescope {
  hypotheses: Array<{ statement: string; levels: string[] }>;
  conclusion: { statement: string; levels: string[] };
}

export interface AnnotationSection {
  title: string;
  markdown: string;
}

export interface ConceptEntry {
  id: string;
  path: string;
  title: string;
  type: string;
  description: string;
  sections?: AnnotationSection[];
  imports: string[];
  mathlibImports: string[];
  sourceText: string;
  statements: StatementEntry[];
}

export interface ProofEntry {
  id: string;
  path: string;
  /** Spec 2 only: the proof's universe parameters, in declaration order. */
  levelParams?: string[];
  /** Spec 2 only: the proof's type as a chain of statements; see
   * ProofTelescope. Absent from a spec-1 record. */
  telescope?: ProofTelescope;
  conclusion: string;
  assumptions: string[];
  description: string;
  sections?: AnnotationSection[];
}

export interface ParsedDoc {
  hasFrontmatter: boolean;
  scalars: [string, string][];
  lists: [string, string[]][];
  description: string;
  error?: string;
}

export interface InspectorModule {
  name: string;
  imports: string[];
  moduleDocs: ParsedDoc[];
  declCount: number;
  /** Spec 2: the syntax extensions (parser, macro, term/command/tactic
   * elaborator) this module registers a *global* entry in — a `syntax`,
   * `notation`, `macro_rules`, or `elab` without `scoped`/`local`. */
  globalSyntax?: string[];
}

export interface ConclusionFacts {
  resolves: boolean;
  isAxiom: boolean;
  originModule?: string;
  originReachable: boolean;
  defeq: boolean;
}

/** Where a spec-2 declaration came from (lean/inspector/Main.lean
 * `Origin`): authored from the module's syntax; private, mangled with its
 * module — with the un-mangled parent when Lean generated it (the nested
 * proof of a `private def`), without one when the author wrote it; scoped, carrying macro scopes of its module; realized by Lean
 * under an existing constant (reserved names, matcher realizations), its
 * parent; or an auxiliary Lean generated for an own declaration (recursors,
 * `casesOn`, matchers, `sizeOf` lemmas, abstracted proofs), its parent. */
export type DeclarationOrigin =
  | { kind: "authored" }
  | { kind: "private"; module: string; parent?: string }
  | { kind: "scoped"; module: string }
  | { kind: "realized"; parent: string }
  | { kind: "auxiliary"; parent: string };

export interface InspectorDeclaration {
  name: string;
  kind: string;
  module: string;
  axioms: string[];
  /** Direct references to declarations from the package being inspected.
   * Inspect reports only package-local edges: those are sufficient for the
   * helper-lemma reachability check and keep the untrusted report bounded. */
  usedConstants: string[];
  userName?: string;
  doc?: ParsedDoc;
  conclusionFacts?: ConclusionFacts;
  /** Pretty-printed type: of every axiom, and under spec 2 of every tagged
   * declaration. */
  signature?: string;
  startLine?: number;
  endLine?: number;
  /** The four spec-2 facts (lean/inspector/Main.lean, "Spec-2 facts"):
   * present on every declaration of a `--spec 2` report, absent from a
   * spec-1 one — parseInspectorReport holds the report to that. */
  /** The name is among the exported entries of `LaxCore.laxStatementAttr`. */
  laxStatement?: boolean;
  /** The stored type, metadata stripped, is literally `Sort 0`. */
  isProp?: boolean;
  /** Universe parameter names in declaration order. */
  levelParams?: string[];
  /** The stored type as a chain of constants, or null. */
  telescope?: InspectorTelescope | null;
  /** Tagged declarations only: the number of leading `∀`-binders of the
   * stored type, for the "takes binders" finding. */
  binders?: number;
  /** Spec 2: the name, un-mangled, is not canonical — Lean's escaped
   * `Name.toString` does not read back through `String.toName` as the same
   * name (a component carrying `»`, a name Lean prints unescaped because it
   * is inaccessible or macro-scoped); the classifier refuses an authored
   * declaration so named (`name-not-canonical`). Every other name in a
   * report is injective as printed. */
  nonCanonical?: true;
  /** Spec 2: where the declaration came from, with the evidence
   * (lean/inspector/Main.lean `Origin`) — the one fact every rule that
   * tells authored content from what Lean generated consults; `userName`
   * is the display name and no rule reads its presence. Present on every
   * declaration of a `--spec 2` report. */
  origin?: DeclarationOrigin;
  /** Spec 2: the declaration is marked `@[init]` — an `initialize` or its
   * sugar — which a record may not declare. */
  initializer?: true;
  /** Tagged definitions only: the pretty-printed body. */
  body?: string;
}

export interface InspectorReport {
  modules: InspectorModule[];
  declarations: InspectorDeclaration[];
}

export interface InspectionResult {
  concepts: ConceptEntry[];
  proofs: ProofEntry[];
}

/**
 * The certificate bundle (axiomfree-plan.md, "Certify" 4): the five generated
 * files sealed into one deterministic tar, a further layer of the record's
 * OCI capture manifest beside the capture, the paper and the web bundle.
 * `registryBlob` is added by the publisher after the push and must carry
 * exactly `digest` (PublishedCapture, same rule). The tar's own listing is
 * its inventory; the record carries none.
 */
export interface CertificateBundle {
  formatVersion: 1;
  digest: string;
  registryBlob?: string;
}

/** The kernels `lake comparator` ran over the solution export: Lean's own
 * (`lean`) always, and under `--paranoid` the five bundled checkers too. */
export type CertificationKernel =
  | "lean"
  | "leanchecker-paranoid"
  | "lean4lean"
  | "nanoda"
  | "con-leche"
  | "con-ron";

/** The toolchain binaries the judge runs, digested as installed: the four
 * the judge always uses and the five checkers `--paranoid` adds
 * (CertificationKernel's binaries by their file names). The host hashes them
 * before the first certify container starts and again after the judge has
 * run (certify/self-test.ts); the record carries the digests beside the
 * toolchain name so a later reader knows which bytes judged it. */
export const JUDGE_TOOLS = [
  "lake",
  "lean",
  "leanexport",
  "leanchecker",
  "leanchecker-paranoid",
  "lean4lean",
  "nanoda_bin",
  "con-leche",
  "con-ron",
] as const;
export type JudgeTool = (typeof JUDGE_TOOLS)[number];

/** The probes of the judge self-test (certify/self-test.ts), in the order the
 * record lists them. The first three are one-line Lean modules lax owns,
 * built, exported, and judged through the same containers as the record: a
 * matching pair the comparator must accept, a mismatched pair it must reject,
 * and the matching Solution export with its proof term replaced by its
 * statement, which Lean's kernel must refuse. The rest probe the judge's
 * confinement from inside: a canary the host wrote under the job directory
 * and under its `/tmp` is invisible, there is no network interface but `lo`,
 * `which leanchecker` resolves to the toolchain's binary, and neither the
 * project nor the toolchain is writable. A wrong answer is an infrastructure
 * failure, never a finding against the author (Palomar's policy does the
 * same before any candidate code runs). */
export const SELF_TEST_PROBES = [
  "comparator-accepts",
  "comparator-rejects-mismatch",
  "kernel-rejects-forged",
  "canary-invisible",
  "network-absent",
  "leanchecker-resolves",
  "project-read-only",
  "toolchain-read-only",
] as const;
export type SelfTestProbe = (typeof SELF_TEST_PROBES)[number];

/** The judge self-test's outcome as the record carries it: `passed` with
 * every probe listed on the trusted path; `passed: false` with no probes on a
 * local `lax build`, which runs no container and proves no runner. The
 * trusted parser admits only the former. */
export interface JudgeSelfTest {
  passed: boolean;
  probes: SelfTestProbe[];
}

/** Who judged the certificate: the toolchain whose `lake comparator` ran, its
 * exit code — recorded only on a pass, so always 0 — the self-test the judge
 * passed first, and the sha256 of each judge binary as installed. A spec-2
 * record stores only the last two: the toolchain is the environment row's
 * and the exit code a constant, so readers fill both (recorded-shape.ts). */
export interface CertificateJudge {
  toolchain: string;
  comparatorExitCode: 0;
  selfTest: JudgeSelfTest;
  tools: Record<JudgeTool, string>;
}

/**
 * The `certificate` key of a spec-2 build output: the record of the Certify
 * phase, present exactly when the record has proofs (a record without proofs
 * runs nothing and carries no key). The edges are not stored: they are the
 * proofs' telescopes, and `challenge` — `Challenge.lean` verbatim, the one
 * artifact that states in Lean exactly what was certified — is held to the
 * generator's regeneration from those telescopes by the trusted parser,
 * which also regenerates and re-seals the whole bundle and holds the
 * published tar to it byte for byte (certify/verify-bundle.ts).
 * `challengeExportSha256` and `solutionExportSha256` are the sha256 of the
 * two exports the judge read (tens of MB, never kept), computed by the host
 * over the files it bind-mounted into the judge: host-recorded provenance a
 * rerun of the bundle can compare its own exports against, not something the
 * publisher can verify — it has no toolchain and no exports.
 */
export interface CertificateOutput {
  judge: CertificateJudge;
  kernels: CertificationKernel[];
  bundle: CertificateBundle;
  challengeExportSha256: string;
  solutionExportSha256: string;
  challenge: string;
}

export interface BuildOutputPayload {
  inputs: {
    manifest: SubmissionManifest;
    abstract: string;
  };
  requiredByConcepts: string[];
  requiredByProofs: string[];
  concepts: ConceptEntry[];
  proofs: ProofEntry[];
  capture: CaptureManifest;
  paper?: PaperOutput;
  /** Spec 2 only: present exactly when a spec-2 record has proofs; never on a
   * spec-1 record. The in-memory payload is the full one; what a spec-2
   * record *stores* drops the fields a reader derives (recorded-shape.ts). */
  certificate?: CertificateOutput;
}

export interface ValidationReport {
  reportVersion: 1;
  ok: boolean;
  request: ValidationRequest;
  runtime: ValidationRuntimeIdentity;
  dependencies: ResolvedDependency[];
  warnings: ValidationFinding[];
  violations: ValidationFinding[];
  failure?: ValidationFailure;
  buildOutput?: BuildOutputPayload;
  capture?: CaptureManifest;
}

export function validationRequestFromUnknown(value: unknown): ValidationRequest {
  if (!isObject(value)) throw new ValidationError("validation request must be an object");
  requireExactKeys(
    value,
    [
      "requestVersion",
      "id",
      "source",
      "archiveSha",
      ...(Object.hasOwn(value, "issue") ? ["issue"] : []),
      ...(Object.hasOwn(value, "legacyManifestWithoutIssue")
        ? ["legacyManifestWithoutIssue"]
        : []),
    ],
    "validation request",
  );
  if (value.requestVersion !== 1) throw new ValidationError("validation requestVersion must be 1");
  if (typeof value.id !== "string") throw new ValidationError("validation request id must be a string");
  validateSubmissionId(value.id);
  if (!isObject(value.source)) throw new ValidationError("validation request source must be an object");
  requireExactKeys(value.source, ["repository", "commit", "folder"], "validation request source");
  const source = {
    repository: validateRepositoryUrl(value.source.repository),
    commit: validateCommit(value.source.commit),
    folder: validateFolder(value.source.folder),
  };
  if (typeof value.archiveSha !== "string") throw new ValidationError("archiveSha must be a string");
  const archiveSha = validateCommit(value.archiveSha);
  let issue: IssueBinding | undefined;
  if (Object.hasOwn(value, "issue")) {
    if (
      !isObject(value.issue) ||
      Object.keys(value.issue).sort().join(",") !== "number,repositoryId" ||
      !Number.isSafeInteger(value.issue.repositoryId) ||
      (value.issue.repositoryId as number) <= 0 ||
      !Number.isSafeInteger(value.issue.number) ||
      (value.issue.number as number) <= 0
    ) {
      throw new ValidationError("validation request issue binding is invalid");
    }
    issue = {
      repositoryId: value.issue.repositoryId as number,
      number: value.issue.number as number,
    };
  }
  let legacyManifestWithoutIssue: true | undefined;
  if (Object.hasOwn(value, "legacyManifestWithoutIssue")) {
    if (value.legacyManifestWithoutIssue !== true) {
      throw new ValidationError("validation request legacy manifest compatibility flag is invalid");
    }
    legacyManifestWithoutIssue = true;
  }
  return {
    requestVersion: 1,
    id: value.id,
    source,
    archiveSha,
    ...(issue === undefined ? {} : { issue }),
    ...(legacyManifestWithoutIssue === undefined ? {} : { legacyManifestWithoutIssue }),
  };
}

/**
 * Lean and Lake identifiers cannot contain the hyphen used by Archive ids.
 *
 * The historical offline placeholder is a legal input here — those scaffolds'
 * packages really are named `Lax0` — because naming a package is not a
 * decision about the archive. Whether an id may name a *record* is settled by
 * the request parser, which refuses `lax-0` on the way in.
 */
export function packageNameForSubmission(id: string): string {
  validateSubmissionId(id, { placeholder: true });
  return `Lax${id.slice("lax-".length)}`;
}

/** The reverse, for dependency package names — which are always real records,
 * so `Lax0` is deliberately not one of them. */
export function submissionIdForPackage(name: string): string | undefined {
  const base = name.endsWith("Proofs") ? name.slice(0, -"Proofs".length) : name;
  const match = /^Lax([1-9][0-9]*)$/u.exec(base);
  return match === null ? undefined : `lax-${match[1]}`;
}

/**
 * Archive ids order by their number, never as text: `lax-5` comes before
 * `lax-12`. The trusted publisher demands exactly this order of the dependent
 * list a delete carries (`parsePublishRequest` refuses any other and does so
 * before the publishing job's own error reporting can run), so every producer
 * of an id list sorts with this comparator rather than with `Array.sort`'s
 * lexicographic default.
 */
export function compareSubmissionIds(left: string, right: string): number {
  return Number(left.slice("lax-".length)) - Number(right.slice("lax-".length));
}

/**
 * The submissions whose packages a record's build requires, numerically
 * ordered and never including the record's own id.
 *
 * `requiredByConcepts` and `requiredByProofs` hold *package* names, and either
 * list may hold either spelling: a proofs package requiring another
 * submission's concepts package (`Lax13` under `requiredByProofs`) is the
 * commonest cross-submission edge there is, so matching one list against one
 * spelling silently loses real dependents. The question a caller can safely
 * ask is only ever "does some required package belong to that submission",
 * which is what `submissionIdForPackage` answers. Non-Lax packages (mathlib
 * and friends) carry no Archive record and drop out, as does anything that is
 * not a string — a caller may be reading a database blob it has not parsed.
 */
export function requiredSubmissionIds(buildOutput: unknown, self: string): string[] {
  const ids = new Set<string>();
  for (const key of ["requiredByConcepts", "requiredByProofs"] as const) {
    const names = isObject(buildOutput) ? buildOutput[key] : undefined;
    if (!Array.isArray(names)) continue;
    for (const name of names) {
      if (typeof name !== "string") continue;
      const id = submissionIdForPackage(name);
      if (id !== undefined && id !== self) ids.add(id);
    }
  }
  return [...ids].sort(compareSubmissionIds);
}
