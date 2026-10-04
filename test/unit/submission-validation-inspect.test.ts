import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LIMITS } from "../../src/submission-validation/config.js";
import { inspectorExitFailure, parseInspectorReport, runInspector } from "../../src/submission-validation/phases/inspect-runner.js";
import type {
  ContainerInvocation,
  ContainerResult,
  ValidationRunner,
} from "../../src/submission-validation/sandbox/container.js";
import type {
  InspectorReport,
  ModuleInventory,
  ParsedDoc,
  ResolutionResult,
} from "../../src/submission-validation/contracts.js";
import { emitBuildOutput } from "../../src/submission-validation/phases/emit.js";
import { judgeInspection } from "../../src/submission-validation/phases/inspect.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupTemporary,
  COMMIT,
  manifest,
  REPOSITORY,
  RUNTIME,
  staticResult,
  temporary,
  writeFile,
} from "../support/submission-validation.js";
import { validateManifest } from "../../src/submission-validation/validators/manifest.js";
import { FindingCollector } from "../../src/submission-validation/findings.js";
import { parseSuccessfulValidationArtifacts } from "../../src/submission-validation/artifact-schema.js";
import { successfulArtifacts, validationRequest } from "../support/validation-artifacts.js";

afterEach(cleanupTemporary);

const EMPTY_RESOLUTION: ResolutionResult = { concepts: [], proofs: [], all: [] };

function inventory(packageName: string, modules: string[]): ModuleInventory {
  const kind = packageName.endsWith("Proofs") ? "proofs" : "concepts";
  return {
    packageName,
    packageDir: kind,
    rootModule: packageName,
    modules,
    paths: new Map([
      [packageName, `${kind}/${packageName}.lean`],
      ...modules.map((module) => [module, `${kind}/${module.split(".").join("/")}.lean`] as const),
    ]),
  };
}

function document(
  scalars: Array<[string, string]>,
  description: string,
  lists: Array<[string, string[]]> = [],
): ParsedDoc {
  return { hasFrontmatter: true, scalars, lists, description };
}

function reports(): {
  concepts: InspectorReport;
  proofs: InspectorReport;
  conceptInventory: ModuleInventory;
  proofInventory: ModuleInventory;
} {
  const conceptInventory = inventory("Lax1", ["Lax1.Claim"]);
  const proofInventory = inventory("Lax1Proofs", ["Lax1Proofs.Basic"]);
  const concepts: InspectorReport = {
    modules: [
      { name: "Lax1", imports: ["Lax1.Claim"], moduleDocs: [], declCount: 0 },
      {
        name: "Lax1.Claim",
        imports: ["Mathlib"],
        moduleDocs: [
          document(
            [
              ["title", "The claim"],
              ["type", "theorem"],
            ],
            "The main description.\n\n# Review notes\n\nNothing to review.",
          ),
        ],
        declCount: 1,
      },
    ],
    declarations: [
      {
        name: "Lax1.Claim.statement",
        userName: "Lax1.Claim.statement",
        kind: "axiom",
        module: "Lax1.Claim",
        axioms: ["Lax1.Claim.statement"],
        usedConstants: [],
        signature: "True",
        startLine: 10,
        endLine: 11,
        doc: { hasFrontmatter: false, scalars: [], lists: [], description: "The statement." },
      },
    ],
  };
  const proofs: InspectorReport = {
    modules: [
      { name: "Lax1Proofs", imports: ["Lax1Proofs.Basic"], moduleDocs: [], declCount: 0 },
      {
        name: "Lax1Proofs.Basic",
        imports: ["Lax1.Claim"],
        moduleDocs: [],
        declCount: 1,
      },
    ],
    declarations: [
      {
        name: "Lax1Proofs.proof",
        userName: "Lax1Proofs.proof",
        kind: "theorem",
        module: "Lax1Proofs.Basic",
        axioms: [],
        usedConstants: [],
        doc: document(
          [["conclusion", "Lax1.Claim.statement"]],
          "Proof description.\n\n# Strategy\n\nBy construction.",
        ),
        conclusionFacts: {
          resolves: true,
          isAxiom: true,
          originModule: "Lax1.Claim",
          originReachable: true,
          defeq: true,
        },
      },
    ],
  };
  return { concepts, proofs, conceptInventory, proofInventory };
}

describe("inspection judgments retained from main", () => {
  it("derives concept and proof metadata from valid inspector reports", () => {
    const fixture = reports();
    const judged = judgeInspection(
      fixture.concepts,
      fixture.proofs,
      fixture.conceptInventory,
      fixture.proofInventory,
      EMPTY_RESOLUTION,
    );

    expect(judged.findings.violations).toEqual([]);
    expect(judged.result.concepts).toEqual([
      expect.objectContaining({
        id: "Lax1.Claim",
        title: "The claim",
        type: "theorem",
        description: "The main description.",
        sections: [{ title: "Review notes", markdown: "Nothing to review." }],
        statements: [
          expect.objectContaining({
            id: "Lax1.Claim.statement",
            signature: "statement : True",
            doc: "The statement.",
          }),
        ],
      }),
    ]);
    expect(judged.result.proofs).toEqual([
      expect.objectContaining({
        conclusion: "Lax1.Claim.statement",
        assumptions: [],
        description: "Proof description.",
        sections: [{ title: "Strategy", markdown: "By construction." }],
      }),
    ]);
  });

  it("deduplicates declarations reported by multiple modules", () => {
    const fixture = reports();
    fixture.concepts.declarations.push({ ...fixture.concepts.declarations[0]! });
    fixture.proofs.declarations.push({ ...fixture.proofs.declarations[0]! });

    const judged = judgeInspection(
      fixture.concepts,
      fixture.proofs,
      fixture.conceptInventory,
      fixture.proofInventory,
      EMPTY_RESOLUTION,
    );

    expect(judged.findings.violations).toEqual([]);
    expect(judged.result.concepts[0]?.statements).toHaveLength(1);
    expect(judged.result.proofs).toHaveLength(1);
  });

  it("accepts several statements in one concept module and a proof of either", () => {
    // The one-statement-per-concept gate (one-axiom-plan.md) is gone: a
    // concept module may declare any number of axioms, each of them a
    // first-class statement that a proof may conclude.
    const fixture = reports();
    fixture.concepts.modules[1]!.declCount = 2;
    fixture.concepts.declarations.push({
      name: "Lax1.Claim.second",
      userName: "Lax1.Claim.second",
      kind: "axiom",
      module: "Lax1.Claim",
      axioms: ["Lax1.Claim.second"],
      usedConstants: [],
      signature: "True",
      doc: { hasFrontmatter: false, scalars: [], lists: [], description: "The second statement." },
    });
    fixture.proofs.modules[1]!.declCount = 2;
    fixture.proofs.declarations.push({
      ...fixture.proofs.declarations[0]!,
      name: "Lax1Proofs.other",
      userName: "Lax1Proofs.other",
      doc: document([["conclusion", "Lax1.Claim.second"]], "Proof of the second statement."),
    });

    const judged = judgeInspection(
      fixture.concepts,
      fixture.proofs,
      fixture.conceptInventory,
      fixture.proofInventory,
      EMPTY_RESOLUTION,
    );

    expect(judged.findings.violations).toEqual([]);
    expect(judged.result.concepts).toHaveLength(1);
    expect(judged.result.concepts[0]?.statements.map((statement) => statement.id)).toEqual([
      "Lax1.Claim.statement",
      "Lax1.Claim.second",
    ]);
    // proofs come back sorted by declaration id: Lax1Proofs.other before
    // Lax1Proofs.proof
    expect(judged.result.proofs.map((proof) => proof.conclusion)).toEqual([
      "Lax1.Claim.second",
      "Lax1.Claim.statement",
    ]);
  });

  it("splits named sections, detects duplicates, and ignores fenced headings", () => {
    const duplicated = reports();
    duplicated.concepts.modules[1]!.moduleDocs[0]!.description =
      "leading\n# Description\nalso here\n# Notes\none\n# notes\ntwo";
    const judged = judgeInspection(
      duplicated.concepts,
      duplicated.proofs,
      duplicated.conceptInventory,
      duplicated.proofInventory,
      EMPTY_RESOLUTION,
    );
    const messages = judged.findings.violations.map((finding) => finding.message).join("\n");
    expect(messages).toContain("duplicate section notes");
    expect(messages).toContain("description is provided twice");
    expect(judged.result.concepts[0]?.description).toBe("leading");

    const fenced = reports();
    fenced.concepts.modules[1]!.moduleDocs[0]!.description =
      "text\n```lean\n# not a heading\n```\nmore";
    const fencedJudgment = judgeInspection(
      fenced.concepts,
      fenced.proofs,
      fenced.conceptInventory,
      fenced.proofInventory,
      EMPTY_RESOLUTION,
    );
    expect(fencedJudgment.findings.violations).toEqual([]);
    expect(fencedJudgment.result.concepts[0]?.description).toBe(
      "text\n```lean\n# not a heading\n```\nmore",
    );
    expect(fencedJudgment.result.concepts[0]?.sections).toBeUndefined();
  });

  it("warns about a docstring whose `---` line was not recognized as frontmatter", () => {
    // Mistyped frontmatter demotes a proof to a helper without any violation,
    // so the warning is the author's only signal that the proof went unseen.
    const fixture = reports();
    fixture.proofs.declarations[0]!.doc = {
      hasFrontmatter: false,
      scalars: [],
      lists: [],
      description: "conclusion Lax1.Claim.statement\n---\nThe proof.",
    };

    const judged = judgeInspection(
      fixture.concepts,
      fixture.proofs,
      fixture.conceptInventory,
      fixture.proofInventory,
      EMPTY_RESOLUTION,
    );

    expect(judged.findings.violations).toEqual([]);
    expect(judged.findings.warnings).toEqual([
      {
        phase: "inspect",
        rule: "frontmatter",
        message:
          "docstring of Lax1Proofs.proof contains a `---` line but was not recognized as " +
          "frontmatter (the lines above it do not parse as `key: value`)",
      },
      {
        phase: "inspect",
        rule: "unused-lemma",
        message:
          "helper lemma Lax1Proofs.proof is not used, directly or transitively, by any proof " +
          "theorem in this submission; keep it only if this is intentional",
      },
    ]);
    expect(judged.result.proofs).toEqual([]);

    const helper = reports();
    helper.proofs.declarations[0]!.doc = {
      hasFrontmatter: false,
      scalars: [],
      lists: [],
      description: "A genuine helper.",
    };
    const helperJudgment = judgeInspection(
      helper.concepts,
      helper.proofs,
      helper.conceptInventory,
      helper.proofInventory,
      EMPTY_RESOLUTION,
    );
    expect(helperJudgment.findings.warnings).toEqual([
      {
        phase: "inspect",
        rule: "unused-lemma",
        message:
          "helper lemma Lax1Proofs.proof is not used, directly or transitively, by any proof " +
          "theorem in this submission; keep it only if this is intentional",
      },
    ]);
    expect(helperJudgment.result.proofs).toEqual([]);
  });

  it("warns only for user-level helper lemmas unused by proof theorems", () => {
    const fixture = reports();
    fixture.proofs.declarations[0]!.usedConstants = ["Lax1Proofs.middle"];
    fixture.proofs.declarations.push(
      {
        name: "Lax1Proofs.middle",
        userName: "Lax1Proofs.middle",
        kind: "theorem",
        module: "Lax1Proofs.Basic",
        axioms: [],
        usedConstants: ["Lax1Proofs.leaf"],
      },
      {
        name: "Lax1Proofs.leaf",
        userName: "Lax1Proofs.leaf",
        kind: "theorem",
        module: "Lax1Proofs.Basic",
        axioms: [],
        usedConstants: [],
      },
      {
        name: "Lax1Proofs.unused",
        userName: "Lax1Proofs.unused",
        kind: "theorem",
        module: "Lax1Proofs.Basic",
        axioms: [],
        usedConstants: [],
      },
      {
        name: "Lax1Proofs.proof._generated",
        kind: "theorem",
        module: "Lax1Proofs.Basic",
        axioms: [],
        usedConstants: [],
      },
    );
    fixture.proofs.modules[1]!.declCount = fixture.proofs.declarations.length;

    const judged = judgeInspection(
      fixture.concepts,
      fixture.proofs,
      fixture.conceptInventory,
      fixture.proofInventory,
      EMPTY_RESOLUTION,
    );

    expect(judged.findings.violations).toEqual([]);
    expect(judged.findings.warnings).toEqual([
      {
        phase: "inspect",
        rule: "unused-lemma",
        message:
          "helper lemma Lax1Proofs.unused is not used, directly or transitively, by any proof " +
          "theorem in this submission; keep it only if this is intentional",
      },
    ]);
  });

  it("collects independent root, import, annotation, namespace, axiom, and proof failures", () => {
    const fixture = reports();
    fixture.concepts.modules[0]!.imports = [];
    fixture.concepts.modules[1]!.imports.push("Undeclared.Module");
    fixture.concepts.modules[1]!.moduleDocs = [];
    fixture.concepts.declarations[0]!.userName = "Elsewhere.bad";
    fixture.concepts.declarations[0]!.axioms.push("Forbidden.axiom");
    fixture.concepts.declarations[0]!.doc = document(
      [["conclusion", "Lax1.Claim.statement"]],
      "misplaced proof metadata",
    );
    // a second axiom in the same module: no longer a violation of its own,
    // and it must not suppress or duplicate any of the others
    fixture.concepts.declarations.push({
      name: "Lax1.Claim.second",
      userName: "Lax1.Claim.second",
      kind: "axiom",
      module: "Lax1.Claim",
      axioms: ["Lax1.Claim.second"],
      usedConstants: [],
      signature: "True",
    });
    const proof = fixture.proofs.declarations[0]!;
    proof.kind = "def";
    proof.userName = "Elsewhere.proof";
    proof.axioms = ["sorryAx"];
    proof.doc = document(
      [
        ["conclusion", "Lax1.Claim.statement"],
        ["foo", "unknown"],
      ],
      "bad proof",
      [["assumptions", ["Lax1.Claim.statement"]]],
    );
    proof.conclusionFacts = {
      resolves: false,
      isAxiom: false,
      originReachable: false,
      defeq: false,
    };

    const judged = judgeInspection(
      fixture.concepts,
      fixture.proofs,
      fixture.conceptInventory,
      fixture.proofInventory,
      EMPTY_RESOLUTION,
    );
    const rules = new Set(judged.findings.violations.map((finding) => finding.rule));
    for (const rule of [
      "root-module",
      "imports",
      "annotation",
      "namespace",
      "axiom-free",
      "axiom-hygiene",
      "frontmatter",
      "proof",
    ]) {
      expect(rules).toContain(rule);
    }
    expect(rules).not.toContain("one-statement");
  });

  it("keeps spec.md's reading for a private name — un-mangled, then tested — and carries no intent", () => {
    const fixture = reports();
    fixture.proofs.declarations.push({
      name: "_private.Lax1Proofs.Basic.0.hidden",
      userName: "hidden",
      kind: "theorem",
      module: "Lax1Proofs.Basic",
      axioms: [],
      usedConstants: [],
      signature: "True",
    });
    const judged = judgeInspection(
      fixture.concepts,
      fixture.proofs,
      fixture.conceptInventory,
      fixture.proofInventory,
      EMPTY_RESOLUTION,
    );
    expect(judged.findings.violations.map((finding) => `[${finding.rule}] ${finding.message}`))
      .toContain("[namespace] proof declaration hidden does not carry namespace Lax1Proofs");
    for (const finding of [...judged.findings.violations, ...judged.findings.warnings])
      expect(finding).not.toHaveProperty("intent");
  });

  it("names the offending import and the importable prefixes", () => {
    const fixture = reports();
    fixture.concepts.modules[1]!.imports.push("Batteries.Data.List.Basic");
    const judged = judgeInspection(
      fixture.concepts,
      fixture.proofs,
      fixture.conceptInventory,
      fixture.proofInventory,
      EMPTY_RESOLUTION,
    );
    const finding = judged.findings.violations.find((violation) => violation.rule === "imports");
    expect(finding?.message).toBe(
      "module Lax1.Claim imports undeclared package module Batteries.Data.List.Basic; " +
        "importable prefixes: Init, Lax1, Lean, Mathlib, Std",
    );
  });

  it("lists required dependency packages among the importable prefixes", () => {
    const fixture = reports();
    fixture.proofs.modules[1]!.imports.push("Batteries");
    const upstream = {
      packageName: "Lax2",
      submissionId: "lax-2",
      kind: "concepts" as const,
      source: { repository: REPOSITORY, commit: COMMIT, folder: "." },
      state: "registered" as const,
      statements: [],
      requiredPackages: [],
    };
    const resolution: ResolutionResult = { concepts: [], proofs: [upstream], all: [upstream] };
    const judged = judgeInspection(
      fixture.concepts,
      fixture.proofs,
      fixture.conceptInventory,
      fixture.proofInventory,
      resolution,
    );
    const finding = judged.findings.violations.find((violation) => violation.rule === "imports");
    expect(finding?.message).toBe(
      "module Lax1Proofs.Basic imports undeclared package module Batteries; " +
        "importable prefixes: Init, Lax1, Lax1Proofs, Lax2, Lean, Mathlib, Std",
    );
  });

  it("accepts inspected upstream statements and derives the exact assumption set", () => {
    const fixture = reports();
    fixture.proofs.declarations[0]!.axioms = ["Lax2.Upstream.statement"];
    fixture.proofs.declarations[0]!.doc!.lists = [
      ["assumptions", ["Lax2.Upstream.statement"]],
    ];
    const upstream = {
      packageName: "Lax2",
      submissionId: "lax-2",
      kind: "concepts" as const,
      source: { repository: REPOSITORY, commit: COMMIT, folder: "." },
      state: "registered" as const,
      statements: ["Lax2.Upstream.statement"],
      requiredPackages: [],
    };
    const resolution: ResolutionResult = { concepts: [], proofs: [upstream], all: [upstream] };

    const judged = judgeInspection(
      fixture.concepts,
      fixture.proofs,
      fixture.conceptInventory,
      fixture.proofInventory,
      resolution,
    );
    expect(judged.findings.violations).toEqual([]);
    expect(judged.result.proofs[0]?.assumptions).toEqual(["Lax2.Upstream.statement"]);
  });

  it("supports concepts-only inspection without requiring a proof report", () => {
    const fixture = reports();
    const judged = judgeInspection(
      fixture.concepts,
      undefined,
      fixture.conceptInventory,
      undefined,
      EMPTY_RESOLUTION,
      "concepts",
    );
    expect(judged.findings.violations).toEqual([]);
    expect(judged.result.proofs).toEqual([]);
  });

  it("emits deterministic dependency lists and source text", () => {
    const root = temporary("lax-emit-");
    writeFile(root, "concepts/Lax1/Claim.lean", "line one\r\nline two\r\n");
    const fixture = reports();
    const inspected = judgeInspection(
      fixture.concepts,
      fixture.proofs,
      fixture.conceptInventory,
      fixture.proofInventory,
      EMPTY_RESOLUTION,
    );
    const checkedManifest = new FindingCollector("static");
    const parsedManifest = validateManifest(manifest("lax-1"), "lax-1", RUNTIME, checkedManifest)!;
    expect(checkedManifest.violations).toEqual([]);
    const checked = staticResult("lax-1");
    checked.manifest = parsedManifest;
    checked.abstract = "Abstract.\n";
    checked.concepts!.inventory = fixture.conceptInventory;
    checked.proofs!.inventory = fixture.proofInventory;
    checked.concepts!.lakefile.gitRequires = [
      { name: "Lax9", git: REPOSITORY, rev: COMMIT, subDir: "nine/concepts" },
      { name: "Lax2", git: REPOSITORY, rev: COMMIT, subDir: "two/concepts" },
    ];

    const output = emitBuildOutput(root, checked, inspected.result, {
      formatVersion: 1,
      digest: "d".repeat(64),
      sourceCommit: COMMIT,
      leanToolchain: RUNTIME.leanToolchain,
      mathlibCommit: RUNTIME.mathlibCommit,
      files: [],
    });
    expect(output.requiredByConcepts).toEqual(["Lax2", "Lax9"]);
    expect(output.concepts[0]?.sourceText).toBe("line one\nline two\n");
  });
});

describe("the archive name grammar under spec 1", () => {
  // One name grammar for both specs (ultracode review 2026-10-04, C3): a
  // statement or proof the classifier admits must parse under the
  // publication schema — a name refused there instead is a non-retryable
  // infrastructure failure after validation passed — and one it refuses is
  // a finding. Spec 1 prints names with Lean's escaped `Name.toString` too.
  it("records every name the schema admits and refuses every other one as a finding", () => {
    const admitted = ["good?", "main!", "℘", "h₁", "étale", "α'", "_x"];
    const refused = ["«定理»", "«A.B»", "«λ»", "«1st»"];
    for (const component of [...admitted, ...refused]) {
      const fixture = reports();
      const statementId = `Lax1.Claim.${component}`;
      const proofId = `Lax1Proofs.${component}`;
      Object.assign(fixture.concepts.declarations[0]!, { name: statementId, userName: statementId, axioms: [statementId] });
      const proof = fixture.proofs.declarations[0]!;
      Object.assign(proof, { name: proofId, userName: proofId, doc: { ...proof.doc!, scalars: [["conclusion", statementId]] } });
      const judged = judgeInspection(
        fixture.concepts,
        fixture.proofs,
        fixture.conceptInventory,
        fixture.proofInventory,
        EMPTY_RESOLUTION,
      );
      if (refused.includes(component)) {
        expect(judged.result.concepts.flatMap((concept) => concept.statements), component).toEqual([]);
        expect(judged.result.proofs, component).toEqual([]);
        expect(judged.findings.violations.map((finding) => `[${finding.rule}] ${finding.message}`), component).toEqual(
          expect.arrayContaining([
            expect.stringContaining(`[statement] statement ${statementId}: its name is not a plain Lean identifier`),
            expect.stringContaining(`[proof] proof ${proofId}: its name is not a plain Lean identifier`),
          ]),
        );
        for (const finding of judged.findings.violations) expect(finding).not.toHaveProperty("intent");
        continue;
      }
      expect(judged.findings.violations, component).toEqual([]);
      const artifacts = successfulArtifacts();
      artifacts.buildOutput.concepts = judged.result.concepts.map((concept) => ({ ...concept, sourceText: "axiom x : True\n" }));
      artifacts.buildOutput.proofs = judged.result.proofs;
      artifacts.report.buildOutput = artifacts.buildOutput;
      expect(() =>
        parseSuccessfulValidationArtifacts(artifacts.report, structuredClone(artifacts.buildOutput), validationRequest(), artifacts.report.runtime),
      component).not.toThrow();
    }
  });
});

describe("inspector report size bound", () => {
  // A stand-in inspector that writes a report of the requested size into the
  // output mount, the way the real container does; the bytes are valid JSON
  // padded with whitespace so only the size check can reject them.
  function inspectorWriting(bytes: number): ValidationRunner {
    return {
      async run(invocation: ContainerInvocation): Promise<ContainerResult> {
        const out = invocation.mounts!.find((mount) => mount.target === "/out")!.source;
        const report = '{"modules":[],"declarations":[]}';
        fs.writeFileSync(path.join(out, "report.json"), report.padEnd(bytes, " "));
        return { code: 0, output: "", timedOut: false };
      },
      async verifyRuntime(): Promise<void> {},
      async verifyImage(): Promise<void> {},
    };
  }

  function inspect(bytes: number, inspectorReportBytes: number): Promise<InspectorReport> {
    const jobDir = temporary();
    return runInspector(
      "proofs",
      jobDir,
      inventory("LaxProofs", []),
      EMPTY_RESOLUTION,
      jobDir,
      path.join(jobDir, "deps"),
      inspectorWriting(bytes),
      { ...DEFAULT_LIMITS, inspectorReportBytes },
      1,
    );
  }

  it("reads a report up to the configured limit", async () => {
    const report = await inspect(256, 256);
    expect(report).toEqual({ modules: [], declarations: [] });
  });

  it("rejects a report above the limit as an infrastructure failure, not a finding", async () => {
    await expect(inspect(257, 256)).rejects.toThrow(/proofs inspector report is missing or oversized/);
  });

  it("classifies a non-zero inspector exit: Lean's refusal of the package's own oleans is the author's under spec 2, the rest the archive's", () => {
    const refusal = { code: 1, output: "uncaught exception: import Lax1Proofs.B failed, environment already contains 'Lax1Proofs.x' from Lax1Proofs.A" };
    const spec2 = inspectorExitFailure("proofs", refusal, 2);
    expect(spec2).toMatchObject({ kind: "submission", finding: { rule: "olean-unreadable", intent: "standards" } });
    expect(spec2.message).toContain("environment already contains");
    // spec 1 replayed the proof oleans first; the inspector's refusal stays the archive's there
    expect(inspectorExitFailure("proofs", refusal, 1)).toMatchObject({ kind: "infrastructure" });
    // a module missing from the composed path is the archive's under either spec
    expect(inspectorExitFailure("proofs", { code: 1, output: "object file './Lax1Proofs.olean' of module Lax1Proofs does not exist" }, 2)).toMatchObject({ kind: "infrastructure" });
    // and so is anything the pattern does not name
    expect(inspectorExitFailure("concepts", { code: 2, output: "module Lax1.Claim not found in the built environment" }, 2)).toMatchObject({ kind: "infrastructure" });
    expect(inspectorExitFailure("concepts", { code: 2, output: "constant Lax1.Claim.x of module Lax1.Claim not found" }, 2)).toMatchObject({ kind: "submission" });
    // the shapes a truncated capture or a toolchain mismatch produce are the
    // archive's, not a finding against the author (verification review)
    for (const output of [
      "failed to read file './Lax1Proofs.olean', invalid header",
      "incompatible header in './Lax1Proofs.olean'",
      "'./Lax1Proofs.olean' is not a valid .olean file",
      "missing data file for module Lax1Proofs.A",
    ]) {
      expect(inspectorExitFailure("proofs", { code: 1, output }, 2), output).toMatchObject({ kind: "infrastructure" });
    }
  });

  it("admits the largest real report: Lax17's 49 MB", () => {
    // 405 modules, 38k declarations, 396k package-local dependency edges,
    // measured 2026-09-16 (the pretty-printed report was 49,440,510 bytes).
    expect(DEFAULT_LIMITS.inspectorReportBytes).toBeGreaterThanOrEqual(64 * 1024 * 1024);
  });
});

describe("inspector report shape", () => {
  // The spec-2 golden report, as the real inspector writes it; a telescope
  // entry is exactly a constant and its levels, so a report that still names
  // a binder kind is refused rather than read past.
  const golden = (): { declarations: Array<Record<string, any>> } =>
    JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "inspector-golden-spec2", "expected.json"), "utf8"));
  const withTelescope = (report: ReturnType<typeof golden>) => {
    const index = report.declarations.findIndex((declaration) => declaration.telescope?.hypotheses.length > 0);
    return { index, telescope: report.declarations[index]!.telescope };
  };

  it("reads the golden spec-2 report", () => {
    expect(withTelescope(golden()).index).toBeGreaterThanOrEqual(0);
    expect(() => parseInspectorReport(golden(), 2)).not.toThrow();
  });

  it("refuses a telescope entry that still carries a binder kind", () => {
    const hypothesis = golden();
    const { index, telescope } = withTelescope(hypothesis);
    telescope.hypotheses[0].binder = "default";
    expect(() => parseInspectorReport(hypothesis, 2)).toThrow(`inspector declaration ${index} telescope hypothesis 0 has an invalid shape`);
    const conclusion = golden();
    withTelescope(conclusion).telescope.conclusion.binder = "default";
    expect(() => parseInspectorReport(conclusion, 2)).toThrow(`inspector declaration ${index} telescope conclusion has an invalid shape`);
  });

  it("reads a link's nonCanonical flag, and only as true", () => {
    const flagged = golden();
    const { index, telescope } = withTelescope(flagged);
    telescope.hypotheses[0].nonCanonical = true;
    expect(parseInspectorReport(flagged, 2).declarations[index]!.telescope!.hypotheses[0]!.nonCanonical).toBe(true);
    expect(parseInspectorReport(golden(), 2).declarations[index]!.telescope!.hypotheses[0]).not.toHaveProperty("nonCanonical");
    const malformed = golden();
    withTelescope(malformed).telescope.conclusion.nonCanonical = false;
    expect(() => parseInspectorReport(malformed, 2)).toThrow(`inspector declaration ${index} telescope conclusion nonCanonical must be true when present`);
  });
});
