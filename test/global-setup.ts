// Runs once per vitest invocation, before the workers fork: build the shared
// warm workspace against the fake mathlib so the parallel forks all find it
// ready (concurrent warm builds of one workspace would race). The inspector
// is pre-built into the shared tools dir for the same reason: after an
// inspector source change, its cache key is new and the forks would race
// `lake build` in one directory. Only the epoch's store is pre-built; a test
// that injects an environment of its own through LAX_TEST_ENVIRONMENTS
// provisions it itself.
import fs from "node:fs";
import { epoch } from "../src/submission-validation/environments.js";
import { inspectorBinary } from "../src/submission-validation/host/inspector.js";
import {
  buildWarmWorkspace,
  makeStoreReadOnly,
  markWarmReady,
  warmDir,
  warmReady,
} from "../src/submission-validation/host/warmstore.js";
import { fakeMathlib } from "./fake-mathlib.js";
import { putToolchainOnPath, SHARED_TOOLS, sharedWarmBase } from "./paths.js";

export default async function setup(): Promise<void> {
  if (process.env.LAX_E2E === "1") return;
  const { url, rev } = fakeMathlib();
  process.env.LAX_MATHLIB_URL = url;
  process.env.LAX_MATHLIB_REV = rev;
  putToolchainOnPath();
  const environment = epoch();
  await inspectorBinary(environment, {}, SHARED_TOOLS);
  const ws = warmDir(environment, sharedWarmBase());
  if (warmReady(ws)) {
    // a cached store sealed before directories joined the read-only pass
    // (the hardlink-farm era) is upgraded in place, like ensureLocalWarm does
    if ((fs.statSync(ws).mode & 0o200) !== 0) makeStoreReadOnly(ws);
    return;
  }
  if (!(await buildWarmWorkspace(environment, ws, { echo: false })))
    throw new Error("global setup: warm build against the fake mathlib failed");
  makeStoreReadOnly(ws);
  markWarmReady(ws);
}
