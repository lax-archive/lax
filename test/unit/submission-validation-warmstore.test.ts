// seedOverrides/seedManifest against a synthetic warm workspace: the
// overrides file redirects every locked package to the shared checkout while
// the generated manifest keeps the warm git-type entries verbatim. The real
// consumption of both files by `lake build` is covered by the host-pipeline
// e2e tests.

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedManifest, seedOverrides } from "../../src/submission-validation/host/warmstore.js";
import { cleanupTemporary, temporary } from "../support/submission-validation.js";

afterEach(cleanupTemporary);

const WARM_PACKAGES = [
  {
    url: "https://github.com/leanprover-community/mathlib4",
    type: "git",
    subDir: null,
    scope: "",
    rev: "c".repeat(40),
    name: "mathlib",
    manifestFile: "lake-manifest.json",
    inputRev: "c".repeat(40),
    inherited: false,
    configFile: "lakefile.toml",
  },
  {
    url: "https://github.com/leanprover-community/batteries",
    type: "git",
    subDir: null,
    scope: "leanprover-community",
    rev: "d".repeat(40),
    name: "batteries",
    manifestFile: "lake-manifest.json",
    inputRev: "main",
    inherited: true,
    configFile: "lakefile.toml",
  },
];

function makeWarm(): string {
  const warm = temporary("lax-warm-fixture-");
  fs.writeFileSync(
    path.join(warm, "lake-manifest.json"),
    JSON.stringify(
      { version: "1.2.0", packagesDir: ".lake/packages", packages: WARM_PACKAGES },
      null,
      1,
    ) + "\n",
  );
  for (const pkg of WARM_PACKAGES)
    fs.mkdirSync(path.join(warm, ".lake", "packages", pkg.name), { recursive: true });
  return warm;
}

describe("warm store package overrides", () => {
  it("writes one path override per locked package, preserving inherited and scope", () => {
    const warm = makeWarm();
    const pkgDir = temporary("lax-consumer-");
    seedOverrides(warm, pkgDir);

    const overrides = JSON.parse(
      fs.readFileSync(path.join(pkgDir, ".lake", "package-overrides.json"), "utf8"),
    ) as { version: string; packages: Record<string, unknown>[] };
    const realWarm = fs.realpathSync(warm);
    expect(overrides.version).toBe("1.2.0");
    expect(overrides.packages).toEqual([
      {
        type: "path",
        name: "mathlib",
        dir: path.join(realWarm, ".lake", "packages", "mathlib"),
        // lake refuses an overrides entry without `inherited`
        inherited: false,
        scope: "",
      },
      {
        type: "path",
        name: "batteries",
        dir: path.join(realWarm, ".lake", "packages", "batteries"),
        inherited: true,
        scope: "leanprover-community",
      },
    ]);
    // no leftover staged temp file from the temp+rename write
    expect(fs.readdirSync(path.join(pkgDir, ".lake"))).toEqual(["package-overrides.json"]);
  });

  it("rewrites an existing overrides file in place", () => {
    const warm = makeWarm();
    const pkgDir = temporary("lax-consumer-");
    fs.mkdirSync(path.join(pkgDir, ".lake"), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, ".lake", "package-overrides.json"),
      '{"version": "1.2.0", "packages": []}\n',
    );
    seedOverrides(warm, pkgDir);
    const overrides = JSON.parse(
      fs.readFileSync(path.join(pkgDir, ".lake", "package-overrides.json"), "utf8"),
    ) as { packages: { name: string }[] };
    expect(overrides.packages.map((pkg) => pkg.name)).toEqual(["mathlib", "batteries"]);
  });

  it("seeds a manifest with the path deps first and the warm git entries verbatim", () => {
    const warm = makeWarm();
    const pkgDir = temporary("lax-consumer-");
    seedManifest(warm, pkgDir, [
      { name: "Lax9", dir: "../concepts" },
      { name: "Lax9", dir: "ignored-duplicate" },
    ]);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(pkgDir, "lake-manifest.json"), "utf8"),
    ) as { packages: Record<string, unknown>[] };
    expect(manifest.packages).toHaveLength(3);
    expect(manifest.packages[0]).toMatchObject({ type: "path", name: "Lax9", dir: "../concepts" });
    // the warm entries stay git-type, byte-identical pins: the overrides
    // file, not the manifest, is what redirects them to the store
    expect(manifest.packages.slice(1)).toEqual(WARM_PACKAGES);
    expect(fs.readdirSync(pkgDir)).toEqual(["lake-manifest.json"]);
  });
});
