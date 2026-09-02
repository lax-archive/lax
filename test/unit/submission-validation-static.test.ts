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

  it("accepts an optional supersedes claim and normalizes its legacy spelling", () => {
    const findings = new FindingCollector("static");
    const parsed = validateManifest(
      manifest("lax-261") + "supersedes: lax-9\n",
      "lax-261",
      RUNTIME,
      findings,
    );
    expect(findings.violations).toEqual([]);
    expect(parsed?.supersedes).toBe("lax-9");

    const legacyFindings = new FindingCollector("static");
    const legacy = validateManifest(
      manifest("lax-261") + "supersedes: Lax9\n",
      "lax-261",
      RUNTIME,
      legacyFindings,
    );
    expect(legacyFindings.violations).toEqual([]);
    expect(legacy?.supersedes).toBe("lax-9");

    const absentFindings = new FindingCollector("static");
    const absent = validateManifest(manifest("lax-261"), "lax-261", RUNTIME, absentFindings);
    expect(absentFindings.violations).toEqual([]);
    expect(absent !== undefined && "supersedes" in absent).toBe(false);

    for (const [content, expected] of [
      [manifest("lax-261") + "supersedes: lax-261\n", "cannot supersede itself"],
      [manifest("lax-261") + "supersedes: Lax261\n", "cannot supersede itself"],
      [manifest("lax-261") + "supersedes: RamseyTheory\n", "supersedes"],
      [manifest("lax-261") + "supersedes: [lax-9]\n", "must be a string"],
      [manifest("lax-261") + "supersedes:\n", "must be a string"],
    ] as const) {
      const invalid = new FindingCollector("static");
      validateManifest(content, "lax-261", RUNTIME, invalid);
      expect(invalid.violations.map((finding) => finding.message).join("\n")).toContain(expected);
    }
  });

  it("gates the offline placeholder id on what the request is for", () => {
    // `lax init --offline` writes `id: lax-0`, and a local build passes its own
    // id in, so the whole static gate is happy with it …
    const root = makeSubmission("lax-0");
    initializeGit(root);
    const local = runStaticValidation(request("lax-0"), root, RUNTIME);
    expect(local.findings.violations).toEqual([]);
    expect(local.result.manifest?.id).toBe("lax-0");
    expect(local.result.concepts?.lakefile.packageName).toBe("Lax0");

    // … while the trusted path takes the id from the issue, where the
    // placeholder can only ever be the wrong one.
    const trusted = new FindingCollector("static");
    validateManifest(manifest("lax-0"), "lax-261", RUNTIME, trusted);
    expect(trusted.violations.map((finding) => finding.message).join("\n")).toContain(
      "id must be lax-261",
    );
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

  it("accepts only the proof package's own ../concepts edge and walks every other path require to the chain workflow", () => {
    // accept: the own-concepts edge, exactly spelled, is the one path require
    const own = new FindingCollector("static");
    const parsed = validateLakefile(
      lakefile("Lax9Proofs", { ownConcept: "Lax9" }),
      "proofs",
      "Lax9Proofs",
      "proofs/lakefile.toml",
      RUNTIME,
      own,
    );
    expect(own.violations).toEqual([]);
    expect(parsed?.hasConceptPathRequire).toBe(true);

    // reject: a path require into another submission, with the discoverability
    // hook the replacement workflow depends on
    const crossSubmission = new FindingCollector("static");
    validateLakefile(
      lakefile("Lax9Proofs", {
        ownConcept: "Lax9",
        requirements: ['name = "Lax7Proofs"\npath = "../../other/proofs"'],
      }),
      "proofs",
      "Lax9Proofs",
      "proofs/lakefile.toml",
      RUNTIME,
      crossSubmission,
    );
    expect(crossSubmission.violations).toHaveLength(1);
    const message = crossSubmission.violations[0]!.message;
    expect(message).toContain("path require reaching another submission's package is not supported");
    expect(message).toContain("chain workflow");
    expect(message).toContain("commit and submit the dependency");
    expect(message).toContain('rev = "<commit>"');
    expect(message).toContain("package overrides");

    for (const [requirement, kind, expected] of [
      ['name = "Lax7"\npath = "/abs/concepts"', "concepts", "is not supported"],
      ['name = "Lax7"\npath = "../../other/concepts"', "concepts", "is not supported"],
      // even the ../concepts spelling is only the own edge, only from proofs/
      ['name = "Lax8"\npath = "../concepts"', "concepts", "is not supported"],
      ['name = "Lax7"\npath = "../concepts"', "proofs", "must be named Lax9"],
      // the own-edge spelling is exact: a `./../concepts` variant is not the
      // own edge and lands in the general path-require rejection
      ['name = "Lax10"\npath = "./../concepts"', "proofs", "is not supported"],
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

const PAPER_BLOCK = "paper:\n  folder: paper\n  main: main.tex\n";

describe("paper static validation", () => {
  it("accepts a paper block and defaults the engine to pdflatex", () => {
    const findings = new FindingCollector("static");
    const parsed = validateManifest(manifest("lax-261") + PAPER_BLOCK, "lax-261", RUNTIME, findings);
    expect(findings.violations).toEqual([]);
    expect(parsed?.paper).toEqual({ folder: "paper", main: "main.tex", engine: "pdflatex" });

    const lua = new FindingCollector("static");
    const explicit = validateManifest(
      manifest("lax-261") + "paper:\n  folder: .\n  main: src/paper.tex\n  engine: lualatex\n",
      "lax-261",
      RUNTIME,
      lua,
    );
    expect(lua.violations).toEqual([]);
    expect(explicit?.paper).toEqual({ folder: ".", main: "src/paper.tex", engine: "lualatex" });

    const absent = new FindingCollector("static");
    const without = validateManifest(manifest("lax-261"), "lax-261", RUNTIME, absent);
    expect(without !== undefined && "paper" in without).toBe(false);
  });

  it("accepts the web opt-out key and keeps it out of the block when unwritten", () => {
    // `paper.web: false` opts the submission out of the derived web view
    // (paper-web-plan.md, "Author-facing contract"); `true` restates the
    // default; absence means default (the key is simply not carried).
    const optedOut = new FindingCollector("static");
    const parsed = validateManifest(
      manifest("lax-261") + "paper:\n  folder: paper\n  main: main.tex\n  web: false\n",
      "lax-261",
      RUNTIME,
      optedOut,
    );
    expect(optedOut.violations).toEqual([]);
    expect(parsed?.paper).toEqual({ folder: "paper", main: "main.tex", engine: "pdflatex", web: false });

    const restated = new FindingCollector("static");
    const explicit = validateManifest(
      manifest("lax-261") + "paper:\n  folder: paper\n  main: main.tex\n  web: true\n",
      "lax-261",
      RUNTIME,
      restated,
    );
    expect(restated.violations).toEqual([]);
    expect(explicit?.paper).toEqual({ folder: "paper", main: "main.tex", engine: "pdflatex", web: true });

    const unwritten = new FindingCollector("static");
    const defaulted = validateManifest(manifest("lax-261") + PAPER_BLOCK, "lax-261", RUNTIME, unwritten);
    expect(defaulted?.paper !== undefined && "web" in defaulted.paper).toBe(false);
  });

  it("rejects malformed paper blocks", () => {
    for (const [block, expected] of [
      ["paper:\n  folder: paper\n  main: main.tex\n  shell: true\n", "paper: unknown key `shell`"],
      ["paper:\n  folder: paper\n", "paper: missing key `main`"],
      ["paper:\n  main: main.tex\n", "paper: missing key `folder`"],
      ["paper:\n  folder: paper\n  main: main.tex\n  engine: latex\n", "paper.engine must be one of pdflatex, lualatex, xelatex"],
      ["paper:\n  folder: paper\n  main: main.tex\n  web: never\n", "paper.web must be true or false"],
      ["paper:\n  folder: paper\n  main: main.pdf\n", "paper.main must name a `.tex` file"],
      ["paper:\n  folder: paper\n  main: ../main.tex\n", "paper.main must be a relative path of plain segments"],
      ["paper:\n  folder: paper\n  main: 12\n", "paper.main must be a string"],
      ["paper:\n  folder: ../elsewhere\n  main: main.tex\n", "paper.folder must contain"],
      ["paper:\n  folder: /abs\n  main: main.tex\n", "paper.folder must be a relative POSIX path"],
      ["paper: yes\n", "`paper` must be a mapping"],
    ] as const) {
      const findings = new FindingCollector("static");
      const parsed = validateManifest(manifest("lax-261") + block, "lax-261", RUNTIME, findings);
      expect(findings.violations.map((finding) => finding.message).join("\n")).toContain(expected);
      expect(parsed?.paper).toBeUndefined();
    }
  });

  it("rewrites a declared paper's markers and hands out the mark table", () => {
    const root = makeSubmission("lax-261", undefined, {
      "manifest.yaml": manifest("lax-261") + PAPER_BLOCK,
      "paper/main.tex":
        "\\documentclass{article}\n\\begin{document}\n" +
        "% lax begin Lax261.Treewidth\n" +
        "A definition.\n" +
        "  % lax begin Lax261.Nested\n" +
        "Nested text.\n" +
        "  % lax end\n" +
        "% lax end Lax261.Treewidth\n" +
        "An inline claim. % lax begin Lax261Proofs.Q\nProof sketch.\\\\% lax end\n" +
        "\\input{section}\n\\end{document}\n",
      "paper/section.tex": "\\section{More}\n% lax begin Lax261.Section\nText.\n% lax end\n",
      "paper/aux.tex": "% no markers, 100\\% plain\n",
      "paper/refs.bib": "@misc{x, title={X}}\n",
    });
    initializeGit(root);

    const check = runStaticValidation(request("lax-261"), root, RUNTIME);
    expect(check.findings.violations).toEqual([]);
    const paper = check.result.paper!;
    expect(paper.manifest).toEqual({ folder: "paper", main: "main.tex", engine: "pdflatex" });
    expect(paper.files).toEqual(["aux.tex", "main.tex", "refs.bib", "section.tex"]);
    // the entry file first, then the rest by path — so numbering does not
    // depend on the directory listing
    expect(paper.texFiles).toEqual(["main.tex", "aux.tex", "section.tex"]);
    expect(paper.marks).toEqual([
      { n: 1, id: "Lax261.Treewidth", file: "main.tex", line: 3 },
      { n: 2, id: "Lax261.Nested", file: "main.tex", line: 5 },
      { n: 3, id: "Lax261Proofs.Q", file: "main.tex", line: 9 },
      { n: 4, id: "Lax261.Section", file: "section.tex", line: 2 },
    ]);
    const main = paper.rewritten.get("main.tex")!;
    expect(main).toContain("\\laxmark{b}{1}%\nA definition.\n  \\laxmark{b}{2}%\nNested text.\n  \\laxmark{e}{2}%\n\\laxmark{e}{1}%\n");
    expect(main).toContain("An inline claim. \\laxmark{b}{3}%\nProof sketch.\\\\\\laxmark{e}{3}%\n");
    expect(main).not.toContain("% lax");
    expect(paper.rewritten.get("section.tex")).toBe("\\section{More}\n\\laxmark{b}{4}%\nText.\n\\laxmark{e}{4}%\n");
    expect(paper.rewritten.get("aux.tex")).toBe("% no markers, 100\\% plain\n");
    expect(paper.rewritten.has("refs.bib")).toBe(false);
  });

  it("takes the submission root as the paper folder, leaving out the build's own outputs", () => {
    const root = makeSubmission("lax-261", undefined, {
      "manifest.yaml": manifest("lax-261") + "paper:\n  folder: .\n  main: main.tex\n",
      "main.tex": "\\documentclass{article}\\begin{document}x\\end{document}\n",
    });
    initializeGit(root);
    // the local build leaves these beside the sources; they are never part of the compile copy
    writeFile(root, "build-output.json", "{}\n");
    writeFile(root, "paper.pdf", "%PDF-1.5\n");
    writeFile(root, "concepts/.lake/package-overrides.json", "{}\n");

    const check = runStaticValidation(request("lax-261"), root, RUNTIME);
    expect(check.findings.violations).toEqual([]);
    const files = check.result.paper!.files;
    expect(files).toContain("main.tex");
    expect(files).toContain("manifest.yaml");
    expect(files).toContain("concepts/lakefile.toml");
    expect(files).not.toContain("build-output.json");
    expect(files).not.toContain("paper.pdf");
    expect(files.some((file) => file.startsWith(".git/") || file.includes("/.lake/"))).toBe(false);
    expect(check.result.paper!.texFiles).toEqual(["main.tex"]);
  });

  it("rejects a committed paper.pdf only when a paper is declared", () => {
    const declared = makeSubmission("lax-261", undefined, {
      "manifest.yaml": manifest("lax-261") + PAPER_BLOCK,
      "paper/main.tex": "x\n",
      "paper.pdf": "%PDF-1.5\n",
    });
    initializeGit(declared);
    const rejected = runStaticValidation(request("lax-261"), declared, RUNTIME);
    const generated = rejected.findings.violations.filter((finding) => finding.rule === "generated-files");
    expect(generated.map((finding) => finding.message)).toEqual(["generated file must not be committed: paper.pdf"]);

    const undeclared = makeSubmission("lax-261", undefined, { "paper.pdf": "%PDF-1.5\n" });
    initializeGit(undeclared);
    expect(runStaticValidation(request("lax-261"), undeclared, RUNTIME).findings.violations).toEqual([]);
  });

  it("rejects a missing folder, a missing entry file, and symlinks", () => {
    const missingFolder = makeSubmission("lax-261", undefined, {
      "manifest.yaml": manifest("lax-261") + PAPER_BLOCK,
    });
    initializeGit(missingFolder);
    const noFolder = runStaticValidation(request("lax-261"), missingFolder, RUNTIME);
    expect(noFolder.findings.violations).toEqual([
      { phase: "static", rule: "paper", message: "paper folder paper does not exist" },
    ]);
    expect(noFolder.result.paper).toBeUndefined();

    const missingMain = makeSubmission("lax-261", undefined, {
      "manifest.yaml": manifest("lax-261") + PAPER_BLOCK,
      "paper/other.tex": "x\n",
      "paper/main.tex/.keep": "",
    });
    initializeGit(missingMain);
    const noMain = runStaticValidation(request("lax-261"), missingMain, RUNTIME);
    expect(noMain.findings.violations.map((finding) => [finding.rule, finding.message])).toEqual([
      ["paper", "paper entry file main.tex is not a regular file under paper"],
    ]);

    const linked = makeSubmission("lax-261", undefined, {
      "manifest.yaml": manifest("lax-261") + PAPER_BLOCK,
      "paper/main.tex": "x\n",
      "shared/fig.pdf": "%PDF-1.5\n",
    });
    fs.symlinkSync(path.join("..", "shared", "fig.pdf"), path.join(linked, "paper", "fig.pdf"));
    initializeGit(linked);
    const symlinked = runStaticValidation(request("lax-261"), linked, RUNTIME);
    expect(symlinked.findings.violations.map((finding) => finding.message)).toEqual([
      "paper folder contains a symlink, which is not accepted: fig.pdf",
    ]);

    const linkedFolder = makeSubmission("lax-261", undefined, {
      "manifest.yaml": manifest("lax-261") + PAPER_BLOCK,
      "elsewhere/main.tex": "x\n",
    });
    fs.symlinkSync("elsewhere", path.join(linkedFolder, "paper"));
    initializeGit(linkedFolder);
    const viaLink = runStaticValidation(request("lax-261"), linkedFolder, RUNTIME);
    expect(viaLink.findings.violations.map((finding) => finding.message)).toEqual([
      "paper folder paper must be a plain directory and may not traverse a symlink",
    ]);
  });

  it("turns marker problems into paper-markers violations naming the file", () => {
    const root = makeSubmission("lax-261", undefined, {
      "manifest.yaml": manifest("lax-261") + PAPER_BLOCK,
      "paper/main.tex": "\\begin{document}\n% lax begin Lax261.Open\n\\input{section}\n\\end{document}\n",
      "paper/section.tex": "% lax stop\n% lax end\n",
    });
    initializeGit(root);
    const check = runStaticValidation(request("lax-261"), root, RUNTIME);
    expect(check.result.paper).toBeUndefined();
    expect(check.findings.violations.map((finding) => [finding.rule, finding.message])).toEqual([
      ["paper-markers", "paper/main.tex:2: marker Lax261.Open is never closed in this file"],
      ["paper-markers", "paper/section.tex:1: a `% lax` comment must be `% lax begin <id>` or `% lax end`"],
      ["paper-markers", "paper/section.tex:2: `lax end` with no open marker"],
    ]);
  });

  it("rewrites a marker inside verbatim textually and leaves the verdict to the PDF", () => {
    // the static gate knows nothing about TeX environments: the marker is
    // rewritten like any other, and the missing destination is the paper
    // phase's finding
    const root = makeSubmission("lax-261", undefined, {
      "manifest.yaml": manifest("lax-261") + PAPER_BLOCK,
      "paper/main.tex":
        "\\begin{document}\n\\begin{verbatim}\n% lax begin Lax261.Treewidth\ncode\n% lax end\n\\end{verbatim}\n\\end{document}\n",
    });
    initializeGit(root);
    const check = runStaticValidation(request("lax-261"), root, RUNTIME);
    expect(check.findings.violations).toEqual([]);
    expect(check.result.paper!.marks).toEqual([{ n: 1, id: "Lax261.Treewidth", file: "main.tex", line: 3 }]);
    expect(check.result.paper!.rewritten.get("main.tex")).toBe(
      "\\begin{document}\n\\begin{verbatim}\n\\laxmark{b}{1}%\ncode\n\\laxmark{e}{1}%\n\\end{verbatim}\n\\end{document}\n",
    );
  });

  it("reads .tex sources as latin1 so non-UTF-8 bytes survive the rewrite", () => {
    const root = makeSubmission("lax-261", undefined, {
      "manifest.yaml": manifest("lax-261") + PAPER_BLOCK,
    });
    const bytes = Buffer.concat([
      Buffer.from("% lax begin Lax261.Treewidth\nCaf", "latin1"),
      Buffer.from([0xe9]),
      Buffer.from("\n% lax end\n", "latin1"),
    ]);
    fs.mkdirSync(path.join(root, "paper"));
    fs.writeFileSync(path.join(root, "paper", "main.tex"), bytes);
    initializeGit(root);
    const check = runStaticValidation(request("lax-261"), root, RUNTIME);
    expect(check.findings.violations).toEqual([]);
    const rewritten = Buffer.from(check.result.paper!.rewritten.get("main.tex")!, "latin1");
    expect(rewritten).toEqual(
      Buffer.concat([
        Buffer.from("\\laxmark{b}{1}%\nCaf", "latin1"),
        Buffer.from([0xe9]),
        Buffer.from("\n\\laxmark{e}{1}%\n", "latin1"),
      ]),
    );
  });
});
