import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doctor } from "../../src/cli/doctor.js";
import { recordSubmission } from "../../src/cli/registry.js";
import { ELAN_COMMIT, LEAN_TOOLCHAIN, MATHLIB_REV } from "../../src/submission-validation/pins.js";
import { warmDir, warmReady } from "../../src/submission-validation/host/warmstore.js";

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
  // The elan check now *installs* elan, so an unstubbed run would fetch the
  // pinned bootstrap script and unpack a real elan into that temp ELAN_HOME.
  // Offline by default; the two tests that exercise the install say so.
  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  removeTree(home);
  for (const root of seeded.splice(0)) removeTree(root);
  if (previous.home === undefined) delete process.env.LAX_HOME;
  else process.env.LAX_HOME = previous.home;
  if (previous.database === undefined) delete process.env.LAX_DATABASE_URL;
  else process.env.LAX_DATABASE_URL = previous.database;
  if (previous.elan === undefined) delete process.env.ELAN_HOME;
  else process.env.ELAN_HOME = previous.elan;
  if (previous.token !== undefined) process.env.LAX_GITHUB_APP_USER_TOKEN = previous.token;
});

/**
 * Remove a temp tree that may hold a sealed warm store: the seal strips write
 * permission from directories too, and rm needs it back before it can unlink
 * what is inside them.
 */
function removeTree(root: string): void {
  if (fs.existsSync(root)) {
    fs.chmodSync(root, 0o700);
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) removeTree(path.join(root, entry.name));
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
}

/** A warm store doctor reads as ready, for the tests that are about some
 * other link in the Lean chain: without one, the store check behind them
 * starts a build of its own. */
function seedWarmStore(): void {
  const ws = warmDir();
  fs.mkdirSync(path.join(ws, ".lake", "packages"), { recursive: true });
  fs.writeFileSync(path.join(ws, "lake-manifest.json"), '{"packages":[]}\n');
  fs.writeFileSync(path.join(ws, ".lax-warm-ok"), "");
}

function writeOverrides(pkg: string, packages: Array<{ name: string; dir: string }>): void {
  fs.mkdirSync(path.join(pkg, ".lake"), { recursive: true });
  fs.writeFileSync(
    path.join(pkg, ".lake", "package-overrides.json"),
    JSON.stringify({ version: "1.2.0", packages }, null, 1),
  );
}

/** A submission that passes every check but the ones a test then breaks. */
function seedSubmission(): string {
  seedWarmStore();
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
    seedWarmStore();
    fs.mkdirSync(path.join(elanRoot, "bin"), { recursive: true });
    // A fake elan that records what it was asked to install and produces the
    // toolchain that request implies — no network, no real download. It answers
    // `--version` without installing anything, as the real one does: the elan
    // check probes with it before the lake check asks for the toolchain.
    fs.writeFileSync(
      path.join(elanRoot, "bin", "elan"),
      `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\n` +
        `case "$1" in --version) echo "elan 4.0.0"; exit 0 ;; esac\n` +
        `mkdir -p ${JSON.stringify(installed)}\n` +
        `touch ${JSON.stringify(path.join(installed, "lean"))}\n` +
        `printf '#!/bin/sh\\necho "Lake version 5.0.0 (Lean version 4.30.0)"\\n' > ${JSON.stringify(path.join(installed, "lake"))}\n` +
        `chmod +x ${JSON.stringify(path.join(installed, "lake"))}\n`,
      { mode: 0o755 },
    );

    const printed = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await doctor();

    expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "--version",
      `toolchain install ${LEAN_TOOLCHAIN}`,
    ]);
    const lake = printed.mock.calls.map(([line]) => String(line)).find((line) => line.includes(" lake: "))!;
    expect(lake).toContain("Lean version 4.30.0");
    expect(lake).toContain("✓");
  });

  it("installs elan itself when the machine has none, then the toolchain under it", async () => {
    // `npm i -g lax-archive && lax doctor` has to be a complete setup on a bare
    // container: without this the elan row was a ✗ with a link, the lake row a
    // ✗ behind it ("no elan to provide it"), and nothing was provisioned at all.
    const elanRoot = path.join(home, "elan");
    const elanBin = path.join(elanRoot, "bin", "elan");
    const toolchain = LEAN_TOOLCHAIN.replace("/", "--").replace(":", "---");
    const installed = path.join(elanRoot, "toolchains", toolchain, "bin");
    seedWarmStore();
    // The pinned bootstrap script, faked: the real one is fetched from
    // raw.githubusercontent.com at ELAN_COMMIT and run with ELAN_HOME set, so a
    // stub that plants an elan there exercises the whole install path offline.
    const bootstrap =
      `#!/bin/sh\nmkdir -p "$ELAN_HOME/bin"\n` +
      `cat > "$ELAN_HOME/bin/elan" <<'ELAN'\n` +
      `#!/bin/sh\n` +
      `case "$1" in --version) echo "elan 4.0.0"; exit 0 ;; esac\n` +
      `mkdir -p ${JSON.stringify(installed)}\n` +
      `touch ${JSON.stringify(path.join(installed, "lean"))}\n` +
      `printf '#!/bin/sh\\necho "Lake version 5.0.0 (Lean version 4.30.0)"\\n' > ${JSON.stringify(path.join(installed, "lake"))}\n` +
      `chmod +x ${JSON.stringify(path.join(installed, "lake"))}\n` +
      `ELAN\nchmod +x "$ELAN_HOME/bin/elan"\n`;
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(String(url));
      return new Response(bootstrap, { status: 200 });
    });

    const printed = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await doctor();

    expect(fetched[0]).toBe(
      `https://raw.githubusercontent.com/leanprover/elan/${ELAN_COMMIT}/elan-init.sh`,
    );
    expect(fs.existsSync(elanBin)).toBe(true);
    const lines = printed.mock.calls.map(([line]) => String(line));
    const elan = lines.find((line) => line.includes(" elan: "))!;
    expect(elan).toContain("✓");
    expect(elan).toContain("installed just now");
    // and the chain continues: the elan it just installed installs the pin
    expect(lines.find((line) => line.includes(" lake: "))).toContain("Lean version 4.30.0");
  });

  it("--dry reports the same gaps and provisions none of them", async () => {
    // The promise is byte-for-byte: no elan install (hence no bootstrap fetch),
    // no toolchain, no database clone, and no credentials refresh. Everything
    // it declines to do it names instead, and a ✗ still exits 1.
    const fetched: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      fetched.push(String(url));
      return Promise.reject(new Error("offline"));
    });
    const printed = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await doctor({ dry: true });

    const lines = printed.mock.calls.map(([line]) => String(line));
    expect(lines[0]).toContain("--dry");
    expect(lines.find((line) => line.includes(" elan: "))).toContain("✗");
    expect(lines.find((line) => line.includes(" lake: "))).toContain("✗");
    expect(lines.some((line) => line.includes("without --dry"))).toBe(true);
    expect(lines.find((line) => line.includes(" database clone: "))).toContain("none at");
    expect(lines.find((line) => line.includes(" mathlib store: "))).toContain("✗");
    expect(code).toBe(1);
    // and nothing was touched: no bootstrap fetched, no elan, no clone, and
    // above all no gigabyte store build
    expect(fetched).toEqual([]);
    expect(fs.existsSync(path.join(home, "elan", "bin"))).toBe(false);
    expect(fs.existsSync(path.join(home, "lax-database"))).toBe(false);
    expect(fs.existsSync(warmDir())).toBe(false);
  });

  it("--dry still reads a provisioned machine as ready", async () => {
    // The report is the same report: a dry run on a machine that has everything
    // must not invent problems out of the work it skipped.
    seedWarmStore();
    const elanRoot = path.join(home, "elan");
    const toolchain = LEAN_TOOLCHAIN.replace("/", "--").replace(":", "---");
    const installed = path.join(elanRoot, "toolchains", toolchain, "bin");
    fs.mkdirSync(path.join(elanRoot, "bin"), { recursive: true });
    fs.mkdirSync(installed, { recursive: true });
    fs.writeFileSync(
      path.join(elanRoot, "bin", "elan"),
      `#!/bin/sh\necho "elan 4.0.0"\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(installed, "lean"), "");
    fs.writeFileSync(
      path.join(installed, "lake"),
      `#!/bin/sh\necho "Lake version 5.0.0 (Lean version 4.30.0)"\n`,
      { mode: 0o755 },
    );
    fs.mkdirSync(path.join(home, "lax-database", ".git"), { recursive: true });

    const printed = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await doctor({ dry: true });

    const lines = printed.mock.calls.map(([line]) => String(line));
    expect(lines.find((line) => line.includes(" elan: "))).toContain("✓ elan: elan 4.0.0");
    expect(lines.find((line) => line.includes(" lake: "))).toContain("Lean version 4.30.0");
    expect(lines.find((line) => line.includes(" database clone: "))).toContain("not refreshed");
    expect(lines.find((line) => line.includes(" mathlib store: "))).toContain("✓");
  });

  it("builds the warm mathlib store when the machine has none", async () => {
    // The gap that made `npm i -g lax-archive && lax doctor` an incomplete
    // setup: the store was reported as a note and left to the first `lax
    // build`, so doctor exited 0 on a machine that could not build anything.
    const elanRoot = path.join(home, "elan");
    const toolchain = LEAN_TOOLCHAIN.replace("/", "--").replace(":", "---");
    const installed = path.join(elanRoot, "toolchains", toolchain, "bin");
    const lakeLog = path.join(home, "lake-args");
    fs.mkdirSync(path.join(elanRoot, "bin"), { recursive: true });
    fs.mkdirSync(installed, { recursive: true });
    fs.writeFileSync(path.join(elanRoot, "bin", "elan"), `#!/bin/sh\necho "elan 4.0.0"\n`, {
      mode: 0o755,
    });
    fs.writeFileSync(path.join(installed, "lean"), "");
    // The pinned toolchain's own lake, faked: it records its arguments and
    // leaves behind what a real `lake build` of the warm workspace leaves —
    // the locked manifest and the package checkouts `warmReady` looks for. It
    // writes them relative to its cwd, which is the store being built.
    fs.writeFileSync(
      path.join(installed, "lake"),
      `#!/bin/sh\necho "$@" >> ${JSON.stringify(lakeLog)}\n` +
        `case "$1" in --version) echo "Lake version 5.0.0 (Lean version 4.30.0)"; exit 0 ;; esac\n` +
        `mkdir -p .lake/packages/mathlib\n` +
        `printf '{"packages":[]}\\n' > lake-manifest.json\n`,
      { mode: 0o755 },
    );

    const printed = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await doctor();

    // It ran the pinned toolchain's lake, not whatever `lake` PATH offers —
    // elan is installed with --no-modify-path, so a bare lookup finds either
    // nothing or another elan's shim resolving an unpinned toolchain.
    expect(fs.readFileSync(lakeLog, "utf8")).toContain("build");
    const store = printed.mock.calls
      .map(([line]) => String(line))
      .find((line) => line.includes(" mathlib store: "))!;
    expect(store).toContain("✓");
    expect(store).toContain("built just now");
    // and the store is left in the state every consumer relies on: complete,
    // marked, and sealed against writes
    expect(warmReady(warmDir())).toBe(true);
    expect(fs.statSync(warmDir()).mode & 0o200).toBe(0);
  });

  it("names the missing toolchain instead of downloading gigabytes without one", async () => {
    // The store check runs last in the Lean chain, so on a machine where elan
    // never arrived there is no lake to build with. It must not spend the
    // download to find that out — the lake row above already carries the fix.
    const printed = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await doctor();

    const store = printed.mock.calls
      .map(([line]) => String(line))
      .find((line) => line.includes(" mathlib store: "))!;
    expect(store).toContain("✗");
    expect(store).toContain(`no ${LEAN_TOOLCHAIN} to build it with`);
    expect(fs.existsSync(warmDir())).toBe(false);
  });

  it("reports the reason when the elan bootstrap cannot be fetched", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));
    const printed = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await doctor();

    const lines = printed.mock.calls.map(([line]) => String(line));
    const elan = lines.find((line) => line.includes(" elan: "))!;
    expect(elan).toContain("✗");
    expect(elan).toContain("HTTP 404");
    expect(lines.some((line) => line.includes("get_started"))).toBe(true);
    expect(code).toBe(1);
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
