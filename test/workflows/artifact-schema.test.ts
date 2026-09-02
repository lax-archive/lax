import { describe, expect, it } from "vitest";
import {
  parsePaperOutput,
  parsePublishedCapture,
  parseSuccessfulValidationArtifacts,
} from "../../src/submission-validation/artifact-schema.js";
import { PAPER_CAPS } from "../../src/submission-validation/config.js";
import type { PaperManifest, PaperOutput } from "../../src/submission-validation/contracts.js";
import {
  successfulArtifacts,
  TEST_CAPTURE,
  TEST_RUNTIME,
  validationRequest,
} from "../support/validation-artifacts.js";

describe("trusted validation artifact parser", () => {
  it("accepts one exact successful artifact set", () => {
    const fixture = successfulArtifacts();
    expect(
      parseSuccessfulValidationArtifacts(
        fixture.report,
        fixture.buildOutput,
        validationRequest(),
        TEST_RUNTIME,
      ),
    ).toEqual(fixture);
  });

  it("accepts a generated manifest with no authors", () => {
    const fixture = successfulArtifacts();
    fixture.report.buildOutput.inputs.manifest.authors = [];

    expect(
      parseSuccessfulValidationArtifacts(
        fixture.report,
        fixture.buildOutput,
        validationRequest(),
        TEST_RUNTIME,
      ).buildOutput.inputs.manifest.authors,
    ).toEqual([]);
  });

  it("re-validates a supersedes claim as a canonical foreign submission id", () => {
    const fixture = successfulArtifacts();
    fixture.buildOutput.inputs.manifest.supersedes = "lax-7";
    expect(
      parseSuccessfulValidationArtifacts(
        fixture.report,
        fixture.buildOutput,
        validationRequest(),
        TEST_RUNTIME,
      ).buildOutput.inputs.manifest.supersedes,
    ).toBe("lax-7");

    for (const [supersedes, expected] of [
      ["Lax7", "must match lax-<positive decimal>"],
      [7 as unknown as string, "must be a string"],
      ["lax-42", "cannot supersede its own submission"],
    ] as const) {
      const invalid = successfulArtifacts();
      invalid.buildOutput.inputs.manifest.supersedes = supersedes;
      expect(() =>
        parseSuccessfulValidationArtifacts(
          invalid.report,
          invalid.buildOutput,
          validationRequest(),
          TEST_RUNTIME,
        ),
      ).toThrow(expected);
    }
  });

  it("accepts a concept declaring several statements", () => {
    // The parser used to cap `statements` at one entry, mirroring the
    // one-statement-per-concept gate; that gate is gone (rewrite.md,
    // "multiple statements per concept") and the bound is now just a size cap.
    const fixture = successfulArtifacts();
    fixture.buildOutput.concepts.push({
      id: "Lax42.Two",
      path: "concepts/Lax42/Two.lean",
      title: "Two",
      type: "theorem",
      description: "A concept with two statements.",
      imports: [],
      mathlibImports: [],
      sourceText: "",
      statements: [
        { id: "Lax42.Two.claimA", signature: "claimA : True" },
        { id: "Lax42.Two.claimB", signature: "claimB : True" },
      ],
    });

    const parsed = parseSuccessfulValidationArtifacts(
      fixture.report,
      fixture.buildOutput,
      validationRequest(),
      TEST_RUNTIME,
    );
    expect(parsed.buildOutput.concepts[0]!.statements.map((statement) => statement.id)).toEqual([
      "Lax42.Two.claimA",
      "Lax42.Two.claimB",
    ]);
  });

  it("rejects unknown trusted fields and any standalone/report mismatch", () => {
    const unknown = successfulArtifacts();
    (unknown.report as unknown as Record<string, unknown>).extra = true;
    expect(() =>
      parseSuccessfulValidationArtifacts(unknown.report, unknown.buildOutput, validationRequest(), TEST_RUNTIME),
    ).toThrow("must contain exactly");

    const trusted = successfulArtifacts();
    (trusted.buildOutput as unknown as Record<string, unknown>).issue = { repositoryId: 1, number: 42 };
    expect(() =>
      parseSuccessfulValidationArtifacts(trusted.report, trusted.buildOutput, validationRequest(), TEST_RUNTIME),
    ).toThrow("must contain exactly");

    const mismatch = successfulArtifacts();
    const standalone = structuredClone(mismatch.buildOutput);
    standalone.inputs.abstract = "Different\n";
    expect(() =>
      parseSuccessfulValidationArtifacts(mismatch.report, standalone, validationRequest(), TEST_RUNTIME),
    ).toThrow("does not exactly match");
  });

  it("cross-checks request, runtime, provenance, and dependency closure", () => {
    const wrongRequest = successfulArtifacts();
    expect(() =>
      parseSuccessfulValidationArtifacts(
        wrongRequest.report,
        wrongRequest.buildOutput,
        { ...validationRequest(), archiveSha: "b".repeat(40) },
        TEST_RUNTIME,
      ),
    ).toThrow("authorized submit request");

    const wrongRuntime = successfulArtifacts();
    expect(() =>
      parseSuccessfulValidationArtifacts(
        wrongRuntime.report,
        wrongRuntime.buildOutput,
        validationRequest(),
        { ...TEST_RUNTIME, layoutVersion: 2 },
      ),
    ).toThrow("pinned runtime");

    const missingDependency = successfulArtifacts();
    missingDependency.buildOutput.requiredByConcepts.push("Lax7");
    expect(() =>
      parseSuccessfulValidationArtifacts(
        missingDependency.report,
        missingDependency.buildOutput,
        validationRequest(),
        TEST_RUNTIME,
      ),
    ).toThrow("dependency Lax7 is missing");
  });

  it("rejects empty captures, non-normalized titles, controls, and oversized fields", () => {
    const empty = successfulArtifacts();
    empty.report.capture.files = [];
    empty.report.buildOutput.capture.files = [];
    expect(() =>
      parseSuccessfulValidationArtifacts(empty.report, empty.buildOutput, validationRequest(), TEST_RUNTIME),
    ).toThrow("must not be empty");

    const title = successfulArtifacts();
    title.report.buildOutput.inputs.manifest.title = "  Not normalized  ";
    expect(() =>
      parseSuccessfulValidationArtifacts(title.report, title.buildOutput, validationRequest(), TEST_RUNTIME),
    ).toThrow("title is not normalized");

    const control = successfulArtifacts();
    control.report.buildOutput.inputs.abstract = "unsafe\u0000text";
    expect(() =>
      parseSuccessfulValidationArtifacts(control.report, control.buildOutput, validationRequest(), TEST_RUNTIME),
    ).toThrow("forbidden Unicode");

    const oversized = successfulArtifacts();
    oversized.report.buildOutput.inputs.manifest.authors[0]!.name = "a".repeat(513);
    expect(() =>
      parseSuccessfulValidationArtifacts(oversized.report, oversized.buildOutput, validationRequest(), TEST_RUNTIME),
    ).toThrow("exceeds 512 UTF-8 bytes");
  });

  it("rejects artifact identifiers that are not canonical Lean names", () => {
    const artifact = successfulArtifacts();
    artifact.buildOutput.concepts.push({
      id: "Lax42Proofs.x/../../../index",
      path: "concepts/Lax42/Unsafe.lean",
      title: "Unsafe",
      type: "definition",
      description: "An unsafe artifact identifier.",
      imports: [],
      mathlibImports: [],
      sourceText: "",
      statements: [],
    });
    expect(() =>
      parseSuccessfulValidationArtifacts(artifact.report, artifact.buildOutput, validationRequest(), TEST_RUNTIME),
    ).toThrow("generated concept 1 id must be a canonical Lean name");
  });
});

describe("published capture reference", () => {
  const published = (registryBlob: unknown): unknown => ({
    ...TEST_CAPTURE,
    registryBlob,
  });

  it("accepts only a ghcr blob address carrying the record's own digest", () => {
    expect(
      parsePublishedCapture(published(`ghcr.io/lax-archive/lax-captures@sha256:${TEST_CAPTURE.digest}`)),
    ).toMatchObject({ registryBlob: expect.stringContaining("ghcr.io/") });
    // Consumers never fetch by tag, and never by a digest other than the one
    // this record declares.
    expect(() => parsePublishedCapture(published("ghcr.io/lax-archive/lax-captures:cap-a-tag")))
      .toThrow("not a ghcr digest reference");
    expect(() => parsePublishedCapture(published(`ghcr.io/lax-archive/lax-captures@sha256:${"9".repeat(64)}`)))
      .toThrow("does not match the capture digest");
    expect(() => parsePublishedCapture(published(`https://ghcr.io/lax-archive/lax-captures@sha256:${TEST_CAPTURE.digest}`)))
      .toThrow("not a ghcr digest reference");
    expect(() => parsePublishedCapture(published(`docker.io/lax-archive/lax-captures@sha256:${TEST_CAPTURE.digest}`)))
      .toThrow("not a ghcr digest reference");
    expect(() => parsePublishedCapture(published(undefined))).toThrow("must be a string");
  });
});

describe("paper build output", () => {
  const PAPER_MANIFEST: PaperManifest = { folder: "paper", main: "main.tex", engine: "pdflatex" };
  const PDF_DIGEST = "6".repeat(64);
  const BLOB = `ghcr.io/lax-archive/lax-captures@sha256:${PDF_DIGEST}`;

  function paperOutput(): PaperOutput {
    return {
      folder: "paper",
      main: "main.tex",
      engine: "pdflatex",
      pdf: { digest: PDF_DIGEST, bytes: 12_345, pages: 2 },
      pageSizes: [[612, 792], [612, 792]],
      marks: [
        {
          id: "Lax42.Foo",
          kind: "concept",
          begin: { page: 1, x: 72, y: 700.5, mode: "v" },
          end: { page: 2, x: 300, y: -1.25, mode: "h" },
        },
        {
          id: "Lax7Proofs.Main",
          kind: "proof",
          begin: { page: 2, x: 72, y: 500, mode: "h" },
          end: { page: 2, x: 72, y: 500, mode: "h" },
        },
      ],
    };
  }

  /** The fixture as untrusted JSON, so a test can misspell any part of it. */
  function loose(mutate: (paper: Record<string, unknown>) => void = () => {}): unknown {
    const value = structuredClone(paperOutput()) as unknown as Record<string, unknown>;
    mutate(value);
    return value;
  }

  it("accepts the validate job's shape without a registry blob", () => {
    expect(parsePaperOutput(paperOutput(), PAPER_MANIFEST, false)).toEqual(paperOutput());
  });

  it("requires the published shape to carry the PDF's own ghcr digest, and the validate shape not to", () => {
    const published = paperOutput();
    published.pdf.registryBlob = BLOB;
    expect(parsePaperOutput(published, PAPER_MANIFEST, true)).toEqual(published);

    expect(() => parsePaperOutput(paperOutput(), PAPER_MANIFEST, true)).toThrow("generated paper pdf must contain exactly");
    expect(() => parsePaperOutput(published, PAPER_MANIFEST, false)).toThrow("generated paper pdf must contain exactly");

    for (const [registryBlob, expected] of [
      [`ghcr.io/lax-archive/lax-captures@sha256:${"9".repeat(64)}`, "does not match the pdf digest"],
      ["ghcr.io/lax-archive/lax-captures:paper-tag", "not a ghcr digest reference"],
      [`docker.io/lax-archive/lax-captures@sha256:${PDF_DIGEST}`, "not a ghcr digest reference"],
      [42, "registryBlob must be a string"],
    ] as const) {
      expect(() =>
        parsePaperOutput(
          loose((paper) => {
            (paper.pdf as Record<string, unknown>).registryBlob = registryBlob;
          }),
          PAPER_MANIFEST,
          true,
        ),
      ).toThrow(expected);
    }
  });

  it("requires the output to repeat the manifest's paper block", () => {
    expect(() => parsePaperOutput(paperOutput(), { ...PAPER_MANIFEST, folder: "." }, false)).toThrow(
      "does not repeat the manifest's paper block",
    );
    expect(() => parsePaperOutput(paperOutput(), { ...PAPER_MANIFEST, main: "paper.tex" }, false)).toThrow(
      "does not repeat the manifest's paper block",
    );
    expect(() => parsePaperOutput(paperOutput(), { ...PAPER_MANIFEST, engine: "xelatex" }, false)).toThrow(
      "does not repeat the manifest's paper block",
    );
    expect(() => parsePaperOutput(loose((paper) => { paper.engine = "latex"; }), PAPER_MANIFEST, false)).toThrow(
      "engine is invalid",
    );
    expect(() => parsePaperOutput(loose((paper) => { paper.extra = 1; }), PAPER_MANIFEST, false)).toThrow(
      "generated paper must contain exactly",
    );
  });

  it("rejects marks that do not fit the PDF or their own id", () => {
    const mark = (paper: Record<string, unknown>): Record<string, unknown> =>
      (paper.marks as Record<string, unknown>[])[0]!;
    expect(() =>
      parsePaperOutput(loose((paper) => { (mark(paper).end as Record<string, unknown>).page = 3; }), PAPER_MANIFEST, false),
    ).toThrow("generated paper mark 1 end page is beyond the last page");
    expect(() =>
      parsePaperOutput(loose((paper) => { (mark(paper).begin as Record<string, unknown>).page = 0; }), PAPER_MANIFEST, false),
    ).toThrow("generated paper mark 1 begin page must be a positive integer");
    expect(() =>
      parsePaperOutput(loose((paper) => { mark(paper).kind = "proof"; }), PAPER_MANIFEST, false),
    ).toThrow("generated paper mark 1 kind does not match its id");
    expect(() =>
      parsePaperOutput(loose((paper) => { mark(paper).kind = "statement"; }), PAPER_MANIFEST, false),
    ).toThrow("generated paper mark 1 kind is invalid");
    expect(() =>
      parsePaperOutput(loose((paper) => { mark(paper).id = "Mathlib.Order.Basic"; }), PAPER_MANIFEST, false),
    ).toThrow("generated paper mark 1 id: `Mathlib.Order.Basic` does not belong to a Lax package");
    expect(() =>
      parsePaperOutput(loose((paper) => { mark(paper).id = "Lax42"; }), PAPER_MANIFEST, false),
    ).toThrow("generated paper mark 1 id: `Lax42` is a package name");
    expect(() =>
      parsePaperOutput(loose((paper) => { mark(paper).id = "lax-42"; }), PAPER_MANIFEST, false),
    ).toThrow("generated paper mark 1 kind does not match its id");
    expect(() =>
      parsePaperOutput(loose((paper) => { mark(paper).id = "lax-042"; mark(paper).kind = "submission"; }), PAPER_MANIFEST, false),
    ).toThrow("generated paper mark 1 id: `lax-042` is neither a Lean name nor a submission id");
    const submission = parsePaperOutput(
      loose((paper) => { mark(paper).id = "lax-42"; mark(paper).kind = "submission"; }),
      PAPER_MANIFEST,
      false,
    );
    expect(submission.marks[0]).toMatchObject({ id: "lax-42", kind: "submission" });
    expect(() =>
      parsePaperOutput(loose((paper) => { (mark(paper).end as Record<string, unknown>).mode = "m"; }), PAPER_MANIFEST, false),
    ).toThrow("generated paper mark 1 end mode is invalid");
    expect(() =>
      parsePaperOutput(loose((paper) => { (mark(paper).end as Record<string, unknown>).x = Number.NaN; }), PAPER_MANIFEST, false),
    ).toThrow("generated paper mark 1 end x must be a finite number");
  });

  it("rejects oversized PDFs, page counts, page tables, and mark tables", () => {
    const pdf = (paper: Record<string, unknown>): Record<string, unknown> => paper.pdf as Record<string, unknown>;
    expect(() =>
      parsePaperOutput(loose((paper) => { pdf(paper).bytes = PAPER_CAPS.pdfBytes + 1; }), PAPER_MANIFEST, false),
    ).toThrow(`generated paper pdf exceeds ${PAPER_CAPS.pdfBytes} bytes`);
    expect(() =>
      parsePaperOutput(loose((paper) => { pdf(paper).pages = PAPER_CAPS.pages + 1; }), PAPER_MANIFEST, false),
    ).toThrow(`generated paper pdf exceeds ${PAPER_CAPS.pages} pages`);
    expect(() =>
      parsePaperOutput(loose((paper) => { pdf(paper).pages = 3; }), PAPER_MANIFEST, false),
    ).toThrow("pageSizes must have one entry per page");
    expect(() =>
      parsePaperOutput(loose((paper) => { (paper.pageSizes as unknown[])[1] = [612, 0]; }), PAPER_MANIFEST, false),
    ).toThrow("generated paper page size 2 height must be positive");
    expect(() =>
      parsePaperOutput(
        loose((paper) => {
          paper.marks = Array.from({ length: PAPER_CAPS.marks + 1 }, () => structuredClone(paperOutput().marks[0]));
        }),
        PAPER_MANIFEST,
        false,
      ),
    ).toThrow(`generated paper marks contains more than ${PAPER_CAPS.marks} entries`);
    expect(() =>
      parsePaperOutput(loose((paper) => { pdf(paper).digest = "abc"; }), PAPER_MANIFEST, false),
    ).toThrow("generated paper pdf digest must be a lowercase SHA-256 digest");
  });

  it("carries a paper through the successful artifact set exactly when the manifest declares one", () => {
    const fixture = successfulArtifacts();
    fixture.buildOutput.inputs.manifest.paper = { ...PAPER_MANIFEST };
    fixture.buildOutput.paper = paperOutput();
    expect(
      parseSuccessfulValidationArtifacts(fixture.report, fixture.buildOutput, validationRequest(), TEST_RUNTIME),
    ).toEqual(fixture);

    const missing = successfulArtifacts();
    missing.buildOutput.inputs.manifest.paper = { ...PAPER_MANIFEST };
    expect(() =>
      parseSuccessfulValidationArtifacts(missing.report, missing.buildOutput, validationRequest(), TEST_RUNTIME),
    ).toThrow("must carry a paper exactly when the manifest declares one");

    const undeclared = successfulArtifacts();
    undeclared.buildOutput.paper = paperOutput();
    expect(() =>
      parseSuccessfulValidationArtifacts(undeclared.report, undeclared.buildOutput, validationRequest(), TEST_RUNTIME),
    ).toThrow("must carry a paper exactly when the manifest declares one");

    const mismatch = successfulArtifacts();
    mismatch.buildOutput.inputs.manifest.paper = { ...PAPER_MANIFEST, engine: "lualatex" };
    mismatch.buildOutput.paper = paperOutput();
    expect(() =>
      parseSuccessfulValidationArtifacts(mismatch.report, mismatch.buildOutput, validationRequest(), TEST_RUNTIME),
    ).toThrow("does not repeat the manifest's paper block");

    // the validate job never has the registry address; only the publisher adds it
    const early = successfulArtifacts();
    early.buildOutput.inputs.manifest.paper = { ...PAPER_MANIFEST };
    early.buildOutput.paper = { ...paperOutput(), pdf: { digest: PDF_DIGEST, bytes: 12_345, pages: 2, registryBlob: BLOB } };
    expect(() =>
      parseSuccessfulValidationArtifacts(early.report, early.buildOutput, validationRequest(), TEST_RUNTIME),
    ).toThrow("generated paper pdf must contain exactly");

    const badManifestBlock = successfulArtifacts();
    badManifestBlock.buildOutput.inputs.manifest.paper = { folder: "paper", main: "main.tex" } as PaperManifest;
    badManifestBlock.buildOutput.paper = paperOutput();
    expect(() =>
      parseSuccessfulValidationArtifacts(badManifestBlock.report, badManifestBlock.buildOutput, validationRequest(), TEST_RUNTIME),
    ).toThrow("generated manifest paper must contain exactly");
  });
});
