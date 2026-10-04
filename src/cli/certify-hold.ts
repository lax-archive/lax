// The Challenge held to the telescope on a reader's `lax certify --run`
// (ultracode review 2026-10-04, S2; decision 10's E1 defence, which until
// then ran only in container A2 and behind `lax build`). `lake comparator`
// judges the proof against whatever the Challenge *elaborated to*, and a
// global `macro_rules` in a concept package the Challenge imports can make
// that something else than the edge the text names. So before the
// comparator runs, the Challenge is built, exported and read by the
// per-environment inspector here, each step under bubblewrap the way
// `lake comparator` confines its own (pinned `Lake/CLI/Check.lean`
// `buildSandboxArgs`), and its theorems are held to the ones the bundle was
// generated from (certify/challenge-check.ts). The comparator is then handed
// *this* export with `--challenge-from-export`, so the Challenge it judges
// against is byte for byte the one the inspector read: no code runs between
// the two reads, and the proof package's build — which has `.lake`
// writable inside the comparator's sandbox — comes after both.
//
// No host tool runs in a tree a sandboxed run can write (the S1 rule): lake
// resolves and builds only inside the sandbox, the exporter and the
// inspector read the build tree read-only inside it, and the host reads
// back two files the sandbox could not write — the export, streamed from the
// exporter's stdout, and the report, written into a scratch folder that only
// the inspector's own sandbox has writable. The search path is composed from
// the bundle's manifest, which lax wrote, never taken from `lake env`.
//
// Without the inspector — it is compiled on first use, and that can fail —
// the comparator still runs as the bundle's own command, and the verdict
// says the Challenge's meaning was not checked rather than "certified".

import fs from "node:fs";
import path from "node:path";
import { challengeBuildViolation, challengeInspectorArguments, holdChallenge } from "../submission-validation/certify/challenge-check.js";
import { CHALLENGE_MODULE, comparatorExportTargets, type CertificateTheorem } from "../submission-validation/certify/generate.js";
import { leanName } from "../submission-validation/certify/lean-name.js";
import type { ComparatorVerdict } from "../submission-validation/certify/verdict.js";
import { limitsFor } from "../submission-validation/config.js";
import type { ArchiveEnvironment } from "../submission-validation/environments.js";
import { PipelineFailure, failureMessage, infrastructureFailure } from "../submission-validation/failures.js";
import { inspectorBinary } from "../submission-validation/host/inspector.js";
import { lakeBinary, lakePathEnv, toolchainBinDir, toolchainDir } from "../submission-validation/host/leanenv.js";
import { run, runToFile, type RunResult } from "../submission-validation/host/proc.js";
import { leanFacts } from "../submission-validation/lean-facts.js";
import { isObject } from "../shared/validation.js";

export type ChallengeHold =
  | { kind: "held"; challengeExport: string }
  | { kind: "unchecked"; reason: string }
  | { kind: "refused"; verdict: Exclude<ComparatorVerdict, { kind: "certified" }> };

/** One package the bundle's manifest lists, as far as this command reads it. */
export interface ManifestPackage {
  name: string;
  type: unknown;
  rev?: string;
  /** The package root inside its checkout (`concepts` for a record's). */
  subDir?: string;
}

/**
 * The bundle's `lake-manifest.json` read as data: where Lake puts the
 * checkouts and which packages it lists. Every name and directory is held
 * to a plain relative path here, once, for both readers — the workspace
 * check (cli/certify.ts verifyCertificateWorkspace) and the search path
 * below.
 */
export function readBundleManifest(manifest: string): { packagesDir: string; packages: ManifestPackage[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest);
  } catch {
    throw new Error("the bundle's lake-manifest.json is not JSON");
  }
  const packagesDir = isObject(parsed) && typeof parsed.packagesDir === "string" ? parsed.packagesDir : leanFacts().lakePackagesDir.join("/");
  if (!plainRelative(packagesDir)) throw new Error(`the bundle's manifest puts its packages at ${JSON.stringify(packagesDir)}, not inside the folder`);
  const packages: ManifestPackage[] = [];
  for (const entry of isObject(parsed) && Array.isArray(parsed.packages) ? parsed.packages : []) {
    if (!isObject(entry) || typeof entry.name !== "string") continue;
    if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(entry.name) || entry.name === "." || entry.name === "..")
      throw new Error(`the bundle's manifest names a package Lake cannot check out: ${JSON.stringify(entry.name)}`);
    const subDir = typeof entry.subDir === "string" ? entry.subDir : undefined;
    if (subDir !== undefined && !plainRelative(subDir))
      throw new Error(`the bundle's manifest gives ${entry.name} the subdirectory ${JSON.stringify(subDir)}, not one inside its checkout`);
    packages.push({ name: entry.name, type: entry.type, ...(typeof entry.rev === "string" ? { rev: entry.rev } : {}), ...(subDir === undefined ? {} : { subDir }) });
  }
  return { packagesDir, packages };
}

function plainRelative(value: string): boolean {
  return value !== "" && !path.isAbsolute(value) && !value.split(/[\\/]/u).some((part) => part === ".." || part === "");
}

/** The lib dirs the Challenge imports from, composed like every inspection's
 * search path (host/leanenv.ts): the certificate project's own build tree,
 * then each listed package's at the root Lake gives it. */
function bundleLibDirs(directory: string, manifest: string): string[] {
  const facts = leanFacts();
  const { packagesDir, packages } = readBundleManifest(manifest);
  return [
    path.join(directory, ...facts.lakeLibDir),
    ...packages.map((pkg) => path.join(directory, packagesDir, pkg.name, pkg.subDir ?? "", ...facts.lakeLibDir)),
  ];
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

/** Lake's own `forbiddenPaths`, masked for every step but resolution. */
const FORBIDDEN = ["/run", "/var"];

export interface HoldInput {
  /** The certificate folder: the bundle, `lean-toolchain`, and `.lake`. */
  directory: string;
  environment: ArchiveEnvironment;
  /** The bundle's `lake-manifest.json`, as written into the folder. */
  manifest: string;
  /** What the Challenge must state: the theorems the bundle was generated
   * from — a record's edges, one edge, or a relative certificate's one. */
  theorems: readonly CertificateTheorem[];
  /** A fresh folder outside the certificate folder; the caller removes it
   * after the comparator has read the export. */
  scratch: string;
  echo: boolean;
  /** Progress for the step row: what is running now. */
  onDetail: (text: string) => void;
}

export async function holdChallengeInSandbox(input: HoldInput): Promise<ChallengeHold> {
  const { directory, environment } = input;
  let inspector: string;
  try {
    inspector = await inspectorBinary(environment, { echo: input.echo, onBuild: () => input.onDetail("building the inspector") });
  } catch (error) {
    return { kind: "unchecked", reason: `the ${environment.id} inspector could not be built here: ${failureMessage(error)}` };
  }
  try {
    const toolchain = toolchainDir(environment);
    const toolchainPaths = [...new Set([toolchain, fs.realpathSync(toolchain)])];
    const sandboxed = (confined: Omit<Confined, "readable"> & { readable?: string[] }): string[] =>
      bubblewrapArguments(directory, { ...confined, readable: [directory, ...toolchainPaths, ...(confined.readable ?? [])] });
    const bwrap = process.env.COMPARATOR_BWRAP ?? "bwrap";
    const opts = { echo: input.echo, maxOutputBytes: 16 * 1024 * 1024 };
    const pathEnv = lakePathEnv(environment);
    const dotLake = path.join(directory, leanFacts().lakeDir);
    fs.mkdirSync(dotLake, { recursive: true });

    // resolution elaborates the packages' configurations: the one step with
    // a network, as in the comparator's own `safeResolveDeps`
    input.onDetail("resolving the bundle's packages");
    const resolved = await run(bwrap, sandboxed({
      cmd: lakeBinary(environment), args: ["resolve-deps"], writable: [dotLake], tmpfs: [], network: true,
      env: { PATH: pathEnv, LEAN_ABORT_ON_PANIC: "1" },
    }), directory, opts);
    if (resolved.code !== 0) throw stepFailure("resolving the bundle's packages", resolved);

    // the build, where the concept packages' code runs; no proof code is
    // present, and nothing of this run is alive in the steps below
    input.onDetail(`lake build ${CHALLENGE_MODULE}`);
    const built = await run(bwrap, sandboxed({
      cmd: lakeBinary(environment), args: ["build", CHALLENGE_MODULE], writable: [dotLake], tmpfs: FORBIDDEN, network: false,
      env: { PATH: pathEnv, LEAN_ABORT_ON_PANIC: "1" },
    }), directory, opts);
    // 3 is host/proc.ts's "terminated by a signal": never the author's
    if (built.code === 3) throw stepFailure(`building the ${CHALLENGE_MODULE}`, built);
    if (built.code !== 0) return { kind: "refused", verdict: challengeBuildViolation(built.output) };

    // the export the comparator will judge against, and the inspection,
    // both over the build tree read-only
    const readEnv = {
      LEAN_PATH: bundleLibDirs(directory, input.manifest).join(path.delimiter),
      PATH: pathEnv,
      LEAN_ABORT_ON_PANIC: "1",
    };
    input.onDetail(`exporting the ${CHALLENGE_MODULE}`);
    const challengeExport = path.join(input.scratch, "challenge.export");
    const theoremNames = input.theorems.map((theorem) => leanName(theorem.name));
    const exported = await runToFile(bwrap, sandboxed({
      cmd: path.join(toolchainBinDir(environment), "leanexport"),
      args: [CHALLENGE_MODULE, "--", ...comparatorExportTargets(theoremNames, leanFacts(environment))],
      writable: [], tmpfs: FORBIDDEN, network: false, env: readEnv,
    }), directory, challengeExport, { maxOutputBytes: opts.maxOutputBytes });
    if (exported.code !== 0) throw stepFailure(`exporting the ${CHALLENGE_MODULE}`, exported);
    const stat = fs.lstatSync(challengeExport);
    if (!stat.isFile() || stat.size === 0) throw infrastructureFailure(`the ${CHALLENGE_MODULE} export is empty`);

    input.onDetail(`reading the ${CHALLENGE_MODULE} with the inspector`);
    const reports = path.join(input.scratch, "inspect");
    fs.mkdirSync(reports, { mode: 0o700 });
    const report = path.join(reports, "challenge-report.json");
    const inspected = await run(bwrap, sandboxed({
      cmd: inspector, args: challengeInspectorArguments(report),
      readable: [path.dirname(inspector)], writable: [reports], tmpfs: FORBIDDEN, network: false, env: readEnv,
    }), directory, opts);
    if (inspected.code !== 0) throw stepFailure(`inspecting the ${CHALLENGE_MODULE}`, inspected);

    const mismatch = holdChallenge(report, limitsFor(environment).inspectorReportBytes, input.theorems);
    if (mismatch !== undefined) return { kind: "refused", verdict: mismatch };
    return { kind: "held", challengeExport };
  } catch (error) {
    if (error instanceof PipelineFailure) return { kind: "refused", verdict: { kind: "failure", failure: error } };
    throw error;
  }
}

function stepFailure(what: string, result: RunResult): PipelineFailure {
  return infrastructureFailure(`${what} in the sandbox failed (exit ${result.code}):\n${result.output.trim() || "no output"}`);
}
