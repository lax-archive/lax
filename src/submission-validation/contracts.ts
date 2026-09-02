import type { SourceLocation } from "../shared/types.js";
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
  | "paper"
  | "emit";

export type ValidationScope = "both" | "concepts" | "proofs";

export interface ValidationRequest {
  requestVersion: 1;
  id: string;
  source: SourceLocation;
  archiveSha: string;
}

export interface ValidationFinding {
  phase: ValidationPhase;
  rule: string;
  message: string;
}

export interface ValidationRuntimeIdentity {
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

export interface PaperMark {
  id: string;
  kind: "concept" | "proof";
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
}

export interface GitRequire {
  name: string;
  git: string;
  rev: string;
  subDir?: string;
}

export interface ValidatedLakefile {
  packageName: string;
  gitRequires: GitRequire[];
  /** the proof package's own `{ path = "../concepts" }` edge — the only
   * `path` require a lakefile may carry */
  hasConceptPathRequire: boolean;
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
  leanToolchain: string;
  mathlibCommit: string;
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
 * hence the shape of every paper mark id. */
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

export interface StatementEntry {
  id: string;
  signature: string;
  startLine?: number;
  endLine?: number;
  doc?: string;
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
  userName?: string;
  doc?: ParsedDoc;
  conclusionFacts?: ConclusionFacts;
  signature?: string;
  startLine?: number;
  endLine?: number;
}

export interface InspectorReport {
  modules: InspectorModule[];
  declarations: InspectorDeclaration[];
}

export interface InspectionResult {
  concepts: ConceptEntry[];
  proofs: ProofEntry[];
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
}

export interface ValidationReport {
  reportVersion: 1;
  ok: boolean;
  request: ValidationRequest;
  runtime: ValidationRuntimeIdentity;
  dependencies: ResolvedDependency[];
  warnings: ValidationFinding[];
  violations: ValidationFinding[];
  buildOutput?: BuildOutputPayload;
  capture?: CaptureManifest;
}

export function validationRequestFromUnknown(value: unknown): ValidationRequest {
  if (!isObject(value)) throw new ValidationError("validation request must be an object");
  requireExactKeys(value, ["requestVersion", "id", "source", "archiveSha"], "validation request");
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
  return { requestVersion: 1, id: value.id, source, archiveSha };
}

/**
 * Lean and Lake identifiers cannot contain the hyphen used by Archive ids.
 *
 * The offline placeholder is a legal input here — an offline scaffold's
 * packages really are named `Lax0` — because naming a package is not a
 * decision about the archive. Whether an id may name a *record* is settled
 * before this: the trusted path takes `request.id` from the issue number, and
 * `validationRequestFromUnknown` refuses `lax-0` on the way in.
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
