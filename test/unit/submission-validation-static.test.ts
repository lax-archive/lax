import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FindingCollector } from "../../src/submission-validation/findings.js";
import { deriveInventory } from "../../src/submission-validation/phases/inventory.js";
import { runStaticValidation } from "../../src/submission-validation/phases/static.js";
import { validateLakefile } from "../../src/submission-validation/validators/lakefile.js";
import { isAcceptedLicense } from "../../src/submission-validation/validators/license.js";
import { validateManifest } from "../../src/submission-validation/validators/manifest.js";
import {
  cleanupTemporary,
  COMMIT,
  initializeGit,
  lakefile,
  makeSubmission,
  manifest,
  request,
  RUNTIME,
  temporary,
  writeFile,
} from "../support/submission-validation.js";

afterEach(cleanupTemporary);

describe("submission static validation retained from main", () => {
  it("accepts only the canonical Apache-2.0 license, with harmless whitespace and copyright", () => {
    const canonical = fs.readFileSync(
      new URL("../../assets/apache-2.0.txt", import.meta.url),
      "utf8",
    );
    expect(isAcceptedLicense(canonical)).toBe(true);
    expect(isAcceptedLicense(canonical.replace(/\n/gu, "\n\n") + "\nCopyright 2026 Alice\n")).toBe(true);
    expect(isAcceptedLicense(canonical.replace("Apache License", "Apache Licence"))).toBe(false);
    expect(isAcceptedLicense("MIT License\n")).toBe(false);
  });

  it("accepts a complete manifest and retains strict keys, ids, and runtime pins", () => {
    const findings = new FindingCollector("static");
    const parsed = validateManifest(manifest("lax-261"), "lax-261", RUNTIME, findings);
    expect(findings.violations).toEqual([]);
    expect(parsed).toMatchObject({ id: "lax-261", title: "Test submission" });
    expect(parsed?.authors).toEqual([{ name: "Alice Example", github: "alice" }]);

    const legacyFindings = new FindingCollector("static");
    const legacy = validateManifest(manifest("Lax261"), "lax-261", RUNTIME, legacyFindings);
    expect(legacyFindings.violations).toEqual([]);
    expect(legacy?.id).toBe("lax-261");

    for (const [content, expected] of [
      [manifest("lax-261") + "extra: true\n", "unknown key"],
      [manifest("lax-261").replace("id: lax-261", "id: lax-26"), "id must be lax-261"],
      [manifest("lax-261").replace(RUNTIME.leanVersion, "v4.29.0"), "leanVersion"],
      [manifest("lax-261").replace(RUNTIME.mathlibCommit, COMMIT), "mathlibVersion"],
      [manifest("lax-261").replace('specVersion: "1"', 'specVersion: "2"'), "specVersion"],
      [manifest("lax-261").replace("    github: alice\n", "    email: a@b.test\n"), "unknown key"],
    ] as const) {
      const invalid = new FindingCollector("static");
      validateManifest(content, "lax-261", RUNTIME, invalid);
      expect(invalid.violations.map((finding) => finding.message).join("\n")).toContain(expected);
    }
  });

  it("accepts an empty author list", () => {
    const findings = new FindingCollector("static");
    const parsed = validateManifest(
      manifest("lax-261").replace("authors:\n  - name: Alice Example\n    github: alice", "authors: []"),
      "lax-261",
      RUNTIME,
      findings,
    );

    expect(findings.violations).toEqual([]);
    expect(parsed?.authors).toEqual([]);
  });

  it("accepts concept and proof lakefiles and warns about proof-package dependencies", () => {
    const concepts = new FindingCollector("static");
    const concept = validateLakefile(
      lakefile("Lax261", {
        requirements: [
          `name = "Lax42"\ngit = "https://github.com/alice/upstream"\nrev = "${COMMIT}"\nsubDir = "concepts"`,
        ],
      }),
      "concepts",
      "Lax261",
      "concepts/lakefile.toml",
      RUNTIME,
      concepts,
    );
    expect(concepts.violations).toEqual([]);
    expect(concept?.gitRequires.map((requirement) => requirement.name)).toEqual(["Lax42"]);

    const proofs = new FindingCollector("static");
    const proof = validateLakefile(
      lakefile("Lax261Proofs", {
        ownConcept: "Lax261",
        requirements: [
          `name = "Lax42Proofs"\ngit = "https://github.com/alice/upstream"\nrev = "${COMMIT}"\nsubDir = "proofs"`,
        ],
      }),
      "proofs",
      "Lax261Proofs",
      "proofs/lakefile.toml",
      RUNTIME,
      proofs,
    );
    expect(proofs.violations).toEqual([]);
    expect(proofs.warnings.map((finding) => finding.message).join("\n")).toContain("discouraged");
    expect(proof?.hasConceptPathRequire).toBe(true);
  });

  it("requires direct mathlib in a proof package too", () => {
    // the direct-mathlib rule is a property of *every* package: the aggregated
    // whitelist test above only exercises the concept kind
    const findings = new FindingCollector("static");
    validateLakefile(
      lakefile("Lax261Proofs", { ownConcept: "Lax261" }).replace(
        `[[require]]\nname = "mathlib"\ngit = "${RUNTIME.mathlibRepository}"\n` +
          `rev = "${RUNTIME.mathlibCommit}"\n\n`,
        "",
      ),
      "proofs",
      "Lax261Proofs",
      "proofs/lakefile.toml",
      RUNTIME,
      findings,
    );
    expect(findings.violations.map((finding) => finding.message).join("\n")).toContain(
      "must require pinned mathlib directly",
    );
  });

  it("keeps the own-edge spelling exact: a variant is a sibling self-reference", () => {
    // `./../concepts` is not the own-edge spelling; it validates as a sibling
    // edge (and siblings.ts then refuses the self-reference — see
    // submission-validation-siblings.test.ts)
    const findings = new FindingCollector("static");
    const parsed = validateLakefile(
      lakefile("Lax261Proofs", { ownConcept: "Lax261" }).replace(
        'path = "../concepts"',
        'path = "./../concepts"',
      ),
      "proofs",
      "Lax261Proofs",
      "proofs/lakefile.toml",
      RUNTIME,
      findings,
    );
    expect(findings.violations).toEqual([]);
    expect(parsed?.hasConceptPathRequire).toBe(false);
    expect(parsed?.pathRequires).toEqual([{ name: "Lax261", path: "../concepts" }]);
  });

  it("normalizes sibling paths but rejects malformed and disallowed requirements", () => {
    const normalized = new FindingCollector("static");
    const parsed = validateLakefile(
      lakefile("Lax9Proofs", {
        ownConcept: "Lax9",
        requirements: ['name = "Lax7Proofs"\npath = "./../../other//proofs/"'],
      }),
      "proofs",
      "Lax9Proofs",
      "proofs/lakefile.toml",
      RUNTIME,
      normalized,
    );
    expect(normalized.violations).toEqual([]);
    expect(parsed?.pathRequires).toEqual([{ name: "Lax7Proofs", path: "../../other/proofs" }]);

    for (const [requirement, kind, expected] of [
      ['name = "Lax7"\npath = "/abs/concepts"', "concepts", "relative POSIX"],
      ['name = "Lax7"\npath = "..\\\\other\\\\concepts"', "concepts", "relative POSIX"],
      ['name = "Lax7"\npath = "../../other"', "concepts", "end in concepts or proofs"],
      ['name = "Lax7Proofs"\npath = "../../other/concepts"', "proofs", "target kind disagree"],
      ['name = "Lax7Proofs"\npath = "../../other/proofs"', "concepts", "cannot require proof"],
      ['name = "Lax7"\npath = "../../other/concepts"\nrev = "x"', "concepts", "exactly name and path"],
    ] as const) {
      const findings = new FindingCollector("static");
      const packageName = kind === "concepts" ? "Lax9" : "Lax9Proofs";
      validateLakefile(
        lakefile(packageName, {
          ...(kind === "proofs" ? { ownConcept: "Lax9" } : {}),
          requirements: [requirement],
        }),
        kind,
        packageName,
        `${kind}/lakefile.toml`,
        RUNTIME,
        findings,
      );
      expect(findings.violations.map((finding) => finding.message).join("\n")).toContain(expected);
    }
  });

  it("retains the lakefile whitelist and direct pinned-mathlib rules", () => {
    for (const [content, expected] of [
      [lakefile("Lax9") + '\n[[lean_exe]]\nname = "x"\n', "not allowed"],
      [lakefile("Lax9").replace("autoImplicit = false", "autoImplicit = true"), "autoImplicit"],
      [lakefile("Lax9").replace('defaultTargets = ["Lax9"]', "defaultTargets = []"), "defaultTargets"],
      [lakefile("Lax9").replace('name = "mathlib"', 'name = "mathlib2"'), "pinned mathlib"],
      [lakefile("Lax9").replace(RUNTIME.mathlibRepository, "https://github.com/evil/mathlib4"), "mathlib repository"],
    ] as const) {
      const findings = new FindingCollector("static");
      validateLakefile(content, "concepts", "Lax9", "concepts/lakefile.toml", RUNTIME, findings);
      expect(findings.violations.map((finding) => finding.message).join("\n")).toContain(expected);
    }
  });

  it("maps module paths and rejects nested concept modules while allowing nested proofs", () => {
    const root = temporary();
    writeFile(root, "concepts/Lax9.lean", "");
    writeFile(root, "concepts/Lax9/Foo.lean", "");
    writeFile(root, "concepts/Lax9/Deep/Bar.lean", "");
    const concepts = new FindingCollector("static");
    expect(deriveInventory(root, "concepts", "Lax9", concepts).modules).toEqual(["Lax9.Foo"]);
    expect(concepts.violations.map((finding) => finding.message).join("\n")).toContain("cannot be nested");

    writeFile(root, "proofs/Lax9Proofs.lean", "");
    writeFile(root, "proofs/Lax9Proofs/Deep/Bar.lean", "");
    const proofs = new FindingCollector("static");
    expect(deriveInventory(root, "proofs", "Lax9Proofs", proofs).modules).toEqual([
      "Lax9Proofs.Deep.Bar",
    ]);
    expect(proofs.violations).toEqual([]);
  });

  it("collects independent static violations in one pass", () => {
    const root = makeSubmission("lax-4");
    fs.appendFileSync(path.join(root, "manifest.yaml"), "extra: nope\n");
    writeFile(root, "abstract.md", "  \n");
    writeFile(root, "LICENSE", "Not a license\n");
    writeFile(root, "concepts/lean-toolchain", "leanprover/lean4:v4.29.0\n");
    writeFile(root, "concepts/lakefile.lean", "import Lake\n");
    writeFile(root, "concepts/Lax4/Sub/X.lean", "");
    writeFile(
      root,
      "proofs/lakefile.toml",
      lakefile("Lax4Proofs", { ownConcept: "Lax4" }).replace(
        "autoImplicit = false",
        "autoImplicit = true",
      ) + "\nfoo = 1\n",
    );
    initializeGit(root);

    const check = runStaticValidation(request("lax-4"), root, RUNTIME);
    const rules = new Set(check.findings.violations.map((finding) => finding.rule));
    for (const rule of ["manifest", "abstract", "license", "toolchain", "lakefile", "layout"]) {
      expect(rules).toContain(rule);
    }
  });

  it("rejects committed generated build files", () => {
    const root = makeSubmission("lax-5");
    fs.rmSync(path.join(root, ".gitignore"));
    writeFile(root, "build-output.json", "{}\n");
    writeFile(root, "concepts/lake-manifest.json", "{}\n");
    initializeGit(root);

    const check = runStaticValidation(request("lax-5"), root, RUNTIME);
    const generated = check.findings.violations.filter(
      (finding) => finding.rule === "generated-files",
    );
    expect(generated.map((finding) => finding.message).join("\n")).toContain("build-output.json");
    expect(generated.map((finding) => finding.message).join("\n")).toContain("lake-manifest.json");
  });

  it("rejects a checked-in package-overrides file but tolerates the gitignored lax-written one", () => {
    // tracked (the .gitignore no longer covers .lake/): a dependency-
    // redirection primitive, rejected with the lax-generated explanation
    const bad = makeSubmission("lax-6");
    writeFile(bad, ".gitignore", "build-output.json\nlake-manifest.json\n");
    writeFile(bad, "concepts/.lake/package-overrides.json", '{"version": "1.2.0", "packages": []}\n');
    initializeGit(bad);
    const rejected = runStaticValidation(request("lax-6"), bad, RUNTIME);
    const overrides = rejected.findings.violations.filter(
      (finding) =>
        finding.rule === "generated-files" && finding.message.includes("package-overrides"),
    );
    expect(overrides).toHaveLength(1);
    expect(overrides[0]!.message).toContain("concepts/.lake/package-overrides.json");
    expect(overrides[0]!.message).toContain("generated by lax");
    expect(overrides[0]!.message).toContain("gitignored");

    // present on disk but gitignored — exactly what lax build itself writes;
    // static validation must not reject it
    const good = makeSubmission("lax-7");
    writeFile(good, "concepts/.lake/package-overrides.json", '{"version": "1.2.0", "packages": []}\n');
    initializeGit(good);
    const accepted = runStaticValidation(request("lax-7"), good, RUNTIME);
    expect(accepted.findings.violations).toEqual([]);
  });
});
