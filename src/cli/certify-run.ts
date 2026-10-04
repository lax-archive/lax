// A reader's `lax certify --run`: the certificate checked on the reader's
// machine in the trusted path's own shape (certify/phase.ts) — the
// Challenge built and exported, held to the theorems the bundle states, the
// solution module built and exported, and the toolchain's `lake comparator`
// handed both exports, so it builds and resolves nothing itself and judges
// exactly the two files that were read.
//
// Every run starts from nothing (ultracode review 2026-10-04, S1). The run
// project is a fresh scratch folder holding the bundle's files and an empty
// `.lake`; nothing of the certificate folder's own `.lake` — which a
// reader's by-hand `lake comparator` may have left, and whose checkouts a
// sandboxed build could write — is read, and no host tool (git, lake, or
// anything else) ever runs in a tree a sandboxed run could write. Earlier,
// the folder's `.lake` was kept between runs and its checkouts verified with
// host `git status`, which a previous run's proof code could arm through
// `core.fsmonitor` in a checkout's `.git/config`; there is no checkout to
// verify now. Where the packages come from:
//
//   the environment's libraries  the warm workspace (`lax doctor --env`), a
//                                read-only store lax built, bound read-only
//                                and named in `.lake/package-overrides.json`
//                                exactly as a local build names it
//   the record packages          the *sources* of each record's published
//                                capture (cli/capture-cache.ts: digest
//                                verified, held to its inventory), copied
//                                into the scratch folder and built there —
//                                never the captured build products, which an
//                                untrusted build produced (ultracode review
//                                2026-10-04, M1): concept packages into the
//                                run's `.lake`, proof packages into a folder
//                                beside the project that the Challenge's
//                                build sees read-only
//
// so the run needs no network, no git, and no author repository: the
// bundle's manifest still names the records' git sources, and each one is
// held to the record's commit before its override is written. Each step
// runs under bubblewrap with the arguments `lake comparator` gives its own
// children (pinned `Lake/CLI/Check.lean` `buildSandboxArgs`), with `.lake`
// the only writable mount of a build and none for an export or the
// inspection; the host reads back only the two exports, streamed from the
// exporter's stdout, and the report, written into a folder only the
// inspector's own sandbox has writable. A1's rule — nothing of any proof
// package is writable while concept-package code runs — holds as far as one
// Lake workspace allows: the bundle's lakefile requires the proof packages,
// so Lake reads their (TOML) configuration in the Challenge's build, but it
// can write neither their sources nor their build products, and the
// overrides and the project's own build tree that build could write are
// written again and removed before the solution module is built. The search path is composed from
// the overrides lax wrote, never taken from `lake env`. The comparator then
// runs its kernels in its own sandbox, in a judge folder holding the
// bundle's files alone and a `git` that refuses (`mkContext` probes PATH for
// one), as container C does.
//
// A global `macro_rules` in a concept package the Challenge imports can make
// the Challenge elaborate to something else than the edge its text names,
// which is why the Challenge is held (certify/challenge-check.ts; decision
// 10's E1 defence). Without the inspector — it is compiled on first use, and
// that can fail — the Challenge is still built and exported and the
// comparator still judges, and the verdict says the Challenge's meaning was
// not checked rather than "certified".

import fs from "node:fs";
import path from "node:path";
import { challengeBuildViolation, challengeInspectorArguments, holdChallenge } from "../submission-validation/certify/challenge-check.js";
import {
  CHALLENGE_MODULE,
  bundleMembers,
  comparatorExportTargets,
  type Bundle,
  type CertificateTheorem,
} from "../submission-validation/certify/generate.js";
import { leanName } from "../submission-validation/certify/lean-name.js";
import { writeJudgeProject } from "../submission-validation/certify/project.js";
import { interpretComparatorRun, solutionBuildViolation, type ComparatorVerdict } from "../submission-validation/certify/verdict.js";
import { limitsFor } from "../submission-validation/config.js";
import type { ArchiveEnvironment } from "../submission-validation/environments.js";
import { PipelineFailure, failureMessage, infrastructureFailure } from "../submission-validation/failures.js";
import { inspectorBinary } from "../submission-validation/host/inspector.js";
import { lakeBinary, lakePathEnv, packageLibDir, toolchainBinDir, toolchainDir } from "../submission-validation/host/leanenv.js";
import { run, runToFile, type RunResult } from "../submission-validation/host/proc.js";
import { readWarmManifestPackages, seedOverrides, warmDir, warmReady } from "../submission-validation/host/warmstore.js";
import { leanFacts } from "../submission-validation/lean-facts.js";
import { isObject } from "../shared/validation.js";

/** One package the bundle's manifest lists, as far as this command reads it. */
export interface ManifestPackage {
  name: string;
  type: unknown;
  rev?: string;
}

/**
 * The bundle's `lake-manifest.json` read as data: the packages it lists,
 * each name held to one Lake can use as a directory name.
 */
export function readBundleManifest(manifest: string): ManifestPackage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest);
  } catch {
    throw new Error("the bundle's lake-manifest.json is not JSON");
  }
  const packages: ManifestPackage[] = [];
  for (const entry of isObject(parsed) && Array.isArray(parsed.packages) ? parsed.packages : []) {
    if (!isObject(entry) || typeof entry.name !== "string") continue;
    if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(entry.name) || entry.name === "." || entry.name === "..")
      throw new Error(`the bundle's manifest names a package Lake cannot check out: ${JSON.stringify(entry.name)}`);
    packages.push({ name: entry.name, type: entry.type, ...(typeof entry.rev === "string" ? { rev: entry.rev } : {}) });
  }
  return packages;
}

/** A record package's source tree, from its record's verified capture. */
export interface RecordPackageSource {
  /** Which of the record's two packages: a proof package is laid out where
   * the Challenge's build cannot write it (prepareRunProject). */
  kind: "concepts" | "proofs";
  /** The package root to copy: the capture's `<kind>/package`. */
  dir: string;
  /** The record's source commit, which the manifest entry must pin. */
  rev: string;
}

/** The run project: where it is, where each package is, and what the
 * sandbox must see read-only beyond it. */
export interface RunProject {
  directory: string;
  /** The folder beside the project holding the proof packages' copies:
   * read-only in the Challenge's build, writable in the solution module's. */
  proofs: string;
  /** The project's own lib dir, then each package root's, in manifest order. */
  libDirs: string[];
  /** The warm store and each of its package roots, resolved, and the proof
   * packages' folder. */
  readable: string[];
  /** Writes `.lake/package-overrides.json` — again before the solution
   * module's build, since the Challenge's build could rewrite it. */
  writeOverrides: () => void;
}

/**
 * Lay the run project out under `scratch`: the bundle's files verbatim, a
 * fresh `.lake` holding a copy of every concept package's captured sources,
 * a copy of every proof package's beside the project, and
 * `.lake/package-overrides.json` pointing every package the manifest
 * lists at those copies or at the warm workspace. A package the manifest
 * lists that neither covers, or pins at another revision than the record or
 * the warm workspace has, is refused here, before anything runs: Lake would
 * otherwise clone it, and the run has no network.
 */
export function prepareRunProject(input: {
  scratch: string;
  environment: ArchiveEnvironment;
  files: Bundle;
  sources: ReadonlyMap<string, RecordPackageSource>;
}): RunProject {
  const { environment } = input;
  const ws = warmDir(environment);
  if (!warmReady(ws)) {
    throw new Error(
      `the ${environment.id} workspace is not on this machine, and --run builds against it — run ` +
        `lax doctor --env ${environment.id} first`,
    );
  }
  const warm = fs.realpathSync(ws);
  const warmRevs = new Map<string, unknown>();
  for (const entry of readWarmManifestPackages(warm)) if (typeof entry.name === "string") warmRevs.set(entry.name, entry.rev);
  const facts = leanFacts(environment);
  const directory = path.join(input.scratch, "project");
  const sourcesDir = path.join(directory, facts.lakeDir, "sources");
  const proofsDir = path.join(input.scratch, "proofs");
  fs.mkdirSync(sourcesDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(proofsDir, { mode: 0o700 });
  for (const { name, content } of bundleMembers(input.files)) fs.writeFileSync(path.join(directory, name), content, { mode: 0o644 });

  const libDirs = [packageLibDir(directory)];
  const readable = [warm];
  const extra: Array<{ name: string; dir: string }> = [];
  for (const entry of readBundleManifest(input.files["lake-manifest.json"])) {
    const source = input.sources.get(entry.name);
    if (source !== undefined) {
      if (entry.rev !== source.rev)
        throw new Error(`the bundle pins ${entry.name} at ${entry.rev ?? "no revision"}, but its record's capture is of ${source.rev}`);
      const copy = path.join(source.kind === "proofs" ? proofsDir : sourcesDir, entry.name);
      fs.cpSync(source.dir, copy, { recursive: true, verbatimSymlinks: true });
      // Lake writes the copy's own `.lake` beside its sources; a captured
      // tree may carry read-only directories
      openDirectories(copy);
      extra.push({ name: entry.name, dir: copy });
      libDirs.push(packageLibDir(copy));
      continue;
    }
    if (!warmRevs.has(entry.name))
      throw new Error(`the bundle requires ${entry.name}, which is neither a record's package nor in the ${environment.id} workspace`);
    if (warmRevs.get(entry.name) !== entry.rev) {
      throw new Error(
        `the bundle pins ${entry.name} at ${entry.rev ?? "no revision"}, the ${environment.id} workspace on this machine at ` +
          `${String(warmRevs.get(entry.name))}; the bundle was built against other library pins`,
      );
    }
    const root = path.join(warm, ...facts.lakePackagesDir, entry.name);
    if (!fs.existsSync(root))
      throw new Error(`the ${environment.id} workspace lists ${entry.name} but holds no checkout of it — run lax doctor --env ${environment.id}`);
    libDirs.push(packageLibDir(root));
    // a store package may itself be a link into a shared cache: bound at
    // its own place too, or the sandbox would see a dangling link
    readable.push(fs.realpathSync(root));
  }
  const writeOverrides = (): void => seedOverrides(warm, directory, undefined, extra);
  writeOverrides();
  return { directory, proofs: proofsDir, libDirs, readable: [...new Set([...readable, proofsDir])], writeOverrides };
}

/** Make every directory under `root` writable by its owner, never through
 * a link (the tree is a verified capture's copy: it holds none). */
function openDirectories(root: string): void {
  fs.chmodSync(root, 0o755);
  for (const entry of fs.readdirSync(root, { withFileTypes: true }))
    if (entry.isDirectory()) openDirectories(path.join(root, entry.name));
}

interface Confined {
  cmd: string;
  args: string[];
  /** Bound read-only back over the covered home and temp directories. */
  readable: string[];
  writable: string[];
  /** Masked with an empty tmpfs (Lake's `forbiddenPaths` for build and export). */
  tmpfs: string[];
  network: boolean;
  env: Record<string, string>;
}

/**
 * The bubblewrap command line `lake comparator` builds for its own children
 * (pinned `Lake/CLI/Check.lean` `buildSandboxArgs`), transcribed: `/`
 * read-only, the home and temp directories covered, the environment
 * cleared, every namespace unshared and the network only when asked.
 */
export function bubblewrapArguments(directory: string, confined: Confined): string[] {
  return [
    "--ro-bind", "/", "/",
    "--tmpfs", "/home",
    "--tmpfs", "/root",
    "--tmpfs", "/run/user",
    "--tmpfs", "/tmp",
    "--dir", "/tmp/home",
    "--dev", "/dev",
    "--proc", "/proc",
    "--clearenv",
    ...confined.tmpfs.flatMap((entry) => ["--tmpfs", entry]),
    ...confined.readable.flatMap((entry) => ["--ro-bind", entry, entry]),
    ...confined.writable.flatMap((entry) => ["--bind", entry, entry]),
    ...Object.entries(confined.env).flatMap(([name, value]) => ["--setenv", name, value]),
    "--setenv", "HOME", "/tmp/home",
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    ...(confined.network ? ["--share-net"] : []),
    "--chdir", directory,
    "--", confined.cmd, ...confined.args,
  ];
}

/** Lake's own `forbiddenPaths`, masked for every step. */
const FORBIDDEN = ["/run", "/var"];

export type ChallengeHold =
  | { kind: "held"; challengeExport: string }
  | { kind: "unchecked"; reason: string; challengeExport: string }
  | { kind: "refused"; verdict: Exclude<ComparatorVerdict, { kind: "certified" }> };

export type SolutionBuild =
  | { kind: "exported"; solutionExport: string }
  | { kind: "refused"; verdict: Exclude<ComparatorVerdict, { kind: "certified" }> };

export interface RunInput {
  project: RunProject;
  environment: ArchiveEnvironment;
  /** What the Challenge must state: the theorems the bundle was generated
   * from — a record's edges, one edge, or a relative certificate's one. */
  theorems: readonly CertificateTheorem[];
  /** A fresh folder beside the project for the exports and the report; the
   * caller removes it with the project. */
  scratch: string;
  echo: boolean;
  /** Progress for the step row: what is running now. */
  onDetail: (text: string) => void;
}

/** The bubblewrap every step runs under: `COMPARATOR_BWRAP` when set, as
 * `lake comparator` reads it for its kernels, else `bwrap` on PATH. The one
 * place both the preflight (cli/certify.ts) and the runner take it from. */
export function bubblewrapCommand(): string {
  return process.env.COMPARATOR_BWRAP ?? "bwrap";
}

/** The sandbox runner of one run: the toolchain and the warm store
 * readable, the project read-only. */
function sandboxFor(input: RunInput): {
  confined: (confined: Omit<Confined, "readable"> & { readable?: string[] }) => Promise<RunResult>;
  toFile: (confined: Omit<Confined, "readable"> & { readable?: string[] }, file: string) => Promise<RunResult>;
  buildEnv: Record<string, string>;
  readEnv: Record<string, string>;
} {
  const { environment, project } = input;
  const toolchain = toolchainDir(environment);
  const toolchainPaths = [...new Set([toolchain, fs.realpathSync(toolchain)])];
  const args = (confined: Omit<Confined, "readable"> & { readable?: string[] }): string[] =>
    bubblewrapArguments(project.directory, {
      ...confined,
      readable: [project.directory, ...toolchainPaths, ...project.readable, ...(confined.readable ?? [])],
    });
  const bwrap = bubblewrapCommand();
  const opts = { echo: input.echo, maxOutputBytes: 16 * 1024 * 1024 };
  const pathEnv = lakePathEnv(environment);
  return {
    confined: (confined) => run(bwrap, args(confined), project.directory, opts),
    toFile: (confined, file) => runToFile(bwrap, args(confined), project.directory, file, { maxOutputBytes: opts.maxOutputBytes }),
    // the warm store is read-only: Lake must replay it, never rebuild into
    // it, exactly as a local build against it (certify/host.ts)
    buildEnv: { PATH: pathEnv, LEAN_ABORT_ON_PANIC: "1", LAKE_ARTIFACT_CACHE: "false" },
    readEnv: { LEAN_PATH: project.libDirs.join(path.delimiter), PATH: pathEnv, LEAN_ABORT_ON_PANIC: "1" },
  };
}

/** `lake build <module>` in the sandbox, `.lake` — and, for the solution
 * module, the proof packages' folder — the only writable mounts and no
 * network: every package is on disk already. */
async function buildModule(input: RunInput, module: string, writable: "challenge" | "solution"): Promise<RunResult> {
  const sandbox = sandboxFor(input);
  input.onDetail(`lake build ${module}`);
  const lake = path.join(input.project.directory, leanFacts(input.environment).lakeDir);
  return sandbox.confined({
    cmd: lakeBinary(input.environment), args: ["build", module],
    writable: writable === "challenge" ? [lake] : [lake, input.project.proofs], tmpfs: FORBIDDEN, network: false,
    env: sandbox.buildEnv,
  });
}

/** Remove what a sandboxed build may have written, never through a link: the
 * build has exited (`--die-with-parent`, its own pid namespace), so nothing
 * changes the tree while it is walked. */
function removeWritten(target: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return;
  }
  if (!stat.isDirectory()) {
    fs.unlinkSync(target);
    return;
  }
  fs.chmodSync(target, 0o700);
  for (const entry of fs.readdirSync(target)) removeWritten(path.join(target, entry));
  fs.rmdirSync(target);
}

/** `leanexport <module> -- <targets>` over the built tree, nothing
 * writable: the export is the exporter's stdout, streamed to `file`. */
async function exportModule(input: RunInput, module: string, file: string): Promise<void> {
  const sandbox = sandboxFor(input);
  input.onDetail(`exporting ${module}`);
  const theoremNames = input.theorems.map((theorem) => leanName(theorem.name));
  const exported = await sandbox.toFile({
    cmd: path.join(toolchainBinDir(input.environment), "leanexport"),
    args: [module, "--", ...comparatorExportTargets(theoremNames, leanFacts(input.environment))],
    writable: [], tmpfs: FORBIDDEN, network: false, env: sandbox.readEnv,
  }, file);
  if (exported.code !== 0) throw stepFailure(`exporting ${module}`, exported);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size === 0) throw infrastructureFailure(`the ${module} export is empty`);
}

/**
 * The Challenge built, exported, and — with the inspector — read and held
 * to the theorems. The concept packages' code runs in the build, with the
 * proof packages read-only; nothing of that run is alive in the steps after
 * it.
 */
export async function holdChallengeInSandbox(input: RunInput): Promise<ChallengeHold> {
  const { environment } = input;
  let inspector: string | undefined;
  let unavailable = "";
  try {
    inspector = await inspectorBinary(environment, { echo: input.echo, onBuild: () => input.onDetail("building the inspector") });
  } catch (error) {
    unavailable = `the ${environment.id} inspector could not be built here: ${failureMessage(error)}`;
  }
  try {
    const built = await buildModule(input, CHALLENGE_MODULE, "challenge");
    // 3 is host/proc.ts's "terminated by a signal": never the author's
    if (built.code === 3) throw stepFailure(`building the ${CHALLENGE_MODULE}`, built);
    if (built.code !== 0) return { kind: "refused", verdict: challengeBuildViolation(built.output) };

    const challengeExport = path.join(input.scratch, "challenge.export");
    await exportModule(input, CHALLENGE_MODULE, challengeExport);
    if (inspector === undefined) return { kind: "unchecked", reason: unavailable, challengeExport };

    input.onDetail(`reading the ${CHALLENGE_MODULE} with the inspector`);
    const sandbox = sandboxFor(input);
    const reports = path.join(input.scratch, "inspect");
    fs.mkdirSync(reports, { mode: 0o700 });
    const report = path.join(reports, "challenge-report.json");
    const inspected = await sandbox.confined({
      cmd: inspector, args: challengeInspectorArguments(report),
      readable: [path.dirname(inspector)], writable: [reports], tmpfs: FORBIDDEN, network: false, env: sandbox.readEnv,
    });
    if (inspected.code !== 0) throw stepFailure(`inspecting the ${CHALLENGE_MODULE}`, inspected);

    const mismatch = holdChallenge(report, limitsFor(environment).inspectorReportBytes, input.theorems);
    if (mismatch !== undefined) return { kind: "refused", verdict: mismatch };
    return { kind: "held", challengeExport };
  } catch (error) {
    if (error instanceof PipelineFailure) return { kind: "refused", verdict: { kind: "failure", failure: error } };
    throw error;
  }
}

/**
 * The solution module — a record's proof package, or a relative
 * certificate's composed `Solution` — built and exported, after the
 * Challenge's export exists outside every writable mount. What the
 * Challenge's build could write and this build would read as the proof
 * packages' — the overrides naming where they are, and the project's own
 * build tree, where a relative certificate's `Solution` is built — is
 * written again and removed first. The proof packages' code runs in this
 * build.
 */
export async function buildSolutionInSandbox(input: RunInput, solutionModule: string): Promise<SolutionBuild> {
  try {
    input.project.writeOverrides();
    removeWritten(path.join(input.project.directory, leanFacts(input.environment).lakeDir, "build"));
    const built = await buildModule(input, solutionModule, "solution");
    if (built.code === 3) throw stepFailure(`building ${solutionModule}`, built);
    if (built.code !== 0) return { kind: "refused", verdict: solutionBuildViolation(solutionModule, built.output) };
    const solutionExport = path.join(input.scratch, "solution.export");
    await exportModule(input, solutionModule, solutionExport);
    return { kind: "exported", solutionExport };
  } catch (error) {
    if (error instanceof PipelineFailure) return { kind: "refused", verdict: { kind: "failure", failure: error } };
    throw error;
  }
}

/**
 * `lake comparator --config comparator.json --challenge-from-export …
 * --solution-from-export … [--paranoid]` in a judge folder holding the
 * bundle's files alone, with the toolchain's bin dir first on PATH and a
 * refusing `git` before it — container C's command, with the comparator's
 * own sandbox around its kernels in place of the container.
 */
export async function judgeExports(input: {
  scratch: string;
  environment: ArchiveEnvironment;
  files: Bundle;
  challengeExport: string;
  solutionExport: string;
  paranoid: boolean;
  echo: boolean;
}): Promise<{ verdict: ComparatorVerdict; kernels: string[] }> {
  const { environment } = input;
  const judge = writeJudgeProject(path.join(input.scratch, "judge"), input.files);
  const result = await run(
    lakeBinary(environment),
    [
      "comparator",
      "--config", "comparator.json",
      "--challenge-from-export", input.challengeExport,
      "--solution-from-export", input.solutionExport,
      ...(input.paranoid ? ["--paranoid"] : []),
    ],
    judge.projectDir,
    { echo: input.echo, env: { PATH: `${judge.shimsDir}${path.delimiter}${lakePathEnv(environment)}` }, maxOutputBytes: 16 * 1024 * 1024 },
  );
  if (/unknown (?:sub)?command/iu.test(result.output) && /comparator/u.test(result.output))
    throw new Error(`the toolchain ${environment.leanToolchain} has no \`lake comparator\`: ${result.output.trim()}`);
  // `<kernel> kernel accepts the solution`, one line per kernel that ran
  // (Lake/CLI/Check.lean runExternalKernel); the record's names for them
  const accepted = [...result.output.matchAll(/^(.+?) kernel accepts the solution$/gmu)].map((match) => match[1]!);
  return { verdict: interpretComparatorRun(result), kernels: accepted };
}

function stepFailure(what: string, result: RunResult): PipelineFailure {
  return infrastructureFailure(`${what} in the sandbox failed (exit ${result.code}):\n${result.output.trim() || "no output"}`);
}
