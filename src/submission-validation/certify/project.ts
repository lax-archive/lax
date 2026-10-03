// What both Certify paths share above the generator: which packages a
// record's certificate involves and where each comes from, the three
// projects written from the generated files (the bundle a reader reruns, the
// Challenge half container A builds, the whole container B judges), the
// staging of the submission's own captures as Lake path dependencies, and
// the in-container layout. The trusted phase (phase.ts) and the local host
// run (host.ts) differ only in where the packages are found and how the two
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
import {
  BUNDLE_FILES,
  CHALLENGE_MODULE,
  challengeText,
  certifiedProof,
  comparatorConfigText,
  conceptPackagesOf,
  lakefileText,
  manifestDependencies,
  orderedProofs,
  proofPackagesOf,
  solutionText,
  theoremNamesOf,
  type BundleFile,
  type CertifiedProof,
  type CertifyPackage,
} from "./generate.js";

/**
 * The stable in-container paths of the Certify mounts, beside RUNTIME_PATHS
 * (config.ts). Container A sees `project` (its Challenge half, read-only
 * except `.lake`), `own/concepts/*`, `deps`, and `out`; container B sees the
 * whole project, both own packages, `deps`, the Challenge export read-only
 * at `challengeExport`, and `out`. Nothing of the proof package is ever
 * mounted into A.
 */
export const CERTIFY_PATHS = {
  project: "/cert/project",
  own: "/cert/own",
  deps: "/deps",
  challengeExport: "/cert/challenge.export",
  out: "/out",
} as const;

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
}

/** Everything the generator and the two runs read from a record. */
export interface CertifyPlan {
  proofs: CertifiedProof[];
  theoremNames: string[];
  /** The exporter's declaration list for the Challenge: what the comparator
   * itself would export (lean-facts.ts comparatorExportTargets). */
  exportTargets: string[];
  /** The concept packages the edges name, other than the record's own. */
  referenced: ResolvedDependency[];
  /** Every dependency the Challenge half's workspace needs: the own concept
   * package's closure and the referenced packages' closures. */
  challengeClosure: ResolvedDependency[];
  /** Every dependency the whole project's workspace needs. */
  solutionClosure: ResolvedDependency[];
  /** The git source of every package the bundle names — both own packages
   * and the whole closure — for a run that keeps the bundle's requires and
   * redirects them through its manifest. */
  gitSources: ReadonlyMap<string, { git: string; rev: string; subDir: string }>;
  /** The bundle: what a reader reruns, with git requires at the records'
   * source triples. */
  bundle: Record<BundleFile, string>;
}

/** The dependencies reachable from `start` through the resolved graph, by
 * package name — the same walk as phases/provision.ts dependencyClosure. */
function closure(start: readonly string[], resolution: ResolutionResult): ResolvedDependency[] {
  const byName = new Map(resolution.all.map((dependency) => [dependency.packageName, dependency]));
  const result = new Map<string, ResolvedDependency>();
  const visit = (name: string): void => {
    const dependency = byName.get(name);
    if (dependency === undefined || result.has(name)) return;
    result.set(name, dependency);
    dependency.requiredPackages.forEach(visit);
    if (dependency.kind === "proofs") visit(name.slice(0, -"Proofs".length));
  };
  start.forEach(visit);
  return [...result.values()].sort((a, b) => a.packageName.localeCompare(b.packageName));
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

/**
 * The plan for a record, or undefined when it has no proofs: nothing to
 * certify, nothing runs, and the record carries no `certificate`.
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
  const referenced: ResolvedDependency[] = [];
  for (const name of conceptPackagesOf(proofs)) {
    if (name === record.ownConcepts) continue;
    const dependency = direct.get(name);
    if (dependency === undefined)
      throw new Error(`the proofs name statements of ${name}, which the proof package does not require directly`);
    referenced.push(dependency);
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
  const gitSources = new Map<string, { git: string; rev: string; subDir: string }>();
  for (const pkg of [ownConcepts, ownProofs, ...solutionClosure.map(gitSource)])
    if ("git" in pkg.source) gitSources.set(pkg.name, pkg.source);
  return {
    proofs,
    theoremNames,
    exportTargets: [
      ...facts.comparatorExportTargets.slice(0, 4), // the Quot four
      ...theoremNames,
      ...facts.backgroundAxioms,
      ...facts.comparatorExportTargets.slice(4),
    ],
    referenced,
    challengeClosure,
    solutionClosure,
    gitSources,
    bundle: {
      "Challenge.lean": challengeText(proofs),
      "Solution.lean": solutionText(proofs),
      "comparator.json": comparatorConfigText(proofs),
      "lakefile.toml": lakefileText(libraries, [ownConcepts, ...referenced.map(gitSource), ownProofs], "bundle"),
      "lake-manifest.json": manifestText(
        record.warmPackages,
        manifestDependencies([ownConcepts, ownProofs, ...solutionClosure.map(gitSource)]),
      ),
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
      [record.ownConcepts, ...plan.referenced.map((dependency) => dependency.packageName)].map((name) => ({
        name,
        source: requireSource(name),
      })),
      "challenge",
    ),
  };
}

/** The files container B (and a local run) judges: the whole bundle, with
 * the requires pointed where this run finds the packages. */
export function solutionProjectFiles(
  plan: CertifyPlan,
  record: CertifyRecord,
  requireSource: (name: string) => CertifyPackage["source"],
): Partial<Record<BundleFile, string>> {
  return {
    "Challenge.lean": plan.bundle["Challenge.lean"],
    "Solution.lean": plan.bundle["Solution.lean"],
    "comparator.json": plan.bundle["comparator.json"],
    "lakefile.toml": lakefileText(
      librariesOf(record.environment),
      [record.ownConcepts, ...plan.referenced.map((dependency) => dependency.packageName), record.ownProofs].map(
        (name) => ({ name, source: requireSource(name) }),
      ),
      "bundle",
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

/** The project's own build tree, where `lake build Challenge` leaves the
 * Challenge olean: the first entry of the exporter's LEAN_PATH. */
export function projectLibDir(projectDir: string): string {
  return path.posix.join(projectDir, ...leanFacts().lakeLibDir);
}

export { CHALLENGE_MODULE };
