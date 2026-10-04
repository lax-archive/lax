// What both Certify paths share above the generator: which packages a
// record's certificate involves and where each comes from, the projects
// written from the generated files (the bundle a reader reruns — and the
// judge judges — and the Challenge half container A builds), the staging of
// the submission's own captures as Lake path dependencies, and the
// in-container layout. The trusted phase (phase.ts) and the local host run
// (host.ts) differ only in where the packages are found and how the
// commands execute.

import fs from "node:fs";
import path from "node:path";
import type { SourceLocation } from "../../shared/types.js";
import type {
  CertificationKernel,
  ProofEntry,
  ResolutionResult,
  ResolvedDependency,
} from "../contracts.js";
import type { ArchiveEnvironment } from "../environments.js";
import { librariesOf } from "../environments.js";
import { leanFacts } from "../lean-facts.js";
import { manifestText, type SeededDependency } from "../host/warmstore.js";
import { dependencySubDir } from "../phases/provision.js";
import type { ContainerMount } from "../sandbox/container.js";
import {
  BUNDLE_FILES,
  CHALLENGE_MODULE,
  RECORD_BUNDLE_FILES,
  challengeText,
  certifiedProof,
  comparatorConfigText,
  conceptPackagesOf,
  lakefileText,
  manifestDependencies,
  orderedProofs,
  proofPackagesOf,
  theoremNamesOf,
  type BundleFile,
  type CertifiedProof,
  type CertifyPackage,
  type RecordBundle,
} from "./generate.js";

/**
 * The stable in-container paths of the Certify mounts, beside RUNTIME_PATHS
 * (config.ts). Container A sees `project` (its Challenge half, read-only
 * except `.lake`), `own/concepts/*`, the concept closure under `deps`, and
 * `out`; container B sees the lib trees alone — both own packages' and the
 * solution closure's under `deps` — read-only, and `out`; container C — the
 * judge — sees the bundle at `project` read-only, both exports read-only,
 * the read-only `shims`, and `out`, and nothing else: no capture, no warm
 * store, no `deps`. Nothing of any proof package is ever mounted into A.
 */
export const CERTIFY_PATHS = {
  project: "/cert/project",
  own: "/cert/own",
  deps: "/deps",
  challengeExport: "/cert/challenge.export",
  solutionExport: "/cert/solution.export",
  shims: "/cert/shims",
  /** The read-only plan of a build step (A1), which has no `/out`. */
  plan: "/cert/plan",
  out: "/out",
} as const;

/** A sibling package a nonstrict local build built in place (host/siblings.ts). */
export interface LocalPackage {
  name: string;
  kind: "concepts" | "proofs";
  /** absolute package directory on this machine */
  dir: string;
}

/** The record's certifiable content: its proofs, both own packages, and
 * where the record itself lives. */
export interface CertifyRecord {
  proofs: readonly ProofEntry[];
  ownConcepts: string;
  ownProofs: string;
  source: SourceLocation;
  environment: ArchiveEnvironment;
  resolution: ResolutionResult;
  /** The warm workspace's locked entries (host/warmstore.ts). */
  warmPackages: readonly Record<string, unknown>[];
  /**
   * Local (`lax build --nonstrict`) builds only: the sibling packages built
   * in place — the whole closure lake needs in the manifest, and which of
   * them the proof package requires directly, whose statements the edges may
   * name (phases/inspect-spec2.ts admits exactly those). A plan over a record
   * with siblings is local: its bundle has path requires and its digest means
   * nothing outside this machine. The trusted path never sets this.
   */
  local?: {
    directConcepts: readonly string[];
    packages: readonly LocalPackage[];
  };
}

/** Everything the generator and the runs read from a record. */
export interface CertifyPlan {
  /** A publishable plan has git requires only; a local one has path requires
   * to sibling packages and is never published. */
  kind: "publishable" | "local";
  proofs: CertifiedProof[];
  /** The Challenge's theorem names: the proofs' own ids. */
  theoremNames: string[];
  /** The comparator's solution module: the proof package's root, whose
   * export carries every proof under its own name. */
  solutionModule: string;
  /** The exporter's declaration list for both exports: what the comparator
   * itself would export (lean-facts.ts comparatorExportTargets). */
  exportTargets: string[];
  /** The archive-resolved concept packages the edges name, other than the
   * record's own. */
  referenced: ResolvedDependency[];
  /** The sibling concept packages the edges name (local plans only). */
  referencedLocal: string[];
  /** Every dependency the Challenge half's workspace needs: the own concept
   * package's closure and the referenced packages' closures. */
  challengeClosure: ResolvedDependency[];
  /** Every dependency the proof package needs: what the bundle's manifest
   * lists and container B's LEAN_PATH reaches. */
  solutionClosure: ResolvedDependency[];
  /** Every package the bundle's manifest lists beyond the libraries, in
   * manifest order: the own two, the solution closure, then the siblings. */
  manifestPackages: CertifyPackage[];
  /** The git source of every package the bundle names — both own packages
   * and the whole closure — for a run that keeps the bundle's requires and
   * redirects them through its manifest. Siblings have none. */
  gitSources: ReadonlyMap<string, { git: string; rev: string; subDir: string }>;
  /** The bundle: what a reader reruns and the judge judges, with git
   * requires at the records' source triples. A record's has no Solution:
   * the proof package is the solution module. */
  bundle: RecordBundle;
}

/** Code-point order: the one ordering every path regenerating a bundle
 * agrees on (`localeCompare` depends on the process's locale data). */
export function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** The dependencies reachable from `start` through the resolved graph, by
 * package name — the same walk as phases/provision.ts dependencyClosure. */
function closure(start: readonly string[], resolution: ResolutionResult): ResolvedDependency[] {
  const byPackage = new Map(resolution.all.map((dependency) => [dependency.packageName, dependency]));
  const result = new Map<string, ResolvedDependency>();
  const visit = (name: string): void => {
    const dependency = byPackage.get(name);
    if (dependency === undefined || result.has(name)) return;
    result.set(name, dependency);
    dependency.requiredPackages.forEach(visit);
    if (dependency.kind === "proofs") visit(name.slice(0, -"Proofs".length));
  };
  start.forEach(visit);
  return [...result.values()].sort((a, b) => (a.packageName < b.packageName ? -1 : a.packageName > b.packageName ? 1 : 0));
}

function gitSource(dependency: ResolvedDependency): CertifyPackage {
  return {
    name: dependency.packageName,
    source: {
      git: dependency.source.repository,
      rev: dependency.source.commit,
      subDir: dependencySubDir(dependency),
    },
  };
}

function ownGitSource(name: string, source: SourceLocation, kind: "concepts" | "proofs"): CertifyPackage {
  return {
    name,
    source: {
      git: source.repository,
      rev: source.commit,
      subDir: source.folder === "." ? kind : path.posix.join(source.folder, kind),
    },
  };
}

/** The in-project path a local package is required at: a symlink the host
 * run makes under the generated project (host.ts). */
export function localPackagePath(name: string): string {
  return `packages/${name}`;
}

function localSource(name: string): CertifyPackage {
  return { name, source: { path: localPackagePath(name) } };
}

/**
 * The plan for a record, or undefined when it has no proofs: nothing to
 * certify, nothing runs, and the record carries no `certificate`. Throws
 * when the proofs name a package the record does not require directly (the
 * classifier admitted only direct requires, so that is a lax bug) and, from
 * the generator, a LeanNameError for a name it cannot write.
 */
export function planCertificate(record: CertifyRecord): CertifyPlan | undefined {
  if (record.proofs.length === 0) return undefined;
  const proofs = orderedProofs(record.proofs.map(certifiedProof));
  const proofPackages = proofPackagesOf(proofs);
  if (proofPackages.length !== 1 || proofPackages[0] !== record.ownProofs)
    throw new Error(`the proofs name packages ${proofPackages.join(", ")}; the record's proof package is ${record.ownProofs}`);
  const direct = new Map(
    record.resolution.proofs
      .filter((dependency) => dependency.kind === "concepts")
      .map((dependency) => [dependency.packageName, dependency]),
  );
  const local = record.local;
  const localDirect = new Set(local?.directConcepts ?? []);
  const referenced: ResolvedDependency[] = [];
  const referencedLocal: string[] = [];
  for (const name of conceptPackagesOf(proofs)) {
    if (name === record.ownConcepts) continue;
    const dependency = direct.get(name);
    if (dependency !== undefined) referenced.push(dependency);
    else if (localDirect.has(name) && local?.packages.some((pkg) => pkg.name === name && pkg.kind === "concepts")) referencedLocal.push(name);
    else throw new Error(`the proofs name statements of ${name}, which the proof package does not require directly`);
  }
  const challengeClosure = closure(
    [...record.resolution.concepts.map((dependency) => dependency.packageName), ...referenced.map((dependency) => dependency.packageName)],
    record.resolution,
  );
  const solutionClosure = closure(
    [...record.resolution.proofs, ...record.resolution.concepts].map((dependency) => dependency.packageName),
    record.resolution,
  );
  const libraries = librariesOf(record.environment);
  const ownConcepts = ownGitSource(record.ownConcepts, record.source, "concepts");
  const ownProofs = ownGitSource(record.ownProofs, record.source, "proofs");
  const theoremNames = theoremNamesOf(proofs);
  const facts = leanFacts(record.environment);
  const localPackages = [...(local?.packages ?? [])].sort(byName).map((pkg) => localSource(pkg.name));
  const manifestPackages = [ownConcepts, ownProofs, ...solutionClosure.map(gitSource), ...localPackages];
  const gitSources = new Map<string, { git: string; rev: string; subDir: string }>();
  for (const pkg of manifestPackages) if ("git" in pkg.source) gitSources.set(pkg.name, pkg.source);
  return {
    kind: localPackages.length === 0 ? "publishable" : "local",
    proofs,
    theoremNames,
    solutionModule: record.ownProofs,
    exportTargets: [
      ...facts.comparatorExportTargets.slice(0, 4), // the Quot four
      ...theoremNames,
      ...facts.backgroundAxioms,
      ...facts.comparatorExportTargets.slice(4),
    ],
    referenced,
    referencedLocal,
    challengeClosure,
    solutionClosure,
    manifestPackages,
    gitSources,
    bundle: {
      "Challenge.lean": challengeText(proofs),
      "comparator.json": comparatorConfigText(proofs),
      "lakefile.toml": lakefileText(
        libraries,
        [ownConcepts, ...referenced.map(gitSource), ...referencedLocal.map(localSource), ownProofs],
        "record",
      ),
      "lake-manifest.json": manifestText(record.warmPackages, manifestDependencies(manifestPackages)),
    },
  };
}

/** The kernels a setting runs, as the record names them. */
export function kernelsOf(setting: "lean" | "paranoid", environment: ArchiveEnvironment): CertificationKernel[] {
  return setting === "paranoid" ? ["lean", ...leanFacts(environment).paranoidKernels] : ["lean"];
}

/**
 * A run project: the generated files, a `lake-manifest.json` whose
 * dependency entries point where this run finds the packages, and an empty
 * `.lake` mount point. The real `.lake` directory lives beside the project
 * (`lakeDir`) so the project itself can be mounted read-only while lake
 * writes its build tree — the compile phase's own layout
 * (phases/provision.ts isolateBuildDirectories).
 */
export function writeRunProject(
  projectDir: string,
  lakeDir: string,
  files: Partial<Record<BundleFile, string>>,
  manifest: { warm: readonly Record<string, unknown>[]; deps: readonly SeededDependency[] },
): void {
  fs.mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(lakeDir, { recursive: true, mode: 0o700 });
  for (const name of BUNDLE_FILES) {
    const content = name === "lake-manifest.json" ? manifestText(manifest.warm, manifest.deps) : files[name];
    if (content === undefined) continue;
    fs.writeFileSync(path.join(projectDir, name), content, { mode: 0o644 });
  }
  fs.mkdirSync(path.join(projectDir, ".lake"), { recursive: true, mode: 0o700 });
}

/**
 * The judge's project: the bundle's files verbatim, read-only, with
 * no `.lake` — `lake comparator` given both exports loads no workspace,
 * resolves nothing, builds nothing, and writes nothing (Lake/CLI/Check.lean
 * runComparator: `needsProject` is false when both `--*-from-export` files
 * are supplied), so the judge judges exactly the bytes the record publishes.
 * Beside it the read-only `shims` directory: a `git` that fails loudly,
 * because `mkContext` probes PATH for `git` and `env` with `which` before
 * anything else, sandbox or not, and the stock image has no git.
 */
export function writeJudgeProject(root: string, bundle: Readonly<RecordBundle>): { projectDir: string; shimsDir: string } {
  const projectDir = path.join(root, "project");
  const shimsDir = path.join(root, "shims");
  fs.mkdirSync(projectDir, { recursive: true, mode: 0o755 });
  fs.mkdirSync(shimsDir, { recursive: true, mode: 0o755 });
  for (const name of RECORD_BUNDLE_FILES) fs.writeFileSync(path.join(projectDir, name), bundle[name], { mode: 0o444 });
  fs.writeFileSync(path.join(shimsDir, "git"), GIT_SHIM, { mode: 0o555 });
  return { projectDir, shimsDir };
}

/** The failing `git` the judge's PATH offers to `lake comparator`'s probe. */
export const GIT_SHIM =
  '#!/bin/sh\necho "lax: git is not available inside the validation sandbox (invoked as: git $*)" >&2\nexit 1\n';

/** The files container A builds: the Challenge half, no proof require. */
export function challengeProjectFiles(
  plan: CertifyPlan,
  record: CertifyRecord,
  requireSource: (name: string) => CertifyPackage["source"],
): Partial<Record<BundleFile, string>> {
  return {
    "Challenge.lean": plan.bundle["Challenge.lean"],
    "lakefile.toml": lakefileText(
      librariesOf(record.environment),
      [record.ownConcepts, ...plan.referenced.map((dependency) => dependency.packageName), ...plan.referencedLocal].map((name) => ({
        name,
        source: requireSource(name),
      })),
      "record",
    ),
  };
}

/** The whole bundle with the requires pointed where this run finds the
 * packages: the local run's project, whose lakefile and manifest its
 * sealed (local) bundle carries. */
export function bundleProjectFiles(
  plan: CertifyPlan,
  record: CertifyRecord,
  requireSource: (name: string) => CertifyPackage["source"],
): Partial<Record<BundleFile, string>> {
  return {
    "Challenge.lean": plan.bundle["Challenge.lean"],
    "comparator.json": plan.bundle["comparator.json"],
    "lakefile.toml": lakefileText(
      librariesOf(record.environment),
      [
        record.ownConcepts,
        ...plan.referenced.map((dependency) => dependency.packageName),
        ...plan.referencedLocal,
        record.ownProofs,
      ].map((name) => ({ name, source: requireSource(name) })),
      "record",
    ),
  };
}

/** Where a staged own package's trees are: the staged sources with their
 * Lake build links, and the capture's lib and ir trees to mount beside them. */
export interface StagedOwnPackage {
  packageDir: string;
  libDir: string;
  irDir?: string;
}

/**
 * Stage one of the submission's own captured packages as a Lake path
 * dependency the sandbox can load: a copy of the captured sources (timestamps
 * kept, so the captured artifacts stay newer) with the canonical build
 * links pointing at `linkTarget`, exactly as captures/materialize.ts lays a
 * dependency capture out. The capture root itself is never written to — it
 * is sealed after Certify, and a link inside it would fail the seal.
 */
export function stageOwnPackage(
  captureRoot: string,
  kind: "concepts" | "proofs",
  stagingRoot: string,
  linkTarget: (tree: "lib" | "ir") => string,
): StagedOwnPackage {
  const packageDir = path.join(stagingRoot, kind, "package");
  fs.mkdirSync(path.dirname(packageDir), { recursive: true, mode: 0o700 });
  fs.cpSync(path.join(captureRoot, kind, "package"), packageDir, { recursive: true, preserveTimestamps: true });
  const facts = leanFacts();
  const lib = path.join(packageDir, ...facts.lakeLibDir);
  fs.mkdirSync(path.dirname(lib), { recursive: true });
  fs.symlinkSync(linkTarget("lib"), lib);
  const irDir = path.join(captureRoot, kind, "ir");
  const hasIr = fs.existsSync(irDir);
  if (hasIr) fs.symlinkSync(linkTarget("ir"), path.join(packageDir, ...facts.lakeIrDir));
  return {
    packageDir,
    libDir: path.join(captureRoot, kind, "lib"),
    ...(hasIr ? { irDir } : {}),
  };
}

/**
 * The mounts of exactly these materialised dependency captures, one subtree
 * per dependency at its kind — `<root>/<id>/<kind>/{package,lib,ir}` at
 * `/deps/<id>/<kind>/…`, where the capture's own build links point
 * (captures/materialize.ts makeCapturedPackagesUsable). A record required as
 * a concept package contributes its concept subtree alone: its proof
 * subtree, which the same capture carries, is mounted nowhere.
 */
export function dependencyMounts(dependencyRoot: string, closure: readonly ResolvedDependency[]): ContainerMount[] {
  const mounts: ContainerMount[] = [];
  for (const dependency of closure) {
    const source = path.join(dependencyRoot, dependency.submissionId, dependency.kind);
    const target = `${CERTIFY_PATHS.deps}/${dependency.submissionId}/${dependency.kind}`;
    for (const tree of ["package", "lib"] as const) {
      if (!fs.existsSync(path.join(source, tree)))
        throw new Error(`dependency capture ${dependency.submissionId} has no ${dependency.kind}/${tree} tree`);
      mounts.push({ source: path.join(source, tree), target: `${target}/${tree}` });
    }
    if (fs.existsSync(path.join(source, "ir"))) mounts.push({ source: path.join(source, "ir"), target: `${target}/ir` });
  }
  return mounts;
}

/** The in-container package directory of a dependency in a closure. */
export function dependencyPackageDir(dependency: ResolvedDependency): string {
  return `${CERTIFY_PATHS.deps}/${dependency.submissionId}/${dependency.kind}/package`;
}

/** The in-container lib directory of a dependency in a closure. */
export function dependencyLibDir(dependency: ResolvedDependency): string {
  return `${CERTIFY_PATHS.deps}/${dependency.submissionId}/${dependency.kind}/lib`;
}

/** The lib directories of the warm store's packages, under `warmRoot`
 * (the in-container mount or the host path), for the composed LEAN_PATH. */
export function warmLibDirs(warmPackages: readonly Record<string, unknown>[], warmRoot: string): string[] {
  const facts = leanFacts();
  return warmPackages
    .map((pkg) => pkg.name)
    .filter((name): name is string => typeof name === "string")
    .sort()
    .map((name) => path.posix.join(warmRoot, ...facts.lakePackagesDir, name, ...facts.lakeLibDir));
}

/** The project's own build tree, where `lake build` leaves the Challenge
 * olean: the first entry of the Challenge exporter's LEAN_PATH. */
export function projectLibDir(projectDir: string): string {
  return path.posix.join(projectDir, ...leanFacts().lakeLibDir);
}

export { CHALLENGE_MODULE };
