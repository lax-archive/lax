import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { laxHome } from "../../shared/lax-home.js";
import { lakeBinary, lakePathEnv } from "./leanenv.js";
import { run } from "./proc.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// The inspector's Lean sources ship with the repository. Compiled TS runs
// from dist/, whose tree carries no .lean files, so resolve the source dir
// through the repository root as well.
const SOURCE_CANDIDATES = [
  path.resolve(here, "..", "lean", "inspector"),
  path.resolve(here, "..", "..", "..", "src", "submission-validation", "lean", "inspector"),
];
const SOURCE_FILES = ["lean-toolchain", "lakefile.toml", "lake-manifest.json", "Main.lean"] as const;

function inspectorSourceDir(): string {
  const dir = SOURCE_CANDIDATES.find((candidate) =>
    fs.existsSync(path.join(candidate, "Main.lean")),
  );
  if (dir === undefined) throw new Error("the Lax inspector sources are missing from this installation");
  return dir;
}

function cliVersion(): string {
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(here, "..", "..", "..", "package.json"), "utf8"),
  ) as { version: string };
  return pkg.version;
}

/** Include the shipped sources in the cache identity. This matters during
 * development and for repackaged builds whose semver was not changed: an old
 * executable must never silently survive a checker/inspector source change. */
function inspectorCacheKey(): string {
  const source = inspectorSourceDir();
  const hash = createHash("sha256");
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
 * compiles it into ~/.lax/tools/<cli-version>-<source-hash>/ and every later
 * run of those exact sources reuses it.
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
  options: InspectorBuildOptions = {},
  toolsBase = path.join(laxHome(), "tools"),
): Promise<string> {
  const toolsDir = path.join(toolsBase, inspectorCacheKey());
  const binOf = (dir: string): string => path.join(dir, "src", ".lake", "build", "bin", "laxinspector");
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
    fs.copyFileSync(path.join(inspectorSourceDir(), f), path.join(stagingSrc, f));
  }
  options.onBuild?.();
  // artifact-cache off like every host lake invocation (see warmstore.ts)
  const res = await run(lakeBinary(), ["build"], stagingSrc, {
    echo: options.echo ?? false,
    env: { LAKE_ARTIFACT_CACHE: "false", PATH: lakePathEnv() },
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
