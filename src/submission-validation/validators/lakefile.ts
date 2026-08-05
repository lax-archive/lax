import { parse } from "smol-toml";
import { CHAIN_WORKFLOW_HINT } from "../chain-workflow.js";
import type {
  GitRequire,
  ValidatedLakefile,
  ValidationRuntimeIdentity,
} from "../contracts.js";
import type { FindingCollector } from "../findings.js";
import { validateRepositoryUrl } from "../../shared/validation.js";

const TOP_KEYS = new Set(["name", "defaultTargets", "leanOptions", "require", "lean_lib"]);
const COMMIT = /^[0-9a-f]{40}$/u;

export function validateLakefile(
  content: string,
  kind: "concepts" | "proofs",
  expectedName: string,
  where: string,
  runtime: ValidationRuntimeIdentity,
  findings: FindingCollector,
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
        // The proof package's own `../concepts` edge above is the only `path`
        // require there is. A cross-submission path require would also break
        // the invariant the capture cache key rests on — that every
        // cross-submission edge is rev-pinned in source, so a submission's
        // commit transitively pins its whole source closure (rewrite-plan
        // addendum 2c). Forbidding it here is load-bearing for cache
        // soundness, not just simplification.
        findings.violate(
          "lakefile",
          `${label}: a \`path\` require may only be the proof package's own concept package ` +
            '(`path = "../concepts"`, from proofs/lakefile.toml); a path require reaching ' +
            "another submission's package is not supported. " +
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
  return { packageName: expectedName, gitRequires, hasConceptPathRequire };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
