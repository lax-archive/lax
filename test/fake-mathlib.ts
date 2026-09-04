// A minimal Lake package named `mathlib` in a local git repository — the
// archive pin of the fast tests. Together with LAX_MATHLIB_URL/LAX_MATHLIB_REV
// (see src/submission-validation/pins.ts) it lets every fast test exercise
// the real warm-store, package-overrides, and manifest-seeding machinery without
// downloading gigabytes. Shared machine-wide like the inspector tools dir
// (see paths.ts).
//
// Deliberately dependency-free: it runs from vitest setup files before the
// env seam is set, so it must not import src/ modules (their constants
// freeze the env at import time).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { epoch } from "../src/submission-validation/environments.js";
import { FAKE_MATHLIB_FIXTURE as FIXTURE } from "./paths.js";

// The installed toolchain — the epoch's, which every injected test
// environment shares. Safe to read here: the table is read at call time and
// the toolchain does not depend on the mathlib seam this file is setting up.
const TOOLCHAIN = `${epoch().leanToolchain}\n`;

export function fakeMathlib(): { url: string; rev: string } {
  if (!fs.existsSync(path.join(FIXTURE, ".git"))) {
    // built beside the fixture, not in os.tmpdir(): the final rename must
    // stay within one filesystem (the cache root need not share /tmp's)
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    const tmp = fs.mkdtempSync(FIXTURE + "-build-");
    fs.writeFileSync(
      path.join(tmp, "lakefile.toml"),
      `name = "mathlib"\ndefaultTargets = ["Mathlib"]\n\n[[lean_lib]]\nname = "Mathlib"\n`,
    );
    fs.writeFileSync(path.join(tmp, "lean-toolchain"), TOOLCHAIN);
    fs.writeFileSync(path.join(tmp, "Mathlib.lean"), "def Mathlib.placeholder : Nat := 0\n");
    const git = (...args: string[]): Buffer =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
        cwd: tmp,
        stdio: ["ignore", "pipe", "pipe"],
      });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "fake mathlib");
    try {
      fs.renameSync(tmp, FIXTURE);
    } catch {
      fs.rmSync(tmp, { recursive: true, force: true }); // another fork won the race
    }
  }
  const rev = execFileSync("git", ["-C", FIXTURE, "rev-parse", "HEAD"]).toString().trim();
  return { url: "file://" + FIXTURE, rev };
}
