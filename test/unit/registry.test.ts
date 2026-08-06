// The submission registry and its consumers: `lax init`/`lax build` record
// submission roots, `lax doctor` checks each one's local health, and init's
// provisioning seeds the same generated Lake files a build would write so a
// bare `lake build` straight after init replays the warm store.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doctor } from "../../src/cli/doctor.js";
import { recordSubmission, registeredSubmissions, registryFile } from "../../src/cli/registry.js";
import { provisionScaffold, scaffoldSubmission } from "../../src/cli/scaffold.js";
import { markWarmReady, warmDir } from "../../src/submission-validation/host/warmstore.js";
import { MATHLIB_REV, MATHLIB_URL } from "../../src/submission-validation/pins.js";

const previous = { home: process.env.LAX_HOME, token: process.env.LAX_GITHUB_APP_USER_TOKEN };
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lax-registry-"));
  process.env.LAX_HOME = home;
  delete process.env.LAX_GITHUB_APP_USER_TOKEN;
});

afterEach(() => {
  vi.restoreAllMocks();
  // markWarmReady seals the warm fixture root read-only; reopen for cleanup
  const warm = warmDir();
  if (fs.existsSync(warm)) fs.chmodSync(warm, 0o755);
  fs.rmSync(home, { recursive: true, force: true });
  if (previous.home === undefined) delete process.env.LAX_HOME;
  else process.env.LAX_HOME = previous.home;
  if (previous.token !== undefined) process.env.LAX_GITHUB_APP_USER_TOKEN = previous.token;
});

/** A ready warm store at warmDir(): locked manifest, package checkouts, marker. */
function makeWarmStore(): string {
  const warm = warmDir();
  fs.mkdirSync(warm, { recursive: true });
  const packages = [
    {
      url: MATHLIB_URL,
      type: "git",
      subDir: null,
      scope: "",
      rev: MATHLIB_REV,
      name: "mathlib",
      manifestFile: "lake-manifest.json",
      inputRev: MATHLIB_REV,
      inherited: false,
      configFile: "lakefile.toml",
    },
  ];
  fs.writeFileSync(
    path.join(warm, "lake-manifest.json"),
    JSON.stringify({ version: "1.2.0", packagesDir: ".lake/packages", packages }, null, 1),
  );
  fs.mkdirSync(path.join(warm, ".lake", "packages", "mathlib"), { recursive: true });
  markWarmReady(warm);
  return warm;
}

function makeSubmission(name: string, issue: number): string {
  const root = path.join(home, name);
  fs.mkdirSync(root, { recursive: true });
  scaffoldSubmission(root, issue, "Registry test", "alice");
  return root;
}

describe("submission registry", () => {
  it("records roots idempotently and prunes vanished submissions", () => {
    const first = makeSubmission("first", 7);
    const second = makeSubmission("second", 8);
    recordSubmission(first);
    recordSubmission(first);
    recordSubmission(second);
    expect(registeredSubmissions().sort()).toEqual(
      [fs.realpathSync(first), fs.realpathSync(second)].sort(),
    );
    fs.rmSync(second, { recursive: true, force: true });
    expect(registeredSubmissions()).toEqual([fs.realpathSync(first)]);
    // the prune persisted
    expect(JSON.parse(fs.readFileSync(registryFile(), "utf8"))).toEqual([
      fs.realpathSync(first),
    ]);
  });

  it("never throws on an unwritable home", () => {
    process.env.LAX_HOME = path.join(home, "missing", "\0bad");
    expect(() => recordSubmission(home)).not.toThrow();
    expect(registeredSubmissions()).toEqual([]);
  });
});

describe("init provisioning", () => {
  it("seeds overrides and manifests for both packages against the warm store", async () => {
    const warm = makeWarmStore();
    const root = makeSubmission("seeded", 42);
    expect(await provisionScaffold(root, 42)).toBe(true);
    for (const kind of ["concepts", "proofs"]) {
      const overrides = JSON.parse(
        fs.readFileSync(path.join(root, kind, ".lake", "package-overrides.json"), "utf8"),
      ) as { packages: Array<{ name: string; dir: string }> };
      expect(overrides.packages.map((pkg) => pkg.name)).toEqual(["mathlib"]);
      expect(overrides.packages[0]!.dir).toBe(
        path.join(fs.realpathSync(warm), ".lake", "packages", "mathlib"),
      );
      const manifest = JSON.parse(
        fs.readFileSync(path.join(root, kind, "lake-manifest.json"), "utf8"),
      ) as { packages: Array<{ name: string; type: string }> };
      expect(manifest.packages.map((pkg) => pkg.name)).toEqual(
        kind === "proofs" ? ["Lax42", "mathlib"] : ["mathlib"],
      );
    }
  });

  it("reports failure without touching the scaffold when the store cannot build", async () => {
    // a plain file where the warm base directory belongs makes the store
    // build fail deterministically without invoking lake
    fs.writeFileSync(path.join(home, "warm"), "");
    const root = makeSubmission("unprovisioned", 43);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await provisionScaffold(root, 43)).toBe(false);
    expect(fs.existsSync(path.join(root, "concepts", ".lake", "package-overrides.json"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(root, "manifest.yaml"))).toBe(true);
  });
});

describe("lax doctor submission checks", () => {
  async function doctorLines(): Promise<string[]> {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await doctor();
    return log.mock.calls.map(([line]) => String(line));
  }

  it("reports a provisioned submission as healthy", async () => {
    makeWarmStore();
    const root = makeSubmission("healthy", 42);
    await provisionScaffold(root, 42);
    recordSubmission(root);
    const lines = await doctorLines();
    expect(lines.some((line) => line.includes("✓ submission healthy:"))).toBe(true);
  });

  it("flags missing overrides, stale clones, and pin drift", async () => {
    makeWarmStore();
    const root = makeSubmission("stale", 42);
    recordSubmission(root);
    // hardlink-farm era leftovers, no overrides
    fs.mkdirSync(path.join(root, "concepts", ".lake", "packages", "mathlib"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(root, "proofs", "lean-toolchain"), "leanprover/lean4:v0.0.1\n");
    const lines = await doctorLines();
    const line = lines.find((entry) => entry.includes("submission stale:"));
    expect(line).toBeDefined();
    expect(line).toContain("! submission stale:");
    expect(line).toContain("has no package overrides");
    expect(line).toContain("pre-overrides era");
    expect(line).toContain("lean-toolchain is leanprover/lean4:v0.0.1");
  });

  it("flags overrides that point at a deleted warm store", async () => {
    const warm = makeWarmStore();
    const root = makeSubmission("orphaned", 42);
    await provisionScaffold(root, 42);
    recordSubmission(root);
    fs.chmodSync(warm, 0o755);
    fs.rmSync(warm, { recursive: true, force: true });
    const lines = await doctorLines();
    const line = lines.find((entry) => entry.includes("submission orphaned:"));
    expect(line).toContain("point at a missing mathlib store");
  });
});
