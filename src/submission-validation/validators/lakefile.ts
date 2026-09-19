import { parse } from "smol-toml";
import { CHAIN_WORKFLOW_HINT } from "../chain-workflow.js";
import {
  submissionIdForPackage,
  type GitRequire,
  type PathRequire,
  type ValidatedLakefile,
  type ValidationRuntimeIdentity,
} from "../contracts.js";
import type { FindingCollector } from "../findings.js";
import { validateRepositoryUrl } from "../../shared/validation.js";

const TOP_KEYS = new Set(["name", "defaultTargets", "leanOptions", "require", "lean_lib"]);
const COMMIT = /^[0-9a-f]{40}$/u;

export interface LakefileOptions {
  /**
   * Admit `path` requires on sibling submissions. Only the local host build
   * sets this, and only under `lax build --nonstrict`: the archive refuses
   * every path require but the proof package's own `../concepts` edge, and
   * so does every other caller (validators/lakefile.ts is the one boundary).
   */
  siblings?: boolean;
}

export function validateLakefile(
  content: string,
  kind: "concepts" | "proofs",
  expectedName: string,
  where: string,
  runtime: ValidationRuntimeIdentity,
  findings: FindingCollector,
  options: LakefileOptions = {},
): ValidatedLakefile | undefined {
  if (Buffer.byteLength(content, "utf8") > 256 * 1024) {
    findings.violate("lakefile", `${where} exceeds 256 KiB`);
    return undefined;
  }
  let value: Record<string, unknown>;
  try {
    value = parse(content) as Record<string, unknown>;
  } catch (error) {
    findings.violate("lakefile", `${where} is not valid TOML: ${(error as Error).message}`);
    return undefined;
  }
  for (const key of Object.keys(value))
    if (!TOP_KEYS.has(key)) findings.violate("lakefile", `${where}: key \`${key}\` is not allowed`);
  if (value.name !== expectedName)
    findings.violate("lakefile", `${where}: name must be ${expectedName}`);
  if (!Array.isArray(value.defaultTargets) || value.defaultTargets.length !== 1 || value.defaultTargets[0] !== expectedName)
    findings.violate("lakefile", `${where}: defaultTargets must be exactly [\"${expectedName}\"]`);

  if (!plainObject(value.leanOptions)) {
    findings.violate("lakefile", `${where}: [leanOptions] with autoImplicit = false is required`);
  } else {
    for (const key of Object.keys(value.leanOptions))
      if (key !== "autoImplicit") findings.violate("lakefile", `${where}: leanOptions.${key} is not allowed`);
    if (value.leanOptions.autoImplicit !== false)
      findings.violate("lakefile", `${where}: leanOptions.autoImplicit must be false`);
  }

  if (!Array.isArray(value.lean_lib) || value.lean_lib.length !== 1 || !plainObject(value.lean_lib[0])) {
    findings.violate("lakefile", `${where}: exactly one [[lean_lib]] is required`);
  } else {
    const library = value.lean_lib[0];
    for (const key of Object.keys(library))
      if (key !== "name") findings.violate("lakefile", `${where}: lean_lib.${key} is not allowed`);
    if (library.name !== expectedName) findings.violate("lakefile", `${where}: lean_lib.name must be ${expectedName}`);
  }

  const gitRequires: GitRequire[] = [];
  const pathRequires: PathRequire[] = [];
  let mathlib = false;
  let hasConceptPathRequire = false;
  const seenRequires = new Set<string>();
  const requirements = value.require ?? [];
  if (!Array.isArray(requirements) || requirements.length > 200) {
    findings.violate("lakefile", `${where}: require must be a list of at most 200 entries`);
  } else {
    requirements.forEach((raw, index) => {
      const label = `${where}: [[require]] #${index + 1}`;
      if (!plainObject(raw) || typeof raw.name !== "string") {
        findings.violate("lakefile", `${label}: name is required`);
        return;
      }
      if (seenRequires.has(raw.name)) {
        findings.violate("lakefile", `${label}: duplicate package requirement ${raw.name}`);
        return;
      }
      seenRequires.add(raw.name);
      const keys = Object.keys(raw);
      if ("path" in raw) {
        if (keys.length !== 2 || typeof raw.path !== "string") {
          findings.violate("lakefile", `${label}: a path require contains exactly name and path`);
          return;
        }
        if (kind === "proofs" && raw.path === "../concepts") {
          const conceptName = expectedName.slice(0, -"Proofs".length);
          if (raw.name !== conceptName)
            findings.violate("lakefile", `${label}: the own concept dependency must be named ${conceptName}`);
          else hasConceptPathRequire = true;
          return;
        }
        if (options.siblings === true) {
          // A sibling: another local submission's package, built in place
          // from its working tree. Admitted for local iteration only — the
          // rules below mirror the git-require rules so that replacing the
          // path by the registered triple later changes nothing else.
          if (raw.path.startsWith("/")) {
            findings.violate("lakefile", `${label}: a sibling path must be relative to ${kind}/`);
            return;
          }
          const id = submissionIdForPackage(raw.name);
          if (id === undefined) {
            findings.violate("lakefile", `${label}: sibling package ${raw.name} is not a Lax package name (LaxN, N ≥ 1)`);
            return;
          }
          const ownId = submissionIdForPackage(expectedName);
          if (id === ownId) {
            findings.violate("lakefile", `${label}: a submission cannot require its own package ${raw.name} as a sibling`);
            return;
          }
          if (kind === "concepts" && raw.name.endsWith("Proofs"))
            findings.violate("lakefile", `${label}: concept packages cannot require proof packages`);
          if (raw.name.endsWith("Proofs"))
            findings.warn("proof-dependency", `${label}: depending on a proof package is discouraged`);
          pathRequires.push({ name: raw.name, path: raw.path });
          return;
        }
        // The proof package's own `../concepts` edge above is the only `path`
        // require the archive admits. A cross-submission path require would
        // break the invariant the capture cache key rests on — that every
        // cross-submission edge is rev-pinned in source, so a submission's
        // commit transitively pins its whole source closure (rewrite-plan
        // addendum 2c). Forbidding it here is load-bearing for cache
        // soundness, not just simplification. Locally, `lax build --nonstrict`
        // admits it as a sibling (above) so unregistered drafts can be
        // iterated together.
        findings.violate(
          "lakefile",
          `${label}: a path require reaching another submission's package is not supported by the archive ` +
            "(the only `path` require is the proof package's own `../concepts`). While the dependency is " +
            "still an unregistered draft, `lax build --nonstrict` admits it as a sibling built from its " +
            "local checkout, so only the final commits have to be chained. " +
            CHAIN_WORKFLOW_HINT,
        );
        return;
      }

      for (const key of keys)
        if (!["name", "git", "rev", "subDir"].includes(key))
          findings.violate("lakefile", `${label}: key \`${key}\` is not allowed`);
      if (typeof raw.git !== "string" || typeof raw.rev !== "string") {
        findings.violate("lakefile", `${label}: git and rev are required`);
        return;
      }
      if (raw.name === "mathlib") {
        mathlib = true;
        if (raw.git !== runtime.mathlibRepository)
          findings.violate("lakefile", `${label}: mathlib repository must be ${runtime.mathlibRepository}`);
        if (raw.rev !== runtime.mathlibCommit)
          findings.violate("lakefile", `${label}: mathlib revision must be ${runtime.mathlibCommit}`);
        if ("subDir" in raw) findings.violate("lakefile", `${label}: mathlib must not specify subDir`);
        return;
      }
      if (!COMMIT.test(raw.rev)) findings.violate("lakefile", `${label}: rev must be a full lowercase commit SHA`);
      let repository: string;
      try {
        repository = validateRepositoryUrl(raw.git);
      } catch (error) {
        findings.violate("lakefile", `${label}: ${(error as Error).message}`);
        return;
      }
      if (typeof raw.subDir !== "string") {
        findings.violate("lakefile", `${label}: submission dependencies require subDir`);
        return;
      }
      if (kind === "concepts" && raw.name.endsWith("Proofs"))
        findings.violate("lakefile", `${label}: concept packages cannot require proof packages`);
      if (raw.name.endsWith("Proofs"))
        findings.warn("proof-dependency", `${label}: depending on a proof package is discouraged`);
      gitRequires.push({ name: raw.name, git: repository, rev: raw.rev, subDir: raw.subDir });
    });
  }
  if (!mathlib) findings.violate("lakefile", `${where}: the package must require pinned mathlib directly`);
  return { packageName: expectedName, gitRequires, hasConceptPathRequire, pathRequires };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
