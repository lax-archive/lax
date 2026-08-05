// The warm mathlib workspace: a lax-owned Lake workspace requiring mathlib at
// the archive pin, built once against the pinned toolchain. Submission builds
// consume it **in place** through Lake package overrides: seedOverrides
// writes `<package>/.lake/package-overrides.json` with one path entry per
// package in the warm workspace's locked manifest, each pointing at the
// shared checkout under `<warm>/.lake/packages/`. Lake reads the overrides
// file on every `lake build` (verified at the pinned v4.30.0) and substitutes
// the entries after manifest validation, so the build replays the store's
// prebuilt artifacts where they live — no clone, no hardlinks, no writes to
// the store, and no `.lake/packages` tree in the submission at all. Overrides
// do *not* apply during `lake update`, which is irrelevant here: authors
// never run `lake update`.
//
// Alongside the overrides, seedManifest writes a complete
// `lake-manifest.json`: the validated path dependencies, then the warm
// workspace's own locked entries **verbatim** — the git-type mathlib pins
// stay a faithful record of what the build ran against (and keep lake from
// warning that the manifest is out of date), while the overrides file
// redirects where those packages are found. Both files are lax-generated
// everywhere, gitignored by the scaffold and never trusted from the author
// (static validation rejects a checked-in overrides file: it is a
// dependency-redirection primitive). With a complete manifest in place, lake
// performs no dependency resolution at all — no `post_update` hook (mathlib's
// would run `cache get`), no URL re-check, no network (required submissions
// are materialized from their published captures as path dependencies).
//
// The store is chmod'd fully read-only — files *and* directories — once the
// warm build completes: consumers only ever read it, so read-only is both the
// safety guarantee (no submission build can corrupt the shared artifacts) and
// the tripwire (any code path that tries to write fails loudly with EACCES).

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { laxHome } from "../../shared/lax-home.js";
import { LEAN_TOOLCHAIN, LEAN_VERSION, MATHLIB_REV, MATHLIB_URL } from "../pins.js";
import { run } from "./proc.js";

/** The local warm workspace for the current archive pins, keyed by toolchain
 * and mathlib revision so a pin bump coexists with the previous store. */
export function warmDir(base = path.join(laxHome(), "warm")): string {
  return path.join(base, `${LEAN_VERSION}-${MATHLIB_REV.slice(0, 12)}`);
}

/** Written only after a warm build ran to the very end (including the local
 * chmod pass). The manifest and package clones alone cannot mark readiness:
 * lake writes both *before* the gigabytes download and the build, so an
 * interrupted first build would otherwise leave a store every later run
 * trusts — and consumes incomplete, still-writable content from. */
const READY_MARKER = ".lax-warm-ok";

/** Whether a warm workspace can back submission builds: its locked manifest
 * and package clones exist and the build ran to completion. */
export function warmReady(ws: string): boolean {
  return (
    fs.existsSync(path.join(ws, READY_MARKER)) &&
    fs.existsSync(path.join(ws, "lake-manifest.json")) &&
    fs.existsSync(path.join(ws, ".lake", "packages"))
  );
}

/** Mark the workspace complete; the caller's last step after a successful
 * build and the read-only pass. The pass sealed the root directory too, so
 * reopen it just long enough to drop the marker, then seal it again. */
export function markWarmReady(ws: string): void {
  fs.chmodSync(ws, 0o755);
  const staged = path.join(ws, `${READY_MARKER}.${process.pid}-${randomUUID()}`);
  fs.writeFileSync(staged, "");
  fs.chmodSync(staged, 0o444);
  fs.renameSync(staged, path.join(ws, READY_MARKER));
  fs.chmodSync(ws, 0o555);
}

/**
 * Build a warm workspace at `ws`: scaffold the LaxWarm package requiring
 * mathlib at the archive pin, pull mathlib's prebuilt artifacts, and build.
 */
export async function buildWarmWorkspace(
  ws: string,
  opts: { echo?: boolean; fromSource?: boolean } = {},
): Promise<boolean> {
  const echo = opts.echo ?? true;
  fs.mkdirSync(ws, { recursive: true });
  // a rerun over an interrupted (or completed-but-unmarked) store may find
  // the tree partially sealed by the read-only pass; reopen it first
  makeWritable(ws);
  const write = (p: string, content: string): void => {
    fs.writeFileSync(p, content);
  };
  write(
    path.join(ws, "lakefile.toml"),
    `name = "LaxWarm"
defaultTargets = ["LaxWarm"]

[[require]]
name = "mathlib"
git = "${MATHLIB_URL}"
rev = "${MATHLIB_REV}"

[[lean_lib]]
name = "LaxWarm"
`,
  );
  write(path.join(ws, "lean-toolchain"), LEAN_TOOLCHAIN + "\n");
  write(path.join(ws, "LaxWarm.lean"), "import Mathlib\n");

  // LAKE_ARTIFACT_CACHE must be off for the warm build and every consumer
  // build: with it on, lake writes `.hash` files beside the shared oleans —
  // against the sealed store that fails with EACCES. At the pinned v4.30.0 a
  // dependency lakefile's own `enableArtifactCache` would override this env
  // var; no lakefile in the pinned closure sets it, but a PIN BUMP MUST
  // RE-CHECK that before trusting the store.
  const lakeEnv = { LAKE_ARTIFACT_CACHE: "false" };

  // the fake mathlib of the test seam ships no `cache` executable
  if (!process.env.LAX_MATHLIB_URL) {
    const cache = await run("lake", ["exe", "cache", "get"], ws, { echo, env: lakeEnv });
    if (cache.code !== 0) {
      if (!opts.fromSource) {
        console.error(
          "lax: could not fetch mathlib's prebuilt artifacts (`lake exe cache get` failed).\n" +
            "     This is usually a network problem — rerun once it is resolved, or pass\n" +
            "     --build-from-source to compile mathlib locally instead (takes hours).",
        );
        return false;
      }
      console.warn("warning: `lake exe cache get` failed; building mathlib from source (slow)");
    }
  }
  const build = await run("lake", ["build"], ws, { echo, env: lakeEnv });
  return build.code === 0;
}

/** Seal the store: strip write permission from every file *and* directory.
 * Consumers use the store in place via package overrides and only ever read
 * it — read-only is the safety guarantee and the tripwire (see the module
 * header). Execute bits are preserved: the store carries built executables
 * (e.g. mathlib's `cache`). */
export function makeStoreReadOnly(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) makeStoreReadOnly(p);
    else if (entry.isFile()) fs.chmodSync(p, fs.statSync(p).mode & 0o555);
  }
  fs.chmodSync(dir, fs.statSync(dir).mode & 0o555);
}

/** Restore write permission everywhere under (and on) dir — the inverse of
 * makeStoreReadOnly, for reruns over an interrupted seal. The parent is
 * reopened before recursing so its children can be listed and modified. */
function makeWritable(dir: string): void {
  fs.chmodSync(dir, fs.statSync(dir).mode | 0o700);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) makeWritable(p);
    else if (entry.isFile()) fs.chmodSync(p, fs.statSync(p).mode | 0o600);
  }
}

/**
 * Ensure the local warm workspace exists, building it on first use (downloads
 * gigabytes, once per machine and pin). Returns its path, or undefined when
 * the build failed — the caller reports and the next run retries.
 */
export async function ensureLocalWarm(
  opts: { fromSource?: boolean; echo?: boolean } = {},
): Promise<string | undefined> {
  const ws = warmDir();
  if (warmReady(ws)) {
    // stores sealed before directories joined the read-only pass (the
    // hardlink-farm era) are upgraded in place, once
    if ((fs.statSync(ws).mode & 0o200) !== 0) {
      console.log("lax: making the shared store fully read-only (a few quiet minutes, once)");
      makeStoreReadOnly(ws);
    }
    return ws;
  }
  console.log(
    "lax: building the shared mathlib environment at " +
      `${ws}\n     (downloads gigabytes — once per machine, every submission shares it;\n` +
      "     expect roughly 10–30 minutes, including some long quiet stretches)",
  );
  if (!(await buildWarmWorkspace(ws, { echo: opts.echo ?? true, fromSource: opts.fromSource })))
    return undefined;
  console.log("lax: making the shared store read-only (a few quiet minutes)");
  makeStoreReadOnly(ws);
  markWarmReady(ws);
  return ws;
}

/** The subset of a locked manifest entry the overrides file carries over. */
interface WarmManifestEntry {
  name: string;
  /** required in an overrides entry — omitting it is a lake parse error */
  inherited: boolean;
  scope?: string;
}

/**
 * Write the package's `.lake/package-overrides.json`: one path entry per
 * package in the warm workspace's locked manifest, each pointing at the
 * shared checkout under `<warm>/.lake/packages/<name>`. Lake reads the file
 * on every `lake build` and substitutes these entries for the same-named
 * manifest entries after manifest validation, so the git-type entries
 * seedManifest records stay untouched while the build reuses the store's
 * artifacts in place. Overridden entries fully replace resolution for their
 * package: a stale `.lake/packages` clone from the hardlink-farm era is
 * simply never consulted.
 *
 * `overrideBase` rebases the recorded `dir`s: the trusted container pipeline
 * reads the warm manifest from the *host* store but the build later runs
 * inside the sandbox, where the same store is mounted read-only at
 * RUNTIME_PATHS.warmWorkspace — so the override dirs must be that
 * in-container path. Host builds omit it and get the host store path.
 */
export function seedOverrides(warmWs: string, pkgDir: string, overrideBase?: string): void {
  // resolve symlinks so the recorded dirs survive a re-linked LAX_HOME (test
  // homes symlink the warm base into a shared cache)
  const warm = fs.existsSync(warmWs) ? fs.realpathSync(warmWs) : warmWs;
  const base = overrideBase ?? warm;
  const warmManifest = JSON.parse(
    fs.readFileSync(path.join(warm, "lake-manifest.json"), "utf8"),
  ) as { packages: WarmManifestEntry[] };
  const packages = warmManifest.packages.map((pkg) => ({
    type: "path",
    name: pkg.name,
    dir: path.join(base, ".lake", "packages", pkg.name),
    inherited: pkg.inherited,
    ...(pkg.scope === undefined ? {} : { scope: pkg.scope }),
  }));
  const lakeDir = path.join(pkgDir, ".lake");
  fs.mkdirSync(lakeDir, { recursive: true });
  const target = path.join(lakeDir, "package-overrides.json");
  const staged = path.join(lakeDir, `.package-overrides.lax-${process.pid}-${randomUUID()}`);
  fs.writeFileSync(staged, JSON.stringify({ version: "1.2.0", packages }, null, 1) + "\n");
  fs.renameSync(staged, target);
}

/**
 * Write the package's complete `lake-manifest.json`: the given path
 * dependencies (the proof package's own concept package and every required
 * submission materialized from its published capture), then the warm
 * workspace's locked mathlib closure **verbatim** — the overrides file
 * redirects those entries to the store at build time (see seedOverrides).
 * With every dependency present, lake resolves and fetches nothing.
 */
export function seedManifest(
  warmWs: string,
  pkgDir: string,
  pathDeps: { name: string; dir: string }[],
): void {
  const warmManifest = JSON.parse(
    fs.readFileSync(path.join(warmWs, "lake-manifest.json"), "utf8"),
  ) as { packages: Record<string, unknown>[] };

  const entries: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const dep of pathDeps) {
    if (seen.has(dep.name)) continue;
    seen.add(dep.name);
    entries.push({
      type: "path",
      scope: "",
      name: dep.name,
      manifestFile: "lake-manifest.json",
      inherited: false,
      dir: dep.dir,
      configFile: "lakefile.toml",
    });
  }
  entries.push(...warmManifest.packages);
  const target = path.join(pkgDir, "lake-manifest.json");
  const staged = path.join(pkgDir, `.lake-manifest.lax-${process.pid}-${randomUUID()}`);
  fs.writeFileSync(
    staged,
    JSON.stringify(
      { version: "1.2.0", packagesDir: ".lake/packages", packages: entries },
      null,
      1,
    ) + "\n",
  );
  fs.renameSync(staged, target);
}
