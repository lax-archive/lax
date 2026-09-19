import fs from "node:fs";
import path from "node:path";
import type { ArchiveSnapshot } from "../archive/snapshot.js";
import {
  submissionIdForPackage,
  type GitRequire,
  type PublishedCapture,
  type StaticResult,
  type ValidationRuntimeIdentity,
} from "../contracts.js";
import { environmentOfPins } from "../environments.js";
import { FindingCollector } from "../findings.js";
import { validateLakefile } from "../validators/lakefile.js";

/**
 * Sibling submissions: the local-only counterpart of the archive's dependency
 * closure, for `lax build --nonstrict`.
 *
 * A sibling is another submission's package reached by a `path` require from
 * this submission's lakefile (validators/lakefile.ts admits those only under
 * the nonstrict option). It has no archive record to resolve against, so this
 * module walks the sibling lakefiles themselves: each sibling's own git
 * requires join Resolution as further direct requires — they name registered
 * (or, nonstrict, draft) records and are validated like the author's own —
 * and each sibling's own path requires are siblings in turn. Lake needs the
 * whole closure spelled out flat in the requiring package's manifest (it
 * refuses a dependency whose require is not an entry, and never reads a path
 * dependency's own manifest), so the closure is computed here once and
 * seeded per package by hostDependencies.
 *
 * Lake builds a path dependency in the dependency's own `.lake`, exactly as
 * the proof package's `../concepts` edge builds the concept package in place.
 * So a sibling's artifacts are shared between its own builds and every
 * dependent's, and its compiled modules live under `<sibling>/.lake/build`,
 * which Replay and Inspect must therefore have on their search path.
 */

export interface Sibling {
  name: string;
  kind: "concepts" | "proofs";
  /** absolute, realpath'd package directory */
  dir: string;
}

export interface SiblingClosure {
  /** every sibling reachable from the package, by package name */
  concepts: Sibling[];
  proofs: Sibling[];
  /** the siblings' own git requires, to resolve as further direct requires */
  gitRequires: { concepts: GitRequire[]; proofs: GitRequire[] };
}

const MAX_SIBLINGS = 200;

export function resolveSiblings(
  submissionRoot: string,
  staticResult: StaticResult,
  runtime: ValidationRuntimeIdentity,
  archive: ArchiveSnapshot,
  findings: FindingCollector,
): SiblingClosure {
  const rootReal = fs.realpathSync(submissionRoot);
  const closure: SiblingClosure = { concepts: [], proofs: [], gitRequires: { concepts: [], proofs: [] } };
  const seedsOf = (kind: "concepts" | "proofs") =>
    (staticResult[kind]?.lakefile.pathRequires ?? []).map((require) => ({
      ...require,
      from: path.join(rootReal, kind),
      via: `${kind}/lakefile.toml`,
    }));
  // The proof package inherits the concept package's siblings: lake needs
  // them in the proofs manifest too (the concept package is a path dependency
  // of proofs and its requires must be entries), the way hostDependencies
  // already folds the concept package's registered closure into proofs.
  const seeds = {
    concepts: seedsOf("concepts"),
    proofs: [...seedsOf("proofs"), ...seedsOf("concepts")],
  };
  for (const kind of ["concepts", "proofs"] as const) {
    if (staticResult[kind] === undefined) continue;
    const seen = new Set<string>();
    const queue = [...seeds[kind]];
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (seen.has(next.name)) continue;
      seen.add(next.name);
      if (seen.size > MAX_SIBLINGS) {
        findings.violate("sibling", `more than ${MAX_SIBLINGS} sibling packages reachable from ${kind}/`);
        break;
      }
      const sibling = readSibling(next, rootReal, runtime, archive, findings);
      if (sibling === undefined) continue;
      closure[kind].push(sibling.sibling);
      closure.gitRequires[kind].push(...sibling.gitRequires);
      for (const require of sibling.pathRequires) {
        queue.push({ ...require, from: sibling.sibling.dir, via: `${next.name}'s lakefile` });
      }
    }
  }
  return closure;
}

interface Seed {
  name: string;
  path: string;
  /** the package directory the path is relative to */
  from: string;
  /** where the require was written, for messages */
  via: string;
}

function readSibling(
  seed: Seed,
  rootReal: string,
  runtime: ValidationRuntimeIdentity,
  archive: ArchiveSnapshot,
  findings: FindingCollector,
): { sibling: Sibling; gitRequires: GitRequire[]; pathRequires: Seed[] } | undefined {
  const label = `sibling ${seed.name} (${seed.via})`;
  const id = submissionIdForPackage(seed.name);
  if (id === undefined) {
    findings.violate("sibling", `${label}: not a Lax package name`);
    return undefined;
  }
  // A sibling is for a submission the archive does not have yet. Once it is
  // registered its source is immutable and the git require is the edge the
  // archive admits — so say exactly what to write.
  const record = archive.get(id);
  if (record?.state === "registered" && record.source !== undefined) {
    const kind = seed.name.endsWith("Proofs") ? "proofs" : "concepts";
    const subDir = record.source.folder === "." ? kind : `${record.source.folder}/${kind}`;
    // Findings are rendered on one line, so the require is spelled the way
    // the chain hint spells it: one key per clause, to be written one per line.
    findings.violate(
      "sibling",
      `${label}: ${id} is registered, so the archive admits it only as a git require. Replace the path require by ` +
        `\`[[require]] name = "${seed.name}", git = "${record.source.repository}", ` +
        `rev = "${record.source.commit}", subDir = "${subDir}"\`. ` +
        `To keep changing ${id} instead, make its checkout a new submission that supersedes it ` +
        `(fresh id, \`supersedes: ${id}\` in its manifest.yaml; see \`lax print spec\`, "Successors") and require that.` +
        environmentNote(id, archive.capture(record), runtime),
    );
    return undefined;
  }
  if (record?.state === "deleted") {
    findings.violate("sibling", `${label}: ${id} is deleted; its id is retired`);
    return undefined;
  }
  if (seed.path.startsWith("/")) {
    findings.violate("sibling", `${label}: a sibling path must be relative`);
    return undefined;
  }
  let dir: string;
  try {
    dir = fs.realpathSync(path.resolve(seed.from, seed.path));
  } catch {
    findings.violate("sibling", `${label}: ${seed.path} does not exist (relative to ${seed.from})`);
    return undefined;
  }
  if (dir === rootReal || dir.startsWith(`${rootReal}${path.sep}`)) {
    findings.violate(
      "sibling",
      `${label}: ${seed.path} resolves inside this submission` +
        (seed.via.endsWith("/lakefile.toml") ? "" : " — a dependency cycle"),
    );
    return undefined;
  }
  const kind = seed.name.endsWith("Proofs") ? "proofs" : "concepts";
  const lakefilePath = path.join(dir, "lakefile.toml");
  let content: string;
  try {
    content = fs.readFileSync(lakefilePath, "utf8");
  } catch {
    findings.violate("sibling", `${label}: ${seed.path} has no lakefile.toml`);
    return undefined;
  }
  // The likeliest slip — the wrong folder, or the wrong name for the right
  // folder — is said once, before the full validation would say it thrice.
  const declared = /^name\s*=\s*["']([^"']+)["']\s*$/mu.exec(content)?.[1];
  if (declared !== undefined && declared !== seed.name) {
    findings.violate("sibling", `${label}: ${seed.path} is package ${declared}, not ${seed.name} — fix \`name\` or \`path\``);
    return undefined;
  }
  // The sibling's lakefile is held to the same rules as the author's own —
  // its name must be the required one, its mathlib pin must be this
  // environment's (which is the environment check), and its requires must be
  // well-formed. Its own findings are reported under the sibling's label; its
  // warnings (a discouraged proof dependency, say) are the sibling's business.
  const own = new FindingCollector("resolution");
  const lakefile = validateLakefile(content, kind, seed.name, `${seed.path}/lakefile.toml`, runtime, own, {
    siblings: true,
  });
  if (own.failed || lakefile === undefined) {
    for (const violation of own.violations) findings.violate("sibling", `${label}: ${violation.message}`);
    return undefined;
  }
  const pathRequires: Seed[] = lakefile.pathRequires.map((require) => ({
    ...require,
    from: dir,
    via: `${seed.name}'s lakefile`,
  }));
  // A sibling proof package requires its own concept package by path; lake
  // needs that entry in the manifest as well, so it is a sibling too.
  if (kind === "proofs" && lakefile.hasConceptPathRequire) {
    pathRequires.push({
      name: seed.name.slice(0, -"Proofs".length),
      path: "../concepts",
      from: dir,
      via: `${seed.name}'s lakefile`,
    });
  }
  return { sibling: { name: seed.name, kind, dir }, gitRequires: lakefile.gitRequires, pathRequires };
}

/** The record is in hand, so say now what Resolution would say next: a
 * dependency outside this environment cannot be cited at all. */
function environmentNote(id: string, capture: PublishedCapture | undefined, runtime: ValidationRuntimeIdentity): string {
  if (capture === undefined) return "";
  if (capture.leanToolchain === runtime.leanToolchain && capture.mathlibCommit === runtime.mathlibCommit) return "";
  const built = environmentOfPins(capture.leanToolchain, capture.mathlibCommit);
  return ` Note: ${id} was built in environment ${built?.id ?? "unknown"}, not ${runtime.environment}; only submissions in one environment can cite one another.`;
}

/** The manifest `dir` of a sibling, relative to the requiring package. */
export function siblingManifestDir(pkgDir: string, sibling: Sibling): string {
  const relative = path.relative(fs.realpathSync(pkgDir), sibling.dir);
  return relative.split(path.sep).join("/");
}
