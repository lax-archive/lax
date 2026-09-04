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
import { environmentOfPins } from "../environments.js";
import { FindingCollector } from "../findings.js";
import type { ArchiveSnapshot } from "../archive/snapshot.js";

/**
 * Resolution reads the Archive snapshot the request names. A trusted run is
 * always handed a fresh one, so only a local build can be looking at an
 * out-of-date clone — which turns a landed dependency into a missing record
 * and a current pin into a mismatched triple.
 */
const STALE_DATABASE_HINT =
  "An out-of-date copy of the archive can also cause this: run `lax sync` and retry.";

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
  // Who asked for each package, for the superseded-dependency warning: a
  // direct require names itself, a transitive one names the package whose
  // closure pulled it in. Recorded on every call, before the memoised
  // return, so a package reached twice knows both of its requirers.
  const directPackages = new Set<string>();
  const requirers = new Map<string, Set<string>>();

  const resolve = (
    packageName: string,
    expected: { repository: string; commit: string; subDir: string } | undefined,
    requiredBy?: string,
  ): ResolvedDependency | undefined => {
    if (expected !== undefined) directPackages.add(packageName);
    else if (requiredBy !== undefined) {
      const seen = requirers.get(packageName) ?? new Set<string>();
      seen.add(requiredBy);
      requirers.set(packageName, seen);
    }
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
      // Islands are hard, not merely forbidden: an olean built by one Lean
      // version cannot be loaded by another, and two mathlib closures have no
      // meaning in one LEAN_PATH. So a dependency outside this submission's
      // environment is rejected here, and the message names both — porting is
      // a new submission, never a wider search path.
      if (capture.leanToolchain !== runtime.leanToolchain || capture.mathlibCommit !== runtime.mathlibCommit) {
        const built = environmentOfPins(capture.leanToolchain, capture.mathlibCommit);
        findings.violate(
          "capture-provenance",
          `${packageName} was built in ` +
            (built === undefined
              ? `an environment this CLI does not admit (${capture.leanToolchain} / ${capture.mathlibCommit})`
              : `environment ${built.id}`) +
            `, not ${runtime.environment}; only submissions in ${runtime.environment} can cite one another`,
        );
      }
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
    for (const child of dependency.requiredPackages) resolve(child, undefined, packageName);
    if (kind === "proofs") resolve(packageName.slice(0, -"Proofs".length), undefined, packageName);
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

  warnSupersededDependencies(request, archive, byPackage, directPackages, requirers, findings);
  checkSupersedes(request, staticResult, archive, findings);

  return {
    result: {
      concepts: unique(concepts),
      proofs: unique(proofs),
      all: [...byPackage.values()].sort((a, b) => a.packageName.localeCompare(b.packageName)),
    },
    findings,
  };
}

/**
 * A dependency whose submission a *registered* successor replaces still
 * builds — requires are rev-pinned and the old record is immutable — so this
 * is a nudge, never a refusal. "Superseded" is derived exactly as the website
 * derives it (`supersededBy`/`latestVersion` in its site generator): only a
 * registered claimant counts, a draft claim is still provisional, and should
 * stale data ever show two claimants the lowest id wins so the warning is the
 * same everywhere. One warning per superseded submission, direct or
 * transitive, in id order.
 */
function warnSupersededDependencies(
  request: ValidationRequest,
  archive: ArchiveSnapshot,
  byPackage: ReadonlyMap<string, ResolvedDependency>,
  directPackages: ReadonlySet<string>,
  requirers: ReadonlyMap<string, Set<string>>,
  findings: FindingCollector,
): void {
  const successors = registeredSuccessors(archive);
  if (successors.size === 0) return;
  const bySubmission = new Map<string, { packages: string[]; requirers: Set<string>; direct: boolean }>();
  for (const dependency of byPackage.values()) {
    const entry = bySubmission.get(dependency.submissionId) ?? {
      packages: [],
      requirers: new Set<string>(),
      direct: false,
    };
    entry.packages.push(dependency.packageName);
    if (directPackages.has(dependency.packageName)) entry.direct = true;
    for (const requirer of requirers.get(dependency.packageName) ?? []) entry.requirers.add(requirer);
    bySubmission.set(dependency.submissionId, entry);
  }
  for (const [id, entry] of [...bySubmission].sort((a, b) => compareIds(a[0], b[0]))) {
    const successor = successors.get(id);
    // A submission may require the very work it supersedes; being told to
    // build on itself would be nonsense.
    if (successor === undefined || successor === request.id) continue;
    const packages = [...entry.packages].sort();
    // The nearest requirers, minus this dependency's own packages: a proof
    // package pulling in its concept package says nothing about who wanted it.
    const from = [...entry.requirers].filter((name) => !packages.includes(name)).sort();
    const where =
      entry.direct || from.length === 0
        ? packages.join(", ")
        : `${packages.join(", ")}, required by ${list(from)}`;
    const latest = latestVersion(successors, id);
    const tip = latest === successor || latest === request.id ? "" : `; the latest version is ${latest}`;
    findings.warn(
      "superseded-dependency",
      `${id} (${where}) is superseded by ${successor}${tip} — consider building on the latest version`,
    );
  }
}

/** Superseded id → the registered successor claiming it. */
function registeredSuccessors(archive: ArchiveSnapshot): Map<string, string> {
  const successors = new Map<string, string>();
  for (const record of archive.all()) {
    if (record.state !== "registered") continue;
    const target = archive.supersedes(record);
    if (target === undefined || target === record.id || archive.get(target) === undefined) continue;
    const existing = successors.get(target);
    if (existing === undefined || compareIds(record.id, existing) < 0) successors.set(target, record.id);
  }
  return successors;
}

/** Follow bound successors to the newest version; `id` itself when current.
 * Cycles are structurally impossible (a claim binds against an immutable
 * record), but a copy of the archive is untrusted data: never loop forever. */
function latestVersion(successors: ReadonlyMap<string, string>, id: string): string {
  const seen = new Set([id]);
  let current = id;
  for (;;) {
    const next = successors.get(current);
    if (next === undefined || seen.has(next)) return current;
    seen.add(next);
    current = next;
  }
}

function compareIds(left: string, right: string): number {
  return Number(left.slice("lax-".length)) - Number(right.slice("lax-".length));
}

/** `Lax7`, `Lax7 and Lax8`, `Lax7, Lax8 and Lax9`. */
function list(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]!}`;
}

/**
 * The manifest's supersedes claim is admitted against the same Archive
 * snapshot the dependencies resolve against: the target must be a registered
 * record sharing an owner with this submission, and its single successor
 * slot must still be free. The claim binds when this submission registers;
 * the trusted publishers repeat every check credential-free at their own
 * publication snapshot (trust rule 2) — this run only moves the verdict in
 * front of the compile.
 */
function checkSupersedes(
  request: ValidationRequest,
  staticResult: StaticResult,
  archive: ArchiveSnapshot,
  findings: FindingCollector,
): void {
  const target = staticResult.manifest?.supersedes;
  if (target === undefined) return;
  const record = archive.get(target);
  if (record === undefined) {
    findings.violate(
      "supersedes-missing",
      `this submission declares it supersedes ${target}, which has no Archive record at ${archive.sha}. ${STALE_DATABASE_HINT}`,
    );
    return;
  }
  if (record.state !== "registered") {
    findings.violate(
      "supersedes-state",
      record.state === "deleted"
        ? `${target} is deleted and its id is retired; a deleted submission cannot be superseded`
        : `${target} is ${record.state}; only a registered submission can be superseded` +
          (record.state === "draft" ? ` — a draft is updated by submitting to it again` : ""),
    );
    return;
  }
  const own = archive.get(request.id);
  if (own === undefined || own.owners.length === 0 || record.owners.length === 0) {
    findings.warn(
      "supersedes-owners",
      `whether an owner of ${target} owns ${request.id} could not be checked against this copy of the archive; the archive itself will decide. ${STALE_DATABASE_HINT}`,
    );
  } else if (!record.owners.some((owner) => own.owners.includes(owner))) {
    findings.violate(
      "supersedes-owners",
      `no owner of ${target} owns ${request.id}; a submission can be superseded only by its own owners`,
    );
  }
  for (const other of archive.all()) {
    if (other.id === request.id || archive.supersedes(other) !== target) continue;
    if (other.state === "registered") {
      findings.violate(
        "supersedes-taken",
        `${other.id} already supersedes ${target}; a submission has at most one successor`,
      );
    } else if (other.state === "draft") {
      findings.warn(
        "supersedes-race",
        `draft ${other.id} also declares it supersedes ${target}; the first to register claims the successor slot`,
      );
    }
  }
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
