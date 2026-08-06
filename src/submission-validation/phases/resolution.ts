import path from "node:path";
import type {
  ResolvedDependency,
  ResolutionResult,
  StaticResult,
  ValidationRequest,
  ValidationRuntimeIdentity,
} from "../contracts.js";
import { submissionIdForPackage } from "../contracts.js";
import { CHAIN_WORKFLOW_HINT } from "../chain-workflow.js";
import { FindingCollector } from "../findings.js";
import type { ArchiveSnapshot } from "../archive/snapshot.js";

/**
 * Resolution reads the Archive snapshot the request names. A trusted run is
 * always handed a fresh one, so only a local build can be looking at an
 * out-of-date clone — which turns a landed dependency into a missing record
 * and a current pin into a mismatched triple.
 */
const STALE_DATABASE_HINT =
  "A locally stale lax-database can also cause this: run `lax update-db` and retry.";

export function runResolution(
  request: ValidationRequest,
  staticResult: StaticResult,
  archive: ArchiveSnapshot,
  runtime: ValidationRuntimeIdentity,
): { result: ResolutionResult; findings: FindingCollector } {
  const findings = new FindingCollector("resolution");
  const concepts: ResolvedDependency[] = [];
  const proofs: ResolvedDependency[] = [];
  const byPackage = new Map<string, ResolvedDependency>();
  const resolving = new Set<string>();

  const resolve = (packageName: string, expected: { repository: string; commit: string; subDir: string } | undefined): ResolvedDependency | undefined => {
    const existing = byPackage.get(packageName);
    if (existing !== undefined) {
      if (resolving.has(packageName))
        findings.violate("dependency-cycle", `Archive dependencies contain a cycle through ${packageName}`);
      if (expected !== undefined) checkExpectedSource(existing, expected, findings);
      return existing;
    }
    const id = submissionIdForPackage(packageName);
    if (id === undefined) {
      findings.violate("dependency-name", `dependency package ${packageName} is not a Lax package name`);
      return undefined;
    }
    if (id === request.id) {
      findings.violate("dependency-cycle", `submission cannot require its own package ${packageName} through the Archive`);
      return undefined;
    }
    const record = archive.get(id);
    if (record?.state === "deleted") {
      findings.violate("deleted-dependency", `${packageName} belongs to deleted submission ${id}; its id is retired`);
      return undefined;
    }
    if (record === undefined || record.source === undefined || (record.state !== "draft" && record.state !== "registered")) {
      findings.violate(
        "missing-dependency",
        `${packageName} has no content-bearing Archive record at ${archive.sha}. ` +
          `${CHAIN_WORKFLOW_HINT} ${STALE_DATABASE_HINT}`,
      );
      return undefined;
    }
    if (record.state === "draft")
      findings.warn("draft-dependency", `dependency ${packageName} belongs to draft submission ${id}`);
    const kind = packageName.endsWith("Proofs") ? "proofs" : "concepts";
    const expectedSubDir = joinFolder(record.source.folder, kind);
    if (
      expected !== undefined &&
      (expected.repository !== record.source.repository ||
        expected.commit !== record.source.commit ||
        expected.subDir !== expectedSubDir)
    ) {
      findings.violate(
        "dependency-source",
        `${packageName} does not match the Archive source triple ` +
          `(${record.source.repository}, ${record.source.commit}, ${expectedSubDir}). ` +
          `${CHAIN_WORKFLOW_HINT} ${STALE_DATABASE_HINT}`,
      );
      return undefined;
    }
    const capture = archive.capture(record);
    if (capture === undefined) findings.violate("dependency-capture", `${packageName} has no immutable published artifact capture`);
    else {
      if (capture.sourceCommit !== record.source.commit)
        findings.violate("capture-provenance", `${packageName} capture source commit does not match its Archive record`);
      if (capture.leanToolchain !== runtime.leanToolchain || capture.mathlibCommit !== runtime.mathlibCommit)
        findings.violate("capture-provenance", `${packageName} capture was built against different Archive pins`);
    }
    const dependencies = archive.packageNames(record);
    const dependency: ResolvedDependency = {
      packageName,
      submissionId: id,
      kind,
      source: record.source,
      state: record.state,
      ...(capture === undefined ? {} : { capture }),
      statements: kind === "concepts" ? archive.statements(record) : [],
      requiredPackages: kind === "concepts" ? dependencies.concepts : dependencies.proofs,
    };
    byPackage.set(packageName, dependency);
    resolving.add(packageName);
    for (const child of dependency.requiredPackages) resolve(child, undefined);
    if (kind === "proofs") resolve(packageName.slice(0, -"Proofs".length), undefined);
    resolving.delete(packageName);
    return dependency;
  };

  for (const requirement of staticResult.concepts?.lakefile.gitRequires ?? []) {
    const dependency = resolve(requirement.name, {
      repository: requirement.git,
      commit: requirement.rev,
      subDir: requirement.subDir ?? "",
    });
    if (dependency !== undefined) concepts.push(dependency);
  }
  for (const requirement of staticResult.proofs?.lakefile.gitRequires ?? []) {
    const dependency = resolve(requirement.name, {
      repository: requirement.git,
      commit: requirement.rev,
      subDir: requirement.subDir ?? "",
    });
    if (dependency !== undefined) proofs.push(dependency);
  }

  return {
    result: {
      concepts: unique(concepts),
      proofs: unique(proofs),
      all: [...byPackage.values()].sort((a, b) => a.packageName.localeCompare(b.packageName)),
    },
    findings,
  };
}

function checkExpectedSource(
  dependency: ResolvedDependency,
  expected: { repository: string; commit: string; subDir: string },
  findings: FindingCollector,
): void {
  const subDir = joinFolder(dependency.source.folder, dependency.kind);
  if (
    expected.repository !== dependency.source.repository ||
    expected.commit !== dependency.source.commit ||
    expected.subDir !== subDir
  ) findings.violate(
    "dependency-source",
    `${dependency.packageName} does not match the Archive source triple ` +
      `(${dependency.source.repository}, ${dependency.source.commit}, ${subDir}). ` +
      `${CHAIN_WORKFLOW_HINT} ${STALE_DATABASE_HINT}`,
  );
}

function joinFolder(folder: string, kind: "concepts" | "proofs"): string {
  return folder === "." ? kind : path.posix.join(folder, kind);
}

function unique(values: ResolvedDependency[]): ResolvedDependency[] {
  return [...new Map(values.map((value) => [value.packageName, value])).values()].sort((a, b) =>
    a.packageName.localeCompare(b.packageName),
  );
}
