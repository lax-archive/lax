import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doctor } from "../../src/cli/doctor.js";
import { recordSubmission } from "../../src/cli/registry.js";
import { LEAN_TOOLCHAIN, MATHLIB_REV } from "../../src/submission-validation/pins.js";
import { warmDir } from "../../src/submission-validation/host/warmstore.js";

const previous = {
  home: process.env.LAX_HOME,
  token: process.env.LAX_GITHUB_APP_USER_TOKEN,
  database: process.env.LAX_DATABASE_URL,
  elan: process.env.ELAN_HOME,
};
let home: string;
const seeded: string[] = [];

beforeEach(() => {
  // An empty LAX_HOME keeps every check offline: no credentials, so github
  // auth fails before any request. The database check now *updates* the
  // checkout, so it needs a remote too — a path that does not exist makes the
  // clone fail locally and at once instead of reaching for real lax-database.
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lax-doctor-"));
  process.env.LAX_HOME = home;
  process.env.LAX_DATABASE_URL = path.join(home, "no-such-remote.git");
  // The lake check installs the pinned toolchain when it is missing, so the
  // suite must never see the real ~/.elan: an empty one has no elan to run,
  // which is exactly the "nothing to install with" branch. The test that does
  // exercise the install seeds a fake elan into this directory.
  process.env.ELAN_HOME = path.join(home, "elan");
  delete process.env.LAX_GITHUB_APP_USER_TOKEN;
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
  for (const root of seeded.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (previous.home === undefined) delete process.env.LAX_HOME;
  else process.env.LAX_HOME = previous.home;
  if (previous.database === undefined) delete process.env.LAX_DATABASE_URL;
  else process.env.LAX_DATABASE_URL = previous.database;
  if (previous.elan === undefined) delete process.env.ELAN_HOME;
  else process.env.ELAN_HOME = previous.elan;
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
  it("prints the leading checks before the slow probes have answered", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const pending = doctor();
    // The instant checks are on screen before anything is awaited: the
    // buffered version printed nothing until every check had finished
    // (~60 s worst case, more with an elan install in it).
    const immediate = log.mock.calls.map(([line]) => String(line));
    expect(immediate[0]).toContain("platform:");
    expect(immediate.some((line) => line.includes("node:"))).toBe(true);
    // The report order is fixed, so a check that has already answered still
    // waits behind a running one — until then it lives in the spinner block,
    // which does not go through console.log.
    expect(immediate.some((line) => line.includes("website renderer:"))).toBe(false);

    await pending;
    const all = log.mock.calls.map(([line]) => String(line));
    expect(all.length).toBeGreaterThan(immediate.length);
    // The detail is the authentication failure itself, so a refresh GitHub
    // answered with a 500 does not get reported as a missing login.
    expect(all.some((line) => line.includes("github auth: no GitHub App login found"))).toBe(true);
    expect(all.some((line) => line.includes("      → run `lax login`"))).toBe(true);
    expect(all.some((line) => line.includes("database clone:"))).toBe(true);
    expect(all.some((line) => line.includes("website renderer:"))).toBe(true);
  });

  it("keeps the report in declaration order though the checks race", async () => {
    // `github auth` fails offline almost at once while `lake --version` can
    // take minutes; the report must not reorder itself around that.
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await doctor();

    const lines = log.mock.calls.map(([line]) => String(line));
    const order = [
      "platform",
      "node",
      "git",
      "npm",
      "elan",
      "lake",
      "github auth",
      "database clone",
      "lean toolchain",
      "mathlib store",
      "website renderer",
      "disk",
    ];
    const positions = order
      .map((name) => lines.findIndex((line) => line.startsWith(`  `) && line.includes(`${name}: `)))
      // `disk` is best-effort and reports nothing on a mount it cannot stat.
      .filter((index) => index >= 0);
    expect(positions.length).toBeGreaterThan(8);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
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

  it("installs the pinned toolchain and reports its lake, never elan's default", async () => {
    // The bug this pins: a bare `lake --version` goes through elan's shim,
    // which resolves `elan default` (stable) and downloads *that* toolchain —
    // green-ticking a lake no lax build uses while the pinned one stays
    // missing. The probe must name the pin and read the binary it installed.
    const elanRoot = path.join(home, "elan");
    const toolchain = LEAN_TOOLCHAIN.replace("/", "--").replace(":", "---");
    const installed = path.join(elanRoot, "toolchains", toolchain, "bin");
    const log = path.join(home, "elan-args");
    fs.mkdirSync(path.join(elanRoot, "bin"), { recursive: true });
    // A fake elan that records what it was asked to install and produces the
    // toolchain that request implies — no network, no real download.
    fs.writeFileSync(
      path.join(elanRoot, "bin", "elan"),
      `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\n` +
        `mkdir -p ${JSON.stringify(installed)}\n` +
        `touch ${JSON.stringify(path.join(installed, "lean"))}\n` +
        `printf '#!/bin/sh\\necho "Lake version 5.0.0 (Lean version 4.30.0)"\\n' > ${JSON.stringify(path.join(installed, "lake"))}\n` +
        `chmod +x ${JSON.stringify(path.join(installed, "lake"))}\n`,
      { mode: 0o755 },
    );

    const printed = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await doctor();

    expect(fs.readFileSync(log, "utf8").trim()).toBe(`toolchain install ${LEAN_TOOLCHAIN}`);
    const lake = printed.mock.calls.map(([line]) => String(line)).find((line) => line.includes(" lake: "))!;
    expect(lake).toContain("Lean version 4.30.0");
    expect(lake).toContain("✓");
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
