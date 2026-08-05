// The host-side sources of the sandbox's runtime mounts. The deleted custom
// image baked elan, the toolchain, warm mathlib, and the helper scripts into
// its filesystem; now the same content lives on the VM/host — installed by
// host/setup.ts (trusted workflow) or by an earlier local `lax build` — and
// ContainerRunner bind-mounts it read-only at the stable RUNTIME_PATHS.
//
// This module only *verifies* the expensive state (toolchain, warm store) and
// fails with a pointer at the setup entry: silently kicking off a multi-GB
// mathlib download inside a validation run is exactly the kind of hidden wait
// the rework bans. The inspector is the one exception — its sources ship with
// the repository and build in seconds, so it is ensured in place.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectorBinary } from "../host/inspector.js";
import { toolchainDir } from "../host/leanenv.js";
import { warmDir, warmReady } from "../host/warmstore.js";
import { LEAN_TOOLCHAIN } from "../pins.js";

export interface RuntimeLayout {
  /** the pinned toolchain (bin/lean, bin/lake, bin/leanchecker, lib/...) */
  toolchainDir: string;
  /** the sealed warm mathlib workspace */
  warmDir: string;
  /** directory of the in-container helper scripts (sandbox/tools/*.mjs) */
  toolsDir: string;
  /** the built laxinspector executable */
  inspectorBin: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
// The helper scripts ship as source .mjs files. Compiled TS runs from dist/,
// which carries no .mjs, so fall back through the repository root (the same
// pattern host/inspector.ts uses for the inspector's .lean sources).
const TOOLS_CANDIDATES = [
  path.resolve(here, "tools"),
  path.resolve(here, "..", "..", "..", "src", "submission-validation", "sandbox", "tools"),
];

export function sandboxToolsDir(): string {
  const dir = TOOLS_CANDIDATES.find((candidate) =>
    fs.existsSync(path.join(candidate, "run-check.mjs")),
  );
  if (dir === undefined) throw new Error("the sandbox helper scripts are missing from this installation");
  return dir;
}

/**
 * Resolve (and minimally ensure) the host state the sandbox mounts. Throws a
 * clear, actionable error when the VM setup has not run. Paths are
 * realpath'd: test homes symlink the warm base into a shared cache, and bind
 * mount sources should be canonical.
 */
export async function ensureRuntimeLayout(): Promise<RuntimeLayout> {
  const toolchain = toolchainDir();
  for (const binary of ["lean", "lake", "leanchecker"]) {
    if (!fs.existsSync(path.join(toolchain, "bin", binary))) {
      throw new Error(
        `the pinned Lean toolchain ${LEAN_TOOLCHAIN} is not installed at ${toolchain}; ` +
          "run the validation host setup (dist/submission-validation/host/setup-vm.js) first",
      );
    }
  }
  const warm = warmDir();
  if (!warmReady(warm)) {
    throw new Error(
      `the warm mathlib workspace is not ready at ${warm}; ` +
        "run the validation host setup (dist/submission-validation/host/setup-vm.js) first",
    );
  }
  const inspectorBin = await inspectorBinary();
  return {
    toolchainDir: fs.realpathSync(toolchain),
    warmDir: fs.realpathSync(warm),
    toolsDir: fs.realpathSync(sandboxToolsDir()),
    inspectorBin: fs.realpathSync(inspectorBin),
  };
}
