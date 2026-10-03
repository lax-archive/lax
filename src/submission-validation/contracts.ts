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

export interface ValidationFinding {
  phase: ValidationPhase;
  rule: string;
  message: string;
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
  files: CapturedFile[];
}

export interface PublishedCapture extends CaptureManifest {
  /** Digest-addressed ghcr blob reference: `ghcr.io/<repository>@sha256:<digest>`.
   * The embedded digest MUST equal the capture manifest's own digest — the
   * parsers below and archive/snapshot.ts enforce it fail-closed, so a
   * consumer can only ever fetch the exact bytes the database record hashes.
   * Tags never appear here: they are mutable and only for discoverability. */
  registryBlob: string;
}

/** A canonical Lean name: dot-separated identifiers, no «» escapes. The
 * shape every concept, proof, and statement id in a build output has, and
 * hence the shape of every concept or proof mark id in a paper (submission
 * marks use the `lax-N` record id instead). */
export const LEAN_NAME_PATTERN =
  /^(?:[\p{L}_][\p{L}\p{N}\p{M}_']*)(?:\.(?:[\p{L}_][\p{L}\p{N}\p{M}_']*))*$/u;

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

/** `Lean.BinderInfo`'s constructor names. */
export type BinderKind = "default" | "implicit" | "strictImplicit" | "instImplicit";

/**
 * The inspector's syntactic read of a stored type that is a chain of
 * `∀`-binders over bare constants ending in a bare constant: a fact, not a
 * judgment — whether the constants are statements is the validator's
 * question (phases/inspect-spec2.ts).
 */
export interface InspectorTelescope {
  hypotheses: Array<{ const: string; levels: LevelExpr[]; binder: BinderKind }>;
  conclusion: { const: string; levels: LevelExpr[] };
}

/**
 * A proof's telescope as `build-output.json` records it (spec 2): the same
 * chain once the validator has judged every constant a statement and every
 * level a universe parameter of the proof, so levels are parameter names.
 * Hypotheses keep binder order and duplicates; `ProofEntry.conclusion` and
 * `assumptions` are derived from it. Stage 3's certificate generator applies
 * the proof with `@` in exactly this order.
 */
export interface ProofTelescope {
  hypotheses: Array<{ statement: string; levels: string[]; binder: BinderKind }>;
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
}

export interface ConclusionFacts {
  resolves: boolean;
  isAxiom: boolean;
  originModule?: string;
  originReachable: boolean;
  defeq: boolean;
}

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

/** Who judged the certificate: the toolchain whose `lake comparator` ran, and
 * its exit code — recorded only on a pass, so always 0. */
export interface CertificateJudge {
  toolchain: string;
  comparatorExitCode: 0;
}

/**
 * The `certificate` key of a spec-2 build output: the record of the Certify
 * phase, present exactly when the record has proofs (a record without proofs
 * runs nothing and carries no key). The edges are not stored: they are the
 * proofs' telescopes, and `challenge` — `Challenge.lean` verbatim, the one
 * artifact that states in Lean exactly what was certified — is held to the
 * generator's regeneration from those telescopes by the trusted parser.
 * `challengeExportSha256` is the sha256 of the Challenge export container A
 * produced (tens of MB, never kept; a rerun compares digests).
 */
export interface CertificateOutput {
  judge: CertificateJudge;
  kernels: CertificationKernel[];
  bundle: CertificateBundle;
  challengeExportSha256: string;
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
