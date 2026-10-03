// Runs one of Certify's three steps (axiomfree-plan.md, "Certify" 2–3;
// certify/phase.ts) inside the sandbox, from a plan the phase wrote:
//
//   { tool: "export", project, module, targets, leanPath, output }
//     containers A and B: `lake build <module>` in the generated project
//     (`Challenge` over the concept packages, `Solution` over the proof
//     package too), then the toolchain's own `leanexport <module> --
//     <targets…>` over a LEAN_PATH the phase composed (the project's build
//     tree, the captures, the warm store — never `lake env`), its stdout
//     streamed to `output`. One rule for both exports, so the judge compares
//     two files made the same way.
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
// `toolchainBin` and `home` in the plan default to the container's stable
// mount points (RUNTIME_PATHS in ../../config.ts — this script runs inside
// the container and cannot import it; keep them in step) so the host-side
// rehearsal of the layout can run the very same script with host paths.
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
    return 1;
  }
  return result.status ?? 1;
}

if (plan.tool === "export") {
  if (
    typeof plan.module !== "string" ||
    !Array.isArray(plan.targets) ||
    !Array.isArray(plan.leanPath) ||
    typeof plan.output !== "string"
  ) process.exit(2);
  const lakeEnv = { ...baseEnv, PATH: `${toolchainBin}:${process.env.PATH ?? "/usr/bin:/bin"}` };
  const built = run(path.join(toolchainBin, "lake"), ["build", plan.module], lakeEnv);
  if (built !== 0) process.exit(built);
  const output = fs.openSync(plan.output, "w");
  try {
    const exported = run(
      path.join(toolchainBin, "leanexport"),
      [plan.module, "--", ...plan.targets],
      { ...lakeEnv, LEAN_PATH: plan.leanPath.join(path.delimiter) },
      output,
    );
    process.exit(exported);
  } finally {
    fs.closeSync(output);
  }
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
