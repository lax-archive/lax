import { describe, expect, it } from "vitest";
import {
  parsePublishedCapture,
  parseSuccessfulValidationArtifacts,
} from "../../src/submission-validation/artifact-schema.js";
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
