import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doctor } from "../../src/cli/doctor.js";
import { recordSubmission } from "../../src/cli/registry.js";
import { LEAN_TOOLCHAIN, MATHLIB_REV } from "../../src/submission-validation/pins.js";
import { warmDir } from "../../src/submission-validation/host/warmstore.js";

const previous = { home: process.env.LAX_HOME, token: process.env.LAX_GITHUB_APP_USER_TOKEN };
let home: string;
const seeded: string[] = [];

beforeEach(() => {
  // An empty LAX_HOME keeps every check offline: no credentials (github auth
  // fails before any request), no database clone (no `git ls-remote`).
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lax-doctor-"));
  process.env.LAX_HOME = home;
  delete process.env.LAX_GITHUB_APP_USER_TOKEN;
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
  for (const root of seeded.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (previous.home === undefined) delete process.env.LAX_HOME;
  else process.env.LAX_HOME = previous.home;
  if (previous.token !== undefined) process.env.LAX_GITHUB_APP_USER_TOKEN = previous.token;
});

function writeOverrides(pkg: string, packages: Array<{ name: string; dir: string }>): void {
  fs.mkdirSync(path.join(pkg, ".lake"), { recursive: true });
  fs.writeFileSync(
    path.join(pkg, ".lake", "package-overrides.json"),
    JSON.stringify({ version: "1.2.0", packages }, null, 1),
  );
}

/** A submission that passes every check but the ones a test then breaks. */
function seedSubmission(): string {
  fs.mkdirSync(path.join(warmDir(), ".lake", "packages", "mathlib"), { recursive: true });
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "lax-submission-"));
  seeded.push(parent);
  const root = path.join(parent, "lax-9");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "manifest.yaml"), 'id: lax-9\ntitle: Nine\n');
  for (const kind of ["concepts", "proofs"]) {
    const pkg = path.join(root, kind);
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "lakefile.toml"), `rev = "${MATHLIB_REV}"\n`);
    fs.writeFileSync(path.join(pkg, "lean-toolchain"), `${LEAN_TOOLCHAIN}\n`);
    writeOverrides(pkg, []);
  }
  return root;
}

describe("lax doctor", () => {
  it("prints each check as it completes instead of buffering the whole report", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const pending = doctor();
    // Everything up to the first awaited probe is already on screen: the
    // buffered version printed nothing until all checks had finished (~60 s
    // worst case).
    const immediate = log.mock.calls.map(([line]) => String(line));
    expect(immediate[0]).toContain("platform:");
    expect(immediate.some((line) => line.includes("lake:"))).toBe(true);
    expect(immediate.some((line) => line.includes("github auth:"))).toBe(false);

    await pending;
    const all = log.mock.calls.map(([line]) => String(line));
    expect(all.length).toBeGreaterThan(immediate.length);
    // The detail is the authentication failure itself, so a refresh GitHub
    // answered with a 500 does not get reported as a missing login.
    expect(all.some((line) => line.includes("github auth: no GitHub App login found"))).toBe(true);
    expect(all.some((line) => line.includes("      → run `lax login`"))).toBe(true);
    expect(all.some((line) => line.includes("database clone:"))).toBe(true);
  });

  it("resolves a relative override dir against its package, and names a dead one", async () => {
    // Lake reads a relative dir as package-relative; probing it against the
    // process cwd used to report every hand-added sibling redirect as a
    // missing mathlib store — with `..` as the store, and `lax build` (which
    // drops the entry) as the fix.
    const root = seedSubmission();
    const sibling = path.join(root, "..", "next-door", "concepts");
    fs.mkdirSync(sibling, { recursive: true });
    writeOverrides(path.join(root, "concepts"), [
      { name: "mathlib", dir: path.join(warmDir(), ".lake", "packages", "mathlib") },
      { name: "Lax9", dir: "../../next-door/concepts" },
    ]);
    writeOverrides(path.join(root, "proofs"), [
      { name: "Lax9", dir: "../../nowhere/concepts" },
    ]);
    recordSubmission(root);

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await doctor();
    const line = log.mock.calls
      .map(([entry]) => String(entry))
      .find((entry) => entry.includes("submission lax-9"))!;

    expect(line).not.toContain("missing mathlib store");
    expect(line).toContain(`Lax9 → ${path.join(root, "..", "nowhere", "concepts")}`);
  });

  it("keeps the check line format (mark, name, detail, indented fix)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await doctor();

    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines.some((line) => /^ {2}[✓!✗] [a-z ]+: /u.test(line))).toBe(true);
    for (const line of lines) {
      if (line.startsWith("      → ")) continue;
      if (line.startsWith("lax doctor: ")) continue;
      expect(line).toMatch(/^ {2}[✓!✗] /u);
    }
  });
});
