// The pinned library set of an environment (axiomfree-plan.md, "Environment
// libraries"): librariesOf/runtimeLibraries over spec-1 and spec-2 rows, the
// libraries rule of the lakefile validator keyed by it, the manifest's
// specVersion rule, and the store/cache names derived from the pins.

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  environment as environmentById,
  epoch,
  librariesOf,
  libraryPinKey,
  runtimeLibraries,
  type PinnedLibrary,
} from "../../src/submission-validation/environments.js";
import { FindingCollector } from "../../src/submission-validation/findings.js";
import { validationHostCacheKey } from "../../src/submission-validation/host/setup.js";
import { warmDir } from "../../src/submission-validation/host/warmstore.js";
import { cslibUrl, hostValidationRuntime, laxCoreUrl, mathlibUrl } from "../../src/submission-validation/pins.js";
import { validateLakefile } from "../../src/submission-validation/validators/lakefile.js";
import { validateManifest } from "../../src/submission-validation/validators/manifest.js";
import { spec2TestEnvironment, withTestEnvironments } from "../support/environments.js";
import { cleanupTemporary, LIBRARIES, RUNTIME, temporary } from "../support/submission-validation.js";

afterEach(cleanupTemporary);

const MATHLIB = "a".repeat(40);
const LAXCORE = "b".repeat(40);
const CSLIB = "c".repeat(40);

/** A spec-2 set with every kind of library: two required, one allowed. */
const SPEC2: readonly PinnedLibrary[] = [
  { name: "mathlib", url: () => "https://github.com/leanprover-community/mathlib4", commit: MATHLIB, required: true },
  { name: "LaxCore", url: () => "https://github.com/lax-archive/lax-core", commit: LAXCORE, required: true },
  { name: "cslib", url: () => "https://github.com/leanprover/cslib", commit: CSLIB, required: false },
];

function require(library: PinnedLibrary, overrides: { git?: string; rev?: string; subDir?: string } = {}): string {
  return (
    `[[require]]\nname = "${library.name}"\ngit = "${overrides.git ?? library.url()}"\n` +
    `rev = "${overrides.rev ?? library.commit}"\n` +
    (overrides.subDir === undefined ? "" : `subDir = "${overrides.subDir}"\n`) +
    "\n"
  );
}

function lakefile(requires: string[]): string {
  return (
    'name = "Lax9"\ndefaultTargets = ["Lax9"]\n\n[leanOptions]\nautoImplicit = false\n\n' +
    requires.join("") +
    '[[lean_lib]]\nname = "Lax9"\n'
  );
}

function judge(content: string, libraries: readonly PinnedLibrary[]): { messages: string; libraries?: string[] } {
  const findings = new FindingCollector("static");
  const parsed = validateLakefile(content, "concepts", "Lax9", "concepts/lakefile.toml", libraries, findings);
  return {
    messages: findings.violations.map((violation) => violation.message).join("\n"),
    libraries: parsed?.libraries,
  };
}

describe("the libraries rule of the lakefile validator", () => {
  const [mathlib, laxCore, cslib] = SPEC2 as [PinnedLibrary, PinnedLibrary, PinnedLibrary];

  it("accepts the required set, with or without the allowed library at its pin", () => {
    const without = judge(lakefile([require(mathlib), require(laxCore)]), SPEC2);
    expect(without.messages).toBe("");
    expect(without.libraries).toEqual(["mathlib", "LaxCore"]);
    const withCslib = judge(lakefile([require(mathlib), require(laxCore), require(cslib)]), SPEC2);
    expect(withCslib.messages).toBe("");
    expect(withCslib.libraries).toEqual(["mathlib", "LaxCore", "cslib"]);
  });

  it("requires every required library directly", () => {
    expect(judge(lakefile([require(mathlib)]), SPEC2).messages).toContain(
      "the package must require pinned LaxCore directly",
    );
    const neither = judge(lakefile([require(cslib)]), SPEC2).messages;
    expect(neither).toContain("must require pinned mathlib directly");
    expect(neither).toContain("must require pinned LaxCore directly");
  });

  it("holds a library of the set to its pinned revision, repository, and no subDir", () => {
    const rev = judge(lakefile([require(mathlib), require(laxCore, { rev: "d".repeat(40) })]), SPEC2).messages;
    expect(rev).toContain(`LaxCore revision must be ${LAXCORE}`);
    const url = judge(
      lakefile([require(mathlib), require(laxCore, { git: "https://github.com/evil/lax-core" })]),
      SPEC2,
    ).messages;
    expect(url).toContain("LaxCore repository must be https://github.com/lax-archive/lax-core");
    const subDir = judge(lakefile([require(mathlib), require(laxCore, { subDir: "x" })]), SPEC2).messages;
    expect(subDir).toContain("LaxCore must not specify subDir");
    // the allowed library is held to the same pin once it is required
    const allowed = judge(
      lakefile([require(mathlib), require(laxCore), require(cslib, { rev: "e".repeat(40) })]),
      SPEC2,
    ).messages;
    expect(allowed).toContain(`cslib revision must be ${CSLIB}`);
  });

  it("keeps the spec-1 rule: mathlib alone, and a library name the set lacks is no submission", () => {
    const own = judge(lakefile([require(LIBRARIES[0]!)]), LIBRARIES);
    expect(own.messages).toBe("");
    expect(own.libraries).toEqual(["mathlib"]);
    expect(judge(lakefile([]), LIBRARIES).messages).toContain("must require pinned mathlib directly");
    // a spec-1 environment pins no LaxCore: the require is refused by name,
    // not walked into the submission rules (which would ask for subDir)
    const stray = judge(lakefile([require(LIBRARIES[0]!), require(laxCore)]), LIBRARIES).messages;
    expect(stray).toContain("LaxCore is not a library of this environment (its libraries are mathlib)");
    expect(stray).not.toContain("subDir");
  });
});

describe("the pinned set of a table row", () => {
  it("synthesises mathlib alone for a spec-1 row, from its mathlibCommit", () => {
    const entry = epoch();
    expect(entry.specVersion).toBe(1);
    const set = librariesOf(entry);
    expect(set.map((library) => [library.name, library.commit, library.required, library.url()])).toEqual([
      ["mathlib", entry.mathlibCommit, true, mathlibUrl()],
    ]);
    expect(libraryPinKey(entry)).toBe(entry.mathlibCommit.slice(0, 12));
    // the store and cache names a spec-1 row had before there were sets
    expect(warmDir(entry, "/base")).toBe(path.join("/base", `${entry.id}-${entry.mathlibCommit.slice(0, 12)}`));
    expect(validationHostCacheKey(entry, "Linux")).toContain(`-${entry.id}-${entry.mathlibCommit.slice(0, 12)}-`);
  });

  it("reads a spec-2 row's set through the seams and keys stores by every pin", () => {
    withTestEnvironments([spec2TestEnvironment()], () => {
      const entry = environmentById("v4.35.0")!;
      expect(entry.specVersion).toBe(2);
      const set = librariesOf(entry);
      expect(set.map((library) => [library.name, library.required])).toEqual([
        ["mathlib", true],
        ["LaxCore", true],
      ]);
      // the seams: the fake mathlib's rev and the fixture LaxCore's
      expect(set[0]!.commit).toBe(process.env.LAX_MATHLIB_REV);
      expect(set[0]!.url()).toBe(mathlibUrl());
      expect(set[1]!.commit).toBe(process.env.LAX_LAXCORE_REV);
      expect(set[1]!.url()).toBe(laxCoreUrl());
      expect(entry.mathlibCommit).toBe(set[0]!.commit);
      const key = `${set[0]!.commit.slice(0, 12)}-${set[1]!.commit.slice(0, 12)}`;
      expect(libraryPinKey(entry)).toBe(key);
      expect(warmDir(entry, "/base")).toBe(path.join("/base", `v4.35.0-${key}`));
      expect(validationHostCacheKey(entry, "Linux")).toContain(`-v4.35.0-${key}-`);
    });
  });

  it("admits cslib as an allowed library and refuses an injected row that is not a set", () => {
    withTestEnvironments(
      [{ ...spec2TestEnvironment(), libraries: [{ name: "LaxCore", commit: LAXCORE }, { name: "cslib", commit: CSLIB }] }],
      () => {
        const set = librariesOf(environmentById("v4.35.0")!);
        expect(set.map((library) => [library.name, library.required])).toEqual([
          ["mathlib", true],
          ["LaxCore", true],
          ["cslib", false],
        ]);
        expect(set[2]!.url()).toBe(cslibUrl());
      },
    );
    const duplicate = { ...spec2TestEnvironment(), libraries: [{ name: "LaxCore" as const, commit: LAXCORE }, { name: "LaxCore" as const, commit: CSLIB }] };
    expect(() => withTestEnvironments([duplicate], () => environmentById("v4.35.0"))).toThrow(/twice/u);
    const short = { ...spec2TestEnvironment(), libraries: [{ name: "LaxCore" as const, commit: "abc" }] };
    expect(() => withTestEnvironments([short], () => environmentById("v4.35.0"))).toThrow(/full commit/u);
  });

  it("takes mathlib's pin from the runtime for a run held to one runtime", () => {
    // the fixed-runtime seam: RUNTIME's mathlib commit is the real one while
    // the table row under the fake-mathlib seam carries the fake's
    const set = runtimeLibraries(epoch(), RUNTIME);
    expect(set.map((library) => [library.name, library.commit, library.url()])).toEqual([
      ["mathlib", RUNTIME.mathlibCommit, RUNTIME.mathlibRepository],
    ]);
    withTestEnvironments([spec2TestEnvironment()], () => {
      const entry = environmentById("v4.35.0")!;
      const resolved = (set: readonly PinnedLibrary[]): unknown[] =>
        set.map((library) => [library.name, library.commit, library.required, library.url()]);
      expect(resolved(runtimeLibraries(entry, hostValidationRuntime(entry)))).toEqual(resolved(librariesOf(entry)));
    });
  });
});

describe("the manifest's specVersion follows the environment", () => {
  function manifest(leanVersion: string, mathlibVersion: string, specVersion: string): string {
    return (
      `specVersion: "${specVersion}"\nid: lax-9\nleanVersion: ${leanVersion}\n` +
      `mathlibVersion: ${mathlibVersion}\ntitle: Test submission\n` +
      "authors:\n  - name: Alice Example\nbibEntries: []\n"
    );
  }

  it("is \"1\" in a spec-1 row and \"2\" in a spec-2 row, and nothing else", () => {
    const specVersionFindings = (content: string): string[] => {
      const findings = new FindingCollector("static");
      validateManifest(content, "lax-9", (entry) => hostValidationRuntime(entry), findings);
      return findings.violations.map((violation) => violation.message).filter((message) => message.includes("specVersion"));
    };
    const one = epoch();
    expect(specVersionFindings(manifest(one.id, one.mathlibCommit, "1"))).toEqual([]);
    expect(specVersionFindings(manifest(one.id, one.mathlibCommit, "2"))).toEqual([
      `manifest.yaml: specVersion must be "1" in environment ${one.id}`,
    ]);
    withTestEnvironments([spec2TestEnvironment()], () => {
      const two = environmentById("v4.35.0")!;
      expect(specVersionFindings(manifest(two.id, two.mathlibCommit, "2"))).toEqual([]);
      expect(specVersionFindings(manifest(two.id, two.mathlibCommit, "1"))).toEqual([
        'manifest.yaml: specVersion must be "2" in environment v4.35.0',
      ]);
      expect(specVersionFindings(manifest(two.id, two.mathlibCommit, "3"))).toEqual([
        'manifest.yaml: specVersion must be "2" in environment v4.35.0',
      ]);
    });
  });

  it("leaves the manifest's string on the parsed manifest", () => {
    withTestEnvironments([spec2TestEnvironment()], () => {
      const two = environmentById("v4.35.0")!;
      const findings = new FindingCollector("static");
      const parsed = validateManifest(
        manifest(two.id, two.mathlibCommit, "2"),
        "lax-9",
        (entry) => hostValidationRuntime(entry),
        findings,
      );
      expect(findings.violations).toEqual([]);
      expect(parsed?.specVersion).toBe("2");
    });
  });
});

describe("the fixture LaxCore", () => {
  it("is the library's one module, reachable through the seam", () => {
    const url = process.env.LAX_LAXCORE_URL!;
    expect(url.startsWith("file://")).toBe(true);
    const module = path.join(url.slice("file://".length), "LaxCore.lean");
    expect(fs.readFileSync(module, "utf8")).toContain("initialize laxStatementAttr : TagAttribute ←");
    const scratch = temporary();
    expect(fs.existsSync(scratch)).toBe(true);
  });
});
