// Runs one of Certify's steps (axiomfree-plan.md, "Certify" 2–3;
// certify/phase.ts) inside the sandbox, from a plan the phase wrote:
//
//   { tool: "build", project, module }
//     container A1: `lake build Challenge` in the generated project, over the
//     concept packages. This is the step that runs candidate code — every
//     module initializer of every package the module imports — so it is given
//     a writable `.lake` and nothing else writable; the plan is read from a
//     read-only mount.
//   { tool: "export", project, module, targets, leanPath, output, inspect? }
//   { tool: "export", project, targets, leanPath, exports: [{ module, output }…] }
//     containers A2 and B: the toolchain's own `leanexport <module> --
//     <targets…>` — A2 over A1's build tree mounted *read-only*, B over the
//     proof package's capture alone (`<ProofsRoot>`; `project` is then only
//     the working directory) — over a LEAN_PATH the phase composed (the
//     project's build tree, the captures, the warm store — never `lake
//     env`), its stdout streamed to
//     `output`; with `inspect: { report }` (A2) the inspector then reads the
//     built module over the same LEAN_PATH and writes its report there, for
//     the host to hold each certificate theorem's elaborated type to the
//     recorded telescope (certify/challenge-check.ts). Neither tool runs
//     candidate code: `leanexport` imports with `loadExts := false`
//     (LeanExport.lean:16, `importModules imports {}`; Environment.lean:2404
//     finalizes extensions only under that flag) and so does the inspector.
//     `/out` is the only writable mount, and nothing that ran in A1 is
//     alive here — which is what makes the export bytes the tool's and not
//     a lingering build process's (fable review 2026-10-04, finding 1.1).
//     One rule for both exports, so the judge compares two files made the
//     same way. The `exports` form writes several modules' exports in one
//     container with the same targets and LEAN_PATH (the judge self-test's
//     three, certify/self-test.ts).
//   { tool: "probe", project, shims, absent: [paths…], leanchecker, report }
//     the judge self-test's confinement probe, in the judge runtime: writes
//     to `report` whether every `absent` path is invisible (canaries the
//     host wrote outside the mounts), whether `/proc/net/dev` lists no
//     interface but `lo`, what `leanchecker` resolves to on the judge's
//     PATH (shims, then the toolchain — the comparator's own PATH), and
//     whether `project` and the toolchain's bin refuse a write. It judges
//     nothing itself: the host reads the report and names the probe that
//     failed. Exit 0 whenever the report was written.
//   { tool: "comparator", project, config, challengeExport, solutionExport, shims, paranoid }
//     container C, the judge: `lake comparator --config <config>
//     --challenge-from-export <challengeExport> --solution-from-export
//     <solutionExport> --inadvisably-no-sandbox [--paranoid]` in the
//     bundle's project. With both exports supplied the comparator builds and
//     resolves nothing (Lake/CLI/Check.lean runComparator); the container is
//     the sandbox and the comparator's own bubblewrap is off. Its exit code
//     is this process's exit code, and its transcript is passed through for
//     the phase's verdict parser.
//
// Exit codes: the tool's own, passed through; 2 when this script refuses the
// plan or a tool could not start; 3 when a tool was terminated by a signal —
// a crash, an OOM kill inside the container, a kernel panic — which the
// host reads as infrastructure, never as a finding against the author
// (fable review, finding 1.5). No tool here exits 3 on its own.
//
// `lake comparator` probes PATH for `git` and `env` with `which` before it
// does anything, sandbox or not (Check.lean mkContext), and resolves every
// kernel through `which` too (runExternalKernel). The stock image has no
// git, so the host prepares a read-only `shims` directory holding a `git`
// that fails loudly and the judge puts it first on PATH. Nothing on that
// PATH is writable — the shim mount, the toolchain, and the image's own
// directories are all read-only — which is what keeps a planted `which` out
// of the judge: the review's finding 1 was a writable shim directory the
// Solution build could reach.
//
// `toolchainBin`, `inspector`, and `home` in the plan default to the
// container's stable mount points (RUNTIME_PATHS in ../../config.ts — this
// script runs inside the container and cannot import it; keep them in step)
// so the host-side rehearsal of the layout can run the very same script
// with host paths.
//
// LEAN_NUM_THREADS is required, fail-closed, as in run-check.mjs.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [planPath] = process.argv.slice(2);
if (planPath === undefined || !path.isAbsolute(planPath)) process.exit(2);
const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
if (!plan || typeof plan.project !== "string" || !path.isAbsolute(plan.project)) process.exit(2);
const leanNumThreads = process.env.LEAN_NUM_THREADS;
if (leanNumThreads === undefined || !/^[1-9][0-9]*$/u.test(leanNumThreads)) process.exit(2);

const toolchainBin = typeof plan.toolchainBin === "string" ? plan.toolchainBin : "/opt/lax/toolchain/bin";
const inspector = typeof plan.inspector === "string" ? plan.inspector : "/opt/lax/inspector/laxinspector";
const home = typeof plan.home === "string" ? plan.home : "/tmp/lax-certify-home";
fs.mkdirSync(home, { recursive: true });
const baseEnv = {
  HOME: home,
  LEAN_NUM_THREADS: leanNumThreads,
  // never against the read-only warm mount (host/warmstore.ts)
  LAKE_ARTIFACT_CACHE: "false",
  LEAN_ABORT_ON_PANIC: "1",
};

/** Run a child with our stdio, its output passed through for the verdict. */
function run(cmd, args, env, stdout = "inherit") {
  const result = spawnSync(cmd, args, {
    cwd: plan.project,
    env,
    stdio: ["ignore", stdout, "inherit"],
  });
  if (result.error) {
    process.stderr.write(`${plan.tool}: ${cmd} failed to start: ${result.error.message}\n`);
    return 2;
  }
  if (result.signal) {
    process.stderr.write(`${plan.tool}: ${cmd} terminated by ${result.signal}\n`);
    return 3;
  }
  return result.status ?? 1;
}

if (plan.tool === "build") {
  if (typeof plan.module !== "string") process.exit(2);
  const lakeEnv = { ...baseEnv, PATH: `${toolchainBin}:${process.env.PATH ?? "/usr/bin:/bin"}` };
  process.exit(run(path.join(toolchainBin, "lake"), ["build", plan.module], lakeEnv));
}

if (plan.tool === "export") {
  const exports = Array.isArray(plan.exports)
    ? plan.exports
    : typeof plan.module === "string" && typeof plan.output === "string"
      ? [{ module: plan.module, output: plan.output }]
      : undefined;
  if (
    exports === undefined ||
    exports.length === 0 ||
    !exports.every((entry) => entry && typeof entry.module === "string" && typeof entry.output === "string") ||
    !Array.isArray(plan.targets) ||
    !Array.isArray(plan.leanPath)
  ) process.exit(2);
  if (plan.inspect !== undefined && (typeof plan.inspect !== "object" || plan.inspect === null || typeof plan.inspect.report !== "string"))
    process.exit(2);
  if (plan.inspect !== undefined && exports.length !== 1) process.exit(2);
  const leanEnv = {
    ...baseEnv,
    PATH: `${toolchainBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    LEAN_PATH: plan.leanPath.join(path.delimiter),
  };
  for (const entry of exports) {
    const output = fs.openSync(entry.output, "w");
    let exported;
    try {
      exported = run(path.join(toolchainBin, "leanexport"), [entry.module, "--", ...plan.targets], leanEnv, output);
    } finally {
      fs.closeSync(output);
    }
    if (exported !== 0) process.exit(exported);
  }
  if (plan.inspect !== undefined) {
    // the inspector's own argument shape (phases/inspect-runner.ts
    // inspectorArguments): the spec, the report, the module list — here the
    // one generated module, which is its own root
    process.exit(run(inspector, ["--spec", "2", plan.inspect.report, exports[0].module], leanEnv));
  }
  process.exit(0);
}

if (plan.tool === "probe") {
  if (
    typeof plan.shims !== "string" ||
    !path.isAbsolute(plan.shims) ||
    !Array.isArray(plan.absent) ||
    !plan.absent.every((entry) => typeof entry === "string" && path.isAbsolute(entry)) ||
    typeof plan.leanchecker !== "string" ||
    typeof plan.report !== "string"
  ) process.exit(2);
  const canaryInvisible = plan.absent.every((entry) => !fs.existsSync(entry));
  let networkAbsent = false;
  try {
    // `/proc/net/dev`: a header of two lines, then one line per interface,
    // `  <name>: <counters…>`
    const interfaces = fs
      .readFileSync("/proc/net/dev", "utf8")
      .split("\n")
      .slice(2)
      .map((line) => line.split(":")[0]?.trim())
      .filter((name) => name !== undefined && name !== "");
    networkAbsent = interfaces.length > 0 && interfaces.every((name) => name === "lo");
  } catch {
    networkAbsent = false;
  }
  // the comparator's own PATH (see the comparator tool), resolved the way
  // `which` resolves it: the first directory holding an executable
  let leancheckerResolves = null;
  for (const dir of [plan.shims, toolchainBin, ...(process.env.PATH ?? "/usr/bin:/bin").split(path.delimiter)]) {
    const candidate = path.join(dir, "leanchecker");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) {
        leancheckerResolves = candidate;
        break;
      }
    } catch {
      // not here
    }
  }
  const refusesWrite = (dir) => {
    const probe = path.join(dir, `.lax-probe-${process.pid}`);
    try {
      fs.writeFileSync(probe, "probe\n");
    } catch {
      return true;
    }
    try {
      fs.rmSync(probe, { force: true });
    } catch {
      // a write that succeeded is the finding; leave the file to the host's cleanup
    }
    return false;
  };
  const report = {
    canaryInvisible,
    networkAbsent,
    leancheckerResolves,
    projectReadOnly: refusesWrite(plan.project),
    toolchainReadOnly: refusesWrite(toolchainBin),
  };
  fs.writeFileSync(plan.report, `${JSON.stringify(report)}\n`);
  process.exit(0);
}

if (plan.tool === "comparator") {
  if (
    typeof plan.config !== "string" ||
    typeof plan.challengeExport !== "string" ||
    typeof plan.solutionExport !== "string" ||
    typeof plan.shims !== "string" ||
    !path.isAbsolute(plan.shims)
  ) process.exit(2);
  // the shim is the host's, read-only; this tool writes nothing on PATH
  try {
    fs.accessSync(path.join(plan.shims, "git"), fs.constants.X_OK);
  } catch {
    process.stderr.write(`comparator: no executable git shim at ${plan.shims}\n`);
    process.exit(2);
  }
  const code = run(
    path.join(toolchainBin, "lake"),
    [
      "comparator",
      "--config", plan.config,
      "--challenge-from-export", plan.challengeExport,
      "--solution-from-export", plan.solutionExport,
      "--inadvisably-no-sandbox",
      ...(plan.paranoid === true ? ["--paranoid"] : []),
    ],
    { ...baseEnv, PATH: `${plan.shims}:${toolchainBin}:${process.env.PATH ?? "/usr/bin:/bin"}` },
  );
  process.exit(code);
}

process.exit(2);
