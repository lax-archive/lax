import { describe, expect, it } from "vitest";
import { parseSuccessfulValidationArtifacts } from "../../src/submission-validation/artifact-schema.js";
import {
  successfulArtifacts,
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
    ).toThrow("authorized update request");

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
});
