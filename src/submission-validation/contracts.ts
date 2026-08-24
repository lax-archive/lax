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
