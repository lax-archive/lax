import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { laxHome } from "../../shared/lax-home.js";
import type { ArchiveEnvironment } from "../environments.js";
import { leanFacts } from "../lean-facts.js";
import { lakeBinary, lakePathEnv } from "./leanenv.js";
import { run } from "./proc.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// The inspector's Lean sources ship with the repository. Compiled TS runs
// from dist/, whose tree carries no .lean files, so resolve the source dir
// through the repository root as well.
const SOURCE_ROOTS = [
  path.resolve(here, "..", "lean"),
  path.resolve(here, "..", "..", "..", "src", "submission-validation", "lean"),
];
/** The shipped sources. `lean-toolchain` is *not* among them: it is generated
 * from the environment's entry into the staging directory (see below), so no
 * hand-maintained file can drift from the table. */
const SOURCE_FILES = ["lakefile.toml", "lake-manifest.json", "Main.lean"] as const;

/** The inspector source directory the environment's entry names. One source
 * must compile under every admitted environment; when a release forces a
 * change that cannot be written version-agnostically, the old source is frozen
 * as `lean/inspector-<label>/` and the older entries point at it. */
function inspectorSourceDir(environment: ArchiveEnvironment): string {
  const root = SOURCE_ROOTS.find((candidate) =>
    fs.existsSync(path.join(candidate, environment.inspector, "Main.lean")),
  );
  if (root === undefined) throw new Error("the Lax inspector sources are missing from this installation");
  return path.join(root, environment.inspector);
}

function cliVersion(): string {
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(here, "..", "..", "..", "package.json"), "utf8"),
  ) as { version: string };
  return pkg.version;
}

/** Include the shipped sources *and* the environment's toolchain in the cache
 * identity. The sources matter during development and for repackaged builds
 * whose semver was not changed: an old executable must never silently survive
 * a checker/inspector source change. The toolchain matters because two
 * environments build the same sources into different executables. */
function inspectorCacheKey(environment: ArchiveEnvironment): string {
  const source = inspectorSourceDir(environment);
  const hash = createHash("sha256");
  hash.update(environment.leanToolchain);
  hash.update("\0");
  for (const file of SOURCE_FILES) {
    hash.update(file);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(source, file)));
    hash.update("\0");
  }
  return `${cliVersion()}-${hash.digest("hex").slice(0, 16)}`;
}

export interface InspectorBuildOptions {
  /** Stream lake's own transcript, as `--verbose` does for every other build. */
  echo?: boolean;
  /** Say that this run has to compile the inspector, so the caller's row can
   * account for the half-minute rather than looking stuck. */
  onBuild?: () => void;
}

/**
 * The inspector's source ships with the CLI; the first build on a machine
 * compiles it into ~/.lax/tools/<cli-version>-<source+toolchain-hash>/ and
 * every later run of those exact sources in that environment reuses it.
 *
 * The build happens in a process-private staging dir renamed into place:
 * concurrent builders (parallel test forks; two CLI runs right after an
 * upgrade) must not interleave `lake build` inside one directory. The loser
 * of the rename discards its copy and uses the winner's.
 *
 * Nothing here writes to the terminal on its own: the CLI is redrawing a live
 * region by counting the lines it wrote, and a line it did not write is a line
 * it erases instead of its own — which is what a torn, duplicated step list is.
 */
export async function inspectorBinary(
  environment: ArchiveEnvironment,
  options: InspectorBuildOptions = {},
  toolsBase = path.join(laxHome(), "tools"),
): Promise<string> {
  const toolsDir = path.join(toolsBase, inspectorCacheKey(environment));
  const binOf = (dir: string): string =>
    path.join(dir, "src", ...leanFacts(environment).lakeBinDir, "laxinspector");
  // resolve symlinks (shared tools dirs are linked into each test home):
  // downstream consumers compose path-literal LEAN_PATHs around the binary
  const bin = binOf(toolsDir);
  if (fs.existsSync(bin)) return fs.realpathSync(bin);
  // a dir without the binary is the leftover of an interrupted build
  fs.rmSync(toolsDir, { recursive: true, force: true });

  const staging = `${toolsDir}.build-${process.pid}`;
  const stagingSrc = path.join(staging, "src");
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(stagingSrc, { recursive: true });
  for (const f of SOURCE_FILES) {
    fs.copyFileSync(path.join(inspectorSourceDir(environment), f), path.join(stagingSrc, f));
  }
  // Generated, never shipped: the toolchain the inspector builds under is the
  // environment's, and only the table says what that is.
  fs.writeFileSync(path.join(stagingSrc, "lean-toolchain"), `${environment.leanToolchain}\n`);
  options.onBuild?.();
  // artifact-cache off like every host lake invocation (see warmstore.ts)
  const res = await run(lakeBinary(environment), ["build"], stagingSrc, {
    echo: options.echo ?? false,
    env: { LAKE_ARTIFACT_CACHE: "false", PATH: lakePathEnv(environment) },
  });
  if (res.code !== 0 || !fs.existsSync(binOf(staging))) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(`failed to build the inspector (exit ${res.code})`);
  }
  try {
    fs.renameSync(staging, toolsDir);
  } catch (err) {
    // another builder renamed first; keep theirs
    fs.rmSync(staging, { recursive: true, force: true });
    if (!fs.existsSync(bin)) throw err;
  }
  return fs.realpathSync(bin);
}
