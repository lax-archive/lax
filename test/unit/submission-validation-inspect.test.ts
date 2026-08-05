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
    fixture.concepts.declarations.push({
      name: "Lax1.Claim.second",
      userName: "Lax1.Claim.second",
      kind: "axiom",
      module: "Lax1.Claim",
      axioms: ["Lax1.Claim.second"],
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
      "one-statement",
      "axiom-hygiene",
      "frontmatter",
      "proof",
    ]) {
      expect(rules).toContain(rule);
    }
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
