#!/usr/bin/env node
// Install pinned elan and one Lean toolchain, and nothing else.
//
//   node scripts/environments/install-toolchain.mjs leanprover/lean4:v4.30.0
//
// `ensureValidationHost` (host/setup.ts) provisions a whole validation host —
// toolchain, 7.5 GB warm mathlib workspace, inspector. The inspector-matrix
// job and the admission workflow's test legs build the inspector and run the
// golden test, neither of which touches mathlib, so they take this path
// instead. elan itself is installed by the same pinned installer the CLI and
// `lax doctor` use; only the mathlib half is skipped.
//
// Needs `npm run build`: `installElan` is TypeScript.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { REPOSITORY_ROOT } from "./table.mjs";

const TOOLCHAIN_PATTERN = /^leanprover\/lean4:v[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/u;

const toolchain = process.argv[2];
// The argument reaches this script from a workflow matrix and, in the
// admission workflow, from a `workflow_dispatch` input: it is untrusted until
// it has been shaped, and it becomes an argv entry of a child process.
if (toolchain === undefined || !TOOLCHAIN_PATTERN.test(toolchain)) {
  console.error("usage: install-toolchain.mjs leanprover/lean4:vX.Y.Z");
  process.exit(2);
}

const dist = path.join(REPOSITORY_ROOT, "dist", "submission-validation", "host");
const { installElan } = await import(path.join(dist, "setup.js"));
const { elanHome, toolchainBinDir } = await import(path.join(dist, "leanenv.js"));

const elanBin = path.join(elanHome(), "bin", "elan");
if (fs.existsSync(elanBin)) {
  console.log(`elan present at ${elanBin}`);
} else {
  const installed = await installElan(elanBin);
  if (!installed.ok) {
    console.error(`could not install elan: ${installed.reason}`);
    process.exit(1);
  }
  console.log(`elan installed at ${elanBin}`);
}

// A partial entry on purpose: an admission candidate is not in the table yet,
// and `leanFacts` answers an unknown id with the shared record, which is
// exactly the elan directory mangling wanted here.
const binDir = toolchainBinDir({ leanToolchain: toolchain });
if (fs.existsSync(path.join(binDir, "lean"))) {
  console.log(`${toolchain} present at ${binDir}`);
  process.exit(0);
}

const code = await new Promise((resolve) => {
  const child = spawn(elanBin, ["toolchain", "install", toolchain], {
    cwd: os.homedir(),
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("error", (error) => {
    console.error(`could not run elan: ${error.message}`);
    resolve(1);
  });
  child.on("close", (status) => resolve(status ?? 1));
});
if (code !== 0 || !fs.existsSync(path.join(binDir, "lean"))) {
  console.error(`could not install ${toolchain} (exit ${code})`);
  process.exit(1);
}
console.log(`${toolchain} installed at ${binDir}`);
