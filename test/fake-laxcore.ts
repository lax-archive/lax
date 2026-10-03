// A local git repository holding LaxCore — the fixture copy of
// lax-archive/lax-core's one module (test/fixtures/laxcore/) — the LaxCore pin
// of the fast tests. Together with LAX_LAXCORE_URL/LAX_LAXCORE_REV (see
// src/submission-validation/pins.ts) it lets a spec-2 fake environment
// provision its whole library set through the real warm-store machinery, the
// way fake-mathlib.ts does for mathlib. Shared machine-wide under the test
// cache (see paths.ts); keyed by the fixture files' hash, so an edit of the
// fixture is a new repository rather than a stale one.
//
// Built under the spec-2 rehearsal toolchain (paths.ts SPEC2_TOOLCHAIN): the
// `lean-toolchain` written here is informational only — lake reads the root
// workspace's — but it records what the fixture was meant for.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SPEC2_TOOLCHAIN, TEST_CACHE } from "./paths.js";

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "laxcore");
const FILES = ["LaxCore.lean", "lakefile.toml"] as const;

/** Where the fixture repository lives: the shared cache, keyed by content. */
export function fakeLaxCoreFixture(): string {
  const hash = createHash("sha256");
  hash.update(SPEC2_TOOLCHAIN);
  for (const name of FILES) hash.update(fs.readFileSync(path.join(SOURCE, name)));
  return path.join(TEST_CACHE, `fake-laxcore-${hash.digest("hex").slice(0, 12)}`);
}

export function fakeLaxCore(): { url: string; rev: string } {
  const fixture = fakeLaxCoreFixture();
  if (!fs.existsSync(path.join(fixture, ".git"))) {
    // built beside the fixture, not in os.tmpdir(): the final rename must
    // stay within one filesystem (the cache root need not share /tmp's)
    fs.mkdirSync(path.dirname(fixture), { recursive: true });
    const tmp = fs.mkdtempSync(fixture + "-build-");
    for (const name of FILES) fs.copyFileSync(path.join(SOURCE, name), path.join(tmp, name));
    fs.writeFileSync(path.join(tmp, "lean-toolchain"), `${SPEC2_TOOLCHAIN}\n`);
    const git = (...args: string[]): Buffer =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
        cwd: tmp,
        stdio: ["ignore", "pipe", "pipe"],
        // fixed dates, so the commit — and every warm store keyed by it — is
        // the same on every machine that holds these fixture bytes
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2026-10-03T00:00:00Z",
          GIT_COMMITTER_DATE: "2026-10-03T00:00:00Z",
        },
      });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "fake LaxCore");
    try {
      fs.renameSync(tmp, fixture);
    } catch {
      fs.rmSync(tmp, { recursive: true, force: true }); // another fork won the race
    }
  }
  const rev = execFileSync("git", ["-C", fixture, "rev-parse", "HEAD"]).toString().trim();
  return { url: "file://" + fixture, rev };
}
