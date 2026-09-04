// The submission registry and its consumers: `lax init`/`lax build` record
// submission roots, `lax doctor` checks each one's local health, and init's
// provisioning seeds the same generated Lake files a build would write so a
// bare `lake build` straight after init replays the warm store.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doctor } from "../../src/cli/doctor.js";
import {
  forgetSubmissionsById,
  recordSubmission,
  registeredSubmissions,
  registryFile,
} from "../../src/cli/registry.js";
import { provisionScaffold, scaffoldSubmission } from "../../src/cli/scaffold.js";
import { markWarmReady, warmDir } from "../../src/submission-validation/host/warmstore.js";
import { epoch } from "../../src/submission-validation/environments.js";
import { mathlibUrl } from "../../src/submission-validation/pins.js";
import { removeTree } from "../support/tmp.js";

const previous = {
  home: process.env.LAX_HOME,
  token: process.env.LAX_GITHUB_APP_USER_TOKEN,
  elan: process.env.ELAN_HOME,
};
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lax-registry-"));
  process.env.LAX_HOME = home;
  // These tests are about a submission's local health, not about provisioning,
  // but `lax doctor` provisions: it installs elan, has elan install the pinned
  // toolchain, and then builds the warm store with it. Left alone it would do
  // all three here — fetching a real elan into this temp home, and rebuilding
  // the deleted-store fixture below out from under its own assertion, sealed
  // read-only so only root could clean it up. An empty ELAN_HOME plus an
  // offline fetch stops the chain at its first link, which is also what makes
  // these unit tests offline.
  process.env.ELAN_HOME = path.join(home, "elan");
  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
  delete process.env.LAX_GITHUB_APP_USER_TOKEN;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // the warm fixture is sealed read-only, root and children alike
  removeTree(home);
  if (previous.home === undefined) delete process.env.LAX_HOME;
  else process.env.LAX_HOME = previous.home;
  if (previous.elan === undefined) delete process.env.ELAN_HOME;
  else process.env.ELAN_HOME = previous.elan;
  if (previous.token !== undefined) process.env.LAX_GITHUB_APP_USER_TOKEN = previous.token;
});

/** A ready warm store at warmDir(epoch()): locked manifest, package checkouts, marker. */
function makeWarmStore(): string {
  const warm = warmDir(epoch());
  fs.mkdirSync(warm, { recursive: true });
  const packages = [
    {
      url: mathlibUrl(),
      type: "git",
      subDir: null,
      scope: "",
      rev: epoch().mathlibCommit,
      name: "mathlib",
      manifestFile: "lake-manifest.json",
      inputRev: epoch().mathlibCommit,
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

/** A path as a literal inside a report-matching regular expression. */
function escape(value: string): string {
  return value.replace(/[.*+?^$()|[\]\\]/gu, "\\$&");
}

function makeSubmission(name: string, issue: number): string {
  const root = path.join(home, name);
  fs.mkdirSync(root, { recursive: true });
  scaffoldSubmission(root, `lax-${100_000 + issue}`, "Registry test", epoch());
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

  it("forgets the roots of a deleted id, keeping every other entry", () => {
    // `lax delete` deleted lax-7; its folder stays on disk, the registry
    // entry goes, unreadable entries are left alone for the read-side prune.
    const deleted = makeSubmission("was-lax-7", 7);
    const kept = makeSubmission("still-lax-8", 8);
    const unreadable = path.join(home, "no-manifest");
    fs.mkdirSync(unreadable);
    recordSubmission(deleted);
    recordSubmission(kept);
    fs.writeFileSync(
      registryFile(),
      JSON.stringify(
        [...(JSON.parse(fs.readFileSync(registryFile(), "utf8")) as string[]), unreadable],
        null,
        1,
      ),
    );

    expect(forgetSubmissionsById("lax-100007")).toEqual([fs.realpathSync(deleted)]);
    const remaining = JSON.parse(fs.readFileSync(registryFile(), "utf8")) as string[];
    expect(remaining.sort()).toEqual([fs.realpathSync(kept), unreadable].sort());
    expect(fs.existsSync(path.join(deleted, "manifest.yaml"))).toBe(true);

    // Nothing carried the id: the registry file is untouched.
    expect(forgetSubmissionsById("lax-100009")).toEqual([]);
    expect((JSON.parse(fs.readFileSync(registryFile(), "utf8")) as string[]).sort()).toEqual(
      [fs.realpathSync(kept), unreadable].sort(),
    );
  });
});

describe("init provisioning", () => {
  it("seeds overrides and manifests for both packages against the warm store", async () => {
    const warm = makeWarmStore();
    const root = makeSubmission("seeded", 42);
    expect(await provisionScaffold(root, "lax-100042", epoch())).toEqual({ ok: true });
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
        kind === "proofs" ? ["Lax100042", "mathlib"] : ["mathlib"],
      );
    }
  });

  it("reports failure without touching the scaffold when the store cannot build", async () => {
    // a plain file where the warm base directory belongs makes the store
    // build fail deterministically without invoking lake
    fs.writeFileSync(path.join(home, "warm"), "");
    const root = makeSubmission("unprovisioned", 43);
    // The reason is returned rather than printed: the caller owns the screen,
    // and this is one row of its report.
    const provisioned = await provisionScaffold(root, "lax-100043", epoch());
    expect(provisioned.ok).toBe(false);
    expect(provisioned).toHaveProperty("reason");
    expect(fs.existsSync(path.join(root, "concepts", ".lake", "package-overrides.json"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(root, "manifest.yaml"))).toBe(true);
  });
});

describe("lax doctor submission checks", () => {
  /** The report as one block: a submission's row now leads with its first
   * problem and lists the rest under it, so the assertions are about the block
   * rather than about one line. */
  async function doctorReport(): Promise<string> {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await doctor();
    return log.mock.calls.map(([line]) => String(line)).join("\n");
  }

  it("reports a provisioned submission as its id and its folder", async () => {
    makeWarmStore();
    const root = makeSubmission("healthy", 42);
    await provisionScaffold(root, "lax-100042", epoch());
    recordSubmission(root);
    const report = await doctorReport();
    // the author's noun for the folder is the id it was reserved under
    expect(report).toMatch(new RegExp(`✓ lax-100042\\s+${escape(fs.realpathSync(root))}`, "u"));
  });

  it("names a loginless scaffold by its locally generated id", async () => {
    makeWarmStore();
    const root = makeSubmission("offline-draft", 0);
    await provisionScaffold(root, "lax-100000", epoch());
    recordSubmission(root);
    const report = await doctorReport();
    expect(report).toMatch(new RegExp(`✓ lax-100000\\s+${escape(fs.realpathSync(root))}`, "u"));
  });

  it("flags missing overrides, stale clones, and pin drift", async () => {
    makeWarmStore();
    const root = makeSubmission("stale", 42);
    recordSubmission(root);
    // a warm-closure clone the store supersedes, and no overrides to redirect
    // it — deleting `.lake` leaves the manifest, so a bare `lake build` clones
    // the closure back into the submission
    fs.mkdirSync(path.join(root, "concepts", ".lake", "packages", "mathlib"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(root, "proofs", "lean-toolchain"), "leanprover/lean4:v0.0.1\n");
    const report = await doctorReport();
    expect(report).toMatch(/! lax-100042\s/u);
    expect(report).toContain("has no package overrides");
    expect(report).toContain("mathlib-closure clones the warm store replaces (mathlib)");
    expect(report).toContain("lean-toolchain is leanprover/lean4:v0.0.1");
  });

  /** A locked git entry for `name`, as `lax build` writes for a
   * cross-submission require — and as lake reads it: its licence to clone the
   * dependency into `.lake/packages` and build it there. */
  function requireDependency(pkgDir: string, name: string): void {
    const file = path.join(pkgDir, "lake-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as {
      packages: Array<Record<string, unknown>>;
    };
    manifest.packages.unshift({
      url: "https://github.com/lax-archive/lax-submissions",
      type: "git",
      subDir: "upstream/concepts",
      scope: "",
      rev: "0".repeat(40),
      name,
      manifestFile: "lake-manifest.json",
      inputRev: "0".repeat(40),
      inherited: false,
      configFile: "lakefile.toml",
    });
    fs.writeFileSync(file, JSON.stringify(manifest, null, 1));
  }

  /** The relative path override an author's local loop adds by hand to build a
   * cross-submission dependency from the folder next door instead of its pin. */
  function siblingOverride(pkgDir: string, name: string, dir: string): void {
    const file = path.join(pkgDir, ".lake", "package-overrides.json");
    const overrides = JSON.parse(fs.readFileSync(file, "utf8")) as {
      packages: Array<Record<string, unknown>>;
    };
    overrides.packages.unshift({ type: "path", name, inherited: false, scope: "", dir });
    fs.writeFileSync(file, JSON.stringify(overrides, null, 1));
  }

  /** What lake materializes for a git manifest entry. */
  function clonePackage(pkgDir: string, name: string): void {
    fs.mkdirSync(path.join(pkgDir, ".lake", "packages", name), { recursive: true });
  }

  it("leaves a dependency clone alone while a sibling override shadows it", async () => {
    makeWarmStore();
    const root = makeSubmission("shadowed", 42);
    await provisionScaffold(root, "lax-100042", epoch());
    recordSubmission(root);
    const proofs = path.join(root, "proofs");
    const sibling = path.join(home, "upstream", "concepts");
    fs.mkdirSync(sibling, { recursive: true });
    requireDependency(proofs, "Lax67");
    clonePackage(proofs, "Lax67");
    siblingOverride(proofs, "Lax67", path.relative(proofs, sibling));
    const report = await doctorReport();
    // The clone is the local build's own incremental workspace: the override
    // shadows it only until the next `lax build` rewrites the overrides from
    // the pins, and deleting it would cost a re-clone and a full rebuild.
    expect(report).toMatch(new RegExp(`✓ lax-100042\\s+${escape(fs.realpathSync(root))}`, "u"));
  });

  it("names the clones the manifest no longer lists, and only those", async () => {
    makeWarmStore();
    const root = makeSubmission("renamed", 42);
    await provisionScaffold(root, "lax-100042", epoch());
    recordSubmission(root);
    const proofs = path.join(root, "proofs");
    requireDependency(proofs, "Lax67");
    clonePackage(proofs, "Lax67");
    // Lax13 named the same submission before a superseding revision renamed it
    // throughout: still on disk, no longer required, never read again.
    clonePackage(proofs, "Lax13");
    clonePackage(proofs, "Lax13Proofs");
    const report = await doctorReport();
    expect(report).toMatch(/! lax-100042\s/u);
    expect(report).toContain("no longer lists (Lax13, Lax13Proofs)");
    expect(report).toContain("delete the listed folders under .lake/packages");
    expect(report).not.toContain("Lax67");
  });

  it("calls no clone an orphan without a manifest to compare it against", async () => {
    makeWarmStore();
    const root = makeSubmission("unbuilt", 42);
    recordSubmission(root);
    // `lax build` writes the manifest; until it has, a clone left by an
    // earlier one is as likely to be live as dead.
    clonePackage(path.join(root, "proofs"), "Lax67");
    const report = await doctorReport();
    expect(report).not.toContain("no longer lists");
  });

  it("flags a warm-closure clone and the legacy generation marker", async () => {
    makeWarmStore();
    const root = makeSubmission("legacy", 42);
    await provisionScaffold(root, "lax-100042", epoch());
    recordSubmission(root);
    // mathlib belongs in the store the overrides point at, never here
    clonePackage(path.join(root, "concepts"), "mathlib");
    const packages = path.join(root, "proofs", ".lake", "packages");
    fs.mkdirSync(packages, { recursive: true });
    fs.writeFileSync(path.join(packages, ".lax-warm-generation"), "1\n");
    const report = await doctorReport();
    expect(report).toMatch(/! lax-100042\s/u);
    expect(report).toContain(
      "concepts/.lake/packages holds mathlib-closure clones the warm store replaces (mathlib)",
    );
    expect(report).toContain(
      "proofs/.lake/packages holds mathlib-closure clones the warm store replaces (.lax-warm-generation)",
    );
  });

  it("flags overrides that point at a deleted warm store", async () => {
    const warm = makeWarmStore();
    const root = makeSubmission("orphaned", 42);
    await provisionScaffold(root, "lax-100042", epoch());
    recordSubmission(root);
    fs.chmodSync(warm, 0o755);
    fs.rmSync(warm, { recursive: true, force: true });
    const report = await doctorReport();
    expect(report).toMatch(/! lax-100042\s/u);
    // macOS resolves the two broken links to one grouped folder finding;
    // Linux retains one missing-store detail per package.
    expect(report).toContain("package overrides point at");
    expect(report).toMatch(/missing (?:folders|mathlib store)/u);
    // The fixture has to survive the report that reads it: doctor provisions a
    // missing store, and with a toolchain in reach it would rebuild this one
    // mid-test — leaving the override valid, the assertion above false, and a
    // sealed tree in the temp home that only root can delete.
    expect(fs.existsSync(warm)).toBe(false);
  });
});
