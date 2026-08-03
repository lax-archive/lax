// Sibling path requires (lax.md, "v0.2 sibling path requires"): resolve the
// validated [[require]] path edges of a submission against its git
// repository. Everything here is structural — existence, ids, containment,
// cycles, and the one unifying source-map check — and runs on every build;
// the record-level admission of a path edge (rule (b): the target record's
// current triple is exactly this repo, this commit, that folder) is
// submit-time and lives in resolution.ts.
//
// Every sibling package dir handed onward (compile copies, manifest seeding,
// replay roots) passes the realpath containment check: a symlink inside the
// repository must not lead reads or copies outside the checkout (H6 — the
// same helper guards the member folder in the server's runBuildJob).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { normalizeSubmissionId } from "../../shared/validation.js";
import { packageNameForSubmission, type GitRequire, type PathRequire, type StaticResult } from "../contracts.js";
import { FindingCollector } from "../findings.js";

const RULE = "resolution";
const PROOF_SUFFIX = "Proofs";

export interface SiblingEdge {
  /** required package name (LaxN or LaxNProofs) */
  name: string;
  /** manifest id at the target submission folder */
  targetId: string;
  kind: "concepts" | "proofs";
  /** absolute package dir, realpath-verified */
  pkgDir: string;
  /** target submission folder, repo-relative posix ("." for the repo root);
   * undefined outside a git repository */
  folder?: string;
}

export interface SiblingClosureEntry {
  /** absolute package dir, realpath-verified */
  pkgDir: string;
  /** the package's own git requires (mathlib excluded), light-parsed */
  gitRequires: GitRequire[];
  /** the package's own path entries (including its own ../concepts edge),
   * with the lakefile's relative dir and the resolved absolute package dir */
  pathEntries: { name: string; dir: string; pkgDir: string }[];
}

export interface SiblingGraph {
  /** direct sibling edges of my concept package */
  concepts: SiblingEdge[];
  /** direct sibling edges of my proof package */
  proofs: SiblingEdge[];
  /** every package reachable over path edges (direct and transitive),
   * keyed by package name; my own two packages are never members */
  closure: Map<string, SiblingClosureEntry>;
}

/**
 * H6: realpath containment. After a lexical check has placed `rel` inside
 * `base`, require that following symlinks agrees: the target's realpath must
 * equal the lexical resolution against the realpath'd base. Returns the
 * realpath on success, undefined when the target does not exist or a symlink
 * redirects it elsewhere.
 */
export function containedRealPath(base: string, rel: string): string | undefined {
  try {
    const real = fs.realpathSync(path.resolve(base, rel));
    return real === path.resolve(fs.realpathSync(base), rel) ? real : undefined;
  } catch {
    return undefined;
  }
}

/** The repository toplevel containing `root`, realpath'd; undefined outside
 * a git repository (pattern of static.ts's tracked-files check). */
function gitToplevel(root: string): string | undefined {
  try {
    const top = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], {
      stdio: ["ignore", "pipe", "ignore"],
      env: safeGitEnvironment(),
    })
      .toString()
      .trim();
    return fs.realpathSync(top);
  } catch {
    return undefined;
  }
}

/**
 * Resolve the submission's sibling path edges: direct edges of both packages,
 * the transitive closure over the siblings' own lakefiles, the repo-wide
 * duplicate-id/nesting scan (H5), and the unified source-map check (one name,
 * one source).
 */
export function resolveSiblings(
  root: string,
  staticResult: StaticResult,
  c: FindingCollector,
): SiblingGraph {
  const graph: SiblingGraph = { concepts: [], proofs: [], closure: new Map() };
  const conceptEdges = staticResult.concepts?.lakefile.pathRequires ?? [];
  const proofEdges = staticResult.proofs?.lakefile.pathRequires ?? [];
  const toplevel = gitToplevel(root);

  if (toplevel !== undefined) scanRepoSubmissions(toplevel, c);
  else if (conceptEdges.length + proofEdges.length > 0)
    c.warn(
      RULE,
      "folder is not inside a git repository; sibling path requires are resolved " +
        "against the filesystem only (no containment or duplicate-id checks)",
    );

  const rootReal = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
  const myFolder =
    toplevel === undefined ? undefined : toPosix(path.relative(toplevel, rootReal)) || ".";

  for (const [kind, edges] of [
    ["concepts", conceptEdges],
    ["proofs", proofEdges],
  ] as const) {
    for (const pr of edges) {
      const edge = resolveEdge(rootReal, toplevel, myFolder, kind, pr, c);
      if (edge) graph[kind].push(edge);
    }
  }

  walkClosure(graph, toplevel, c);
  checkSources(rootReal, staticResult, graph, c);
  return graph;
}

/** Resolve one direct sibling edge: lexical containment, H6 realpath,
 * existence, manifest-id match, self-reference. */
function resolveEdge(
  rootReal: string,
  toplevel: string | undefined,
  myFolder: string | undefined,
  kind: "concepts" | "proofs",
  pr: PathRequire,
  c: FindingCollector,
): SiblingEdge | undefined {
  const where = `${kind}/lakefile.toml: path require "${pr.name}"`;
  const targetKind = pr.path.split("/").at(-1) as "concepts" | "proofs";
  const expectedPackage = pr.name.endsWith(PROOF_SUFFIX)
    ? pr.name.slice(0, -PROOF_SUFFIX.length)
    : pr.name;

  let pkgDir: string;
  let folder: string | undefined;
  if (toplevel !== undefined) {
    // lexical position of the target package dir, relative to the toplevel
    const pkgFolder = toPosix(path.relative(toplevel, path.join(rootReal, kind)));
    const targetRel = path.posix.normalize(path.posix.join(pkgFolder, pr.path));
    if (targetRel.split("/")[0] === "..") {
      c.violate(RULE, `${where}: \`${pr.path}\` escapes the repository`);
      return undefined;
    }
    if (!fs.existsSync(path.resolve(toplevel, targetRel))) {
      c.violate(RULE, `${where}: the repository has no folder \`${targetRel}\``);
      return undefined;
    }
    const real = containedRealPath(toplevel, targetRel);
    if (real === undefined) {
      c.violate(
        RULE,
        `${where}: \`${targetRel}\` leaves the repository through a symlink; ` +
          "sibling path requires must resolve to plain folders of the checkout",
      );
      return undefined;
    }
    pkgDir = real;
    folder = path.posix.dirname(targetRel);
  } else {
    const abs = path.resolve(rootReal, kind, pr.path);
    if (!fs.existsSync(abs)) {
      c.violate(RULE, `${where}: no folder at \`${pr.path}\` (resolved: ${abs})`);
      return undefined;
    }
    pkgDir = fs.realpathSync(abs);
  }

  const targetFolderAbs = path.dirname(pkgDir);
  if (targetFolderAbs === rootReal) {
    c.violate(
      RULE,
      `${where}: the path require points back into this submission itself` +
        (kind === "proofs" && targetKind === "concepts"
          ? ' (the own concept package is required as { path = "../concepts" } exactly)'
          : ""),
    );
    return undefined;
  }

  let declared: string;
  try {
    declared = manifestId(targetFolderAbs);
  } catch (e) {
    c.violate(RULE, `${where}: the target folder is not a submission — ${(e as Error).message}`);
    return undefined;
  }
  if (packageNameForSubmission(declared) !== expectedPackage) {
    c.violate(
      RULE,
      `${where}: the target folder's manifest declares id ${declared}, but the require ` +
        `name \`${pr.name}\` demands package ${expectedPackage} (the require name must be the required ` +
        "submission's package name)",
    );
    return undefined;
  }

  return { name: pr.name, targetId: declared, kind: targetKind, pkgDir, folder };
}

/** Walk the siblings' own lakefiles: collect each closure package's git
 * requires and path entries, follow the path entries transitively, and refuse
 * cycles. Light parse only — the siblings' own submits do full validation. */
function walkClosure(graph: SiblingGraph, toplevel: string | undefined, c: FindingCollector): void {
  const inStack = new Set<string>();

  const describe = (pkgDir: string): string =>
    toplevel === undefined ? pkgDir : toPosix(path.relative(toplevel, pkgDir));

  const visit = (name: string, pkgDir: string, chain: string[]): void => {
    if (inStack.has(name)) {
      c.violate(
        RULE,
        `sibling path requires form a cycle: ${[...chain, describe(pkgDir)].join(" -> ")}`,
      );
      return;
    }
    if (graph.closure.has(name)) return;

    const entry: SiblingClosureEntry = { pkgDir, gitRequires: [], pathEntries: [] };
    graph.closure.set(name, entry);

    const lakefile = path.join(pkgDir, "lakefile.toml");
    if (!fs.existsSync(lakefile)) {
      c.violate(RULE, `path-required sibling package at ${describe(pkgDir)} has no lakefile.toml`);
      return;
    }
    let raw: Record<string, unknown>;
    try {
      const stat = fs.statSync(lakefile);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("lakefile.toml is not a bounded regular file");
      raw = parseToml(fs.readFileSync(lakefile, "utf8")) as Record<string, unknown>;
    } catch (e) {
      c.violate(
        RULE,
        `path-required sibling package at ${describe(pkgDir)} has a malformed lakefile.toml: ` +
          (e as Error).message,
      );
      return;
    }

    inStack.add(name);
    const reqs = Array.isArray(raw.require) ? (raw.require as Record<string, unknown>[]) : [];
    for (const req of reqs) {
      const reqName = req.name;
      if (typeof reqName !== "string" || reqName === "mathlib") continue;
      if (typeof req.path === "string") {
        // resolve against the sibling lakefile's dir, with the same
        // containment posture as direct edges
        let childDir: string | undefined;
        if (toplevel !== undefined) {
          const rel = toPosix(path.relative(toplevel, path.resolve(pkgDir, req.path)));
          if (rel.split("/")[0] === "..") {
            c.violate(
              RULE,
              `sibling package at ${describe(pkgDir)}: path require "${reqName}" escapes the repository`,
            );
            continue;
          }
          childDir = containedRealPath(toplevel, rel);
        } else if (fs.existsSync(path.resolve(pkgDir, req.path))) {
          childDir = fs.realpathSync(path.resolve(pkgDir, req.path));
        }
        if (childDir === undefined) {
          c.violate(
            RULE,
            `sibling package at ${describe(pkgDir)}: path require "${reqName}" does not resolve ` +
              "to a plain folder of the repository",
          );
          continue;
        }
        entry.pathEntries.push({ name: reqName, dir: req.path, pkgDir: childDir });
        visit(reqName, childDir, [...chain, describe(pkgDir)]);
      } else if (typeof req.git === "string" && typeof req.rev === "string") {
        entry.gitRequires.push({
          name: reqName,
          git: req.git,
          rev: req.rev,
          ...(typeof req.subDir === "string" ? { subDir: req.subDir } : {}),
        });
      }
    }
    inStack.delete(name);
  };

  for (const edge of [...graph.concepts, ...graph.proofs])
    visit(edge.name, edge.pkgDir, []);
}

/**
 * The one unifying source check: build a map packageName -> source over my
 * two packages ("root"), my git requires, my path edges, and the closure's
 * git requires and path entries. Any name with two distinct sources is a
 * violation. Subsumes: a closure sibling git-requiring my package name,
 * duplicate ids among involved folders, conflicting pins for one name across
 * sibling lakefiles, and a sibling path edge pointing back into my own root.
 */
function checkSources(
  rootReal: string,
  staticResult: StaticResult,
  graph: SiblingGraph,
  c: FindingCollector,
): void {
  const sources = new Map<string, string>();
  const add = (name: string, source: string, where: string): void => {
    const prev = sources.get(name);
    if (prev === undefined) {
      sources.set(name, source);
      return;
    }
    if (prev !== source)
      c.violate(
        RULE,
        `${where}: package name ${name} has two sources in this workspace ` +
          `(${prev} vs ${source}); every package name must resolve to exactly one source ` +
          "across the submission and its sibling closure",
      );
  };
  const gitSource = (r: GitRequire): string => `git:${r.git}@${r.rev}#${r.subDir ?? ""}`;

  for (const kind of ["concepts", "proofs"] as const) {
    const lf = staticResult[kind]?.lakefile;
    if (!lf) continue;
    add(lf.packageName, "root", `${kind}/lakefile.toml`);
    for (const r of lf.gitRequires) add(r.name, gitSource(r), `${kind}/lakefile.toml`);
  }
  // the proof package's own ../concepts edge names the root concept package
  if (staticResult.proofs?.lakefile.hasConceptPathRequire && staticResult.concepts)
    add(staticResult.concepts.lakefile.packageName, "root", "proofs/lakefile.toml");
  for (const kind of ["concepts", "proofs"] as const)
    for (const edge of graph[kind])
      add(edge.name, `path:${edge.pkgDir}`, `${kind}/lakefile.toml`);
  for (const [name, entry] of graph.closure) {
    const where = `sibling package ${name}`;
    add(name, `path:${entry.pkgDir}`, where);
    for (const r of entry.gitRequires) add(r.name, gitSource(r), where);
    for (const pe of entry.pathEntries) {
      // a sibling path edge pointing back into my own root is a conflict with
      // the "root" source; the realpath comparison catches it regardless of
      // the name used
      if (path.dirname(pe.pkgDir) === rootReal) add(pe.name, "root-by-path", where);
      else add(pe.name, `path:${pe.pkgDir}`, where);
    }
  }
}

/**
 * H5: the repo-wide submission scan. A "submission folder" is a folder whose
 * tracked (or untracked-but-present) manifest.yaml carries a valid lax-N id;
 * invalid or missing ids (vendored fixtures) are ignored, as is anything
 * under a `.lake/` segment (dependency clones contain manifests). Violations:
 * nesting between two submission folders, and duplicate ids repo-wide.
 */
function scanRepoSubmissions(toplevel: string, c: FindingCollector): void {
  let out: string;
  try {
    out = execFileSync(
      "git",
      ["-C", toplevel, "ls-files", "--cached", "--others", "--exclude-standard"],
      {
        stdio: ["ignore", "pipe", "ignore"],
        env: safeGitEnvironment(),
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    ).toString();
  } catch (error) {
    c.violate(RULE, `could not scan repository submission folders: ${(error as Error).message}`);
    return;
  }
  const found: { folder: string; id: string }[] = [];
  for (const file of out.split("\n")) {
    if (path.posix.basename(file) !== "manifest.yaml") continue;
    if (file.split("/").includes(".lake")) continue;
    let id: string;
    try {
      id = manifestId(path.join(toplevel, path.posix.dirname(file)));
    } catch {
      continue;
    }
    found.push({ folder: path.posix.dirname(file), id });
  }

  const byId = new Map<string, string[]>();
  for (const f of found) {
    byId.set(f.id, [...(byId.get(f.id) ?? []), f.folder]);
  }
  for (const [id, folders] of byId)
    if (folders.length > 1)
      c.violate(
        RULE,
        `the repository contains two submission folders with the id ${id}: ` +
          folders.map((f) => `\`${f}\``).join(" and "),
      );

  for (let i = 0; i < found.length; i++)
    for (let j = 0; j < found.length; j++) {
      if (i === j) continue;
      const a = found[i]!;
      const b = found[j]!;
      if (a.folder === b.folder) continue;
      if (a.folder === "." || b.folder.startsWith(a.folder + "/"))
        c.violate(
          RULE,
          `submission folder \`${b.folder}\` (${b.id}) is nested inside submission ` +
            `folder \`${a.folder}\` (${a.id})`,
        );
    }
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function manifestId(root: string): string {
  const filename = path.join(root, "manifest.yaml");
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("manifest.yaml is missing or oversized");
  const value = parseYaml(fs.readFileSync(filename, "utf8")) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("manifest.yaml must be an object");
  const id = (value as Record<string, unknown>).id;
  if (typeof id !== "string") throw new Error("manifest.yaml has no valid lax-N or LaxN id");
  try {
    return normalizeSubmissionId(id);
  } catch {
    throw new Error("manifest.yaml has no valid lax-N or LaxN id");
  }
}

function safeGitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

/**
 * Flatten the sibling closure for one package's `lake-manifest.json`: lake
 * materializes every workspace dependency from the *root* manifest (checked
 * empirically — it refuses transitive requires that only appear in a path
 * dependency's own manifest), so the closure's path entries are rebased
 * relative to the package dir and its git requires are collected, deduped by
 * name (the source-map check already guarantees one source per name).
 */
export function flattenClosure(
  pkgDir: string,
  closure: Map<string, SiblingClosureEntry>,
): { pathDeps: { name: string; dir: string }[]; gitRequires: GitRequire[] } {
  const base = fs.existsSync(pkgDir) ? fs.realpathSync(pkgDir) : path.resolve(pkgDir);
  const pathDeps: { name: string; dir: string }[] = [];
  const gitRequires: GitRequire[] = [];
  const seen = new Set<string>();
  for (const [name, entry] of closure) {
    pathDeps.push({ name, dir: toPosix(path.relative(base, entry.pkgDir)) });
    for (const r of entry.gitRequires) {
      if (seen.has(r.name)) continue;
      seen.add(r.name);
      gitRequires.push(r);
    }
  }
  return { pathDeps, gitRequires };
}
