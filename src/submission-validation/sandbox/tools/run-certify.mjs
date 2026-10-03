// Runs one half of Certify (axiomfree-plan.md, "Certify" 2–3) inside the
// sandbox, from a plan the phase wrote:
//
//   { tool: "challenge", project, module, targets, leanPath, output }
//     container A: `lake build <module>` in the generated project, then the
//     toolchain's own `leanexport <module> -- <targets…>` over a LEAN_PATH the
//     phase composed (the project's build tree, the concept captures, the
//     warm store — never `lake env`), its stdout streamed to `output`.
//   { tool: "comparator", project, config, challengeExport, paranoid }
//     container B: `lake comparator --config <config> --challenge-from-export
//     <challengeExport> --inadvisably-no-sandbox [--paranoid]` in the
//     generated project. The container is the sandbox; the comparator's own
//     bubblewrap is off. Its exit code is this process's exit code, and its
//     transcript is passed through for the phase's verdict parser.
//
// `toolchainBin` and `home` in the plan default to the container's stable
// mount points (RUNTIME_PATHS in ../../config.ts — this script runs inside
// the container and cannot import it; keep them in step) so the host-side
// rehearsal of the layout can run the very same script with host paths.
//
// LEAN_NUM_THREADS is required, fail-closed, as in run-check.mjs.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

if (plan.tool === "challenge") {
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
  if (typeof plan.config !== "string" || typeof plan.challengeExport !== "string") process.exit(2);
  // `lake comparator` probes PATH for `git` before it does anything, sandbox
  // or not (Lake/CLI/Check.lean mkContext); the stock image has none, and a
  // complete manifest means nothing here may fetch. A shim that fails loudly
  // satisfies the probe and turns any real git call into a failed run.
  const shims = fs.mkdtempSync(path.join(os.tmpdir(), "lax-certify-shims-"));
  const shim = path.join(shims, "git");
  fs.writeFileSync(
    shim,
    '#!/bin/sh\necho "lax: git is not available inside the validation sandbox (invoked as: git $*)" >&2\nexit 1\n',
    { mode: 0o755 },
  );
  const code = run(
    path.join(toolchainBin, "lake"),
    [
      "comparator",
      "--config", plan.config,
      "--challenge-from-export", plan.challengeExport,
      "--inadvisably-no-sandbox",
      ...(plan.paranoid === true ? ["--paranoid"] : []),
    ],
    { ...baseEnv, PATH: `${shims}:${toolchainBin}:${process.env.PATH ?? "/usr/bin:/bin"}` },
  );
  process.exit(code);
}

process.exit(2);
