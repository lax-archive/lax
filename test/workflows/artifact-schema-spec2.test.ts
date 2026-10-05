// The trusted parser on a spec-2 record (recorded-shape.ts; axiomfree-plan.md
// stage 3): the stored shape drops what a reader derives and the parser
// restores it — and refuses a stored copy — while the `certificate` block is
// held to the generator's own Challenge for the record's telescopes, which
// is the check a hand-edited bundle must fail.

import { describe, expect, it } from "vitest";
import {
  parsePublishedBuildOutputPayload,
  parseSuccessfulValidationArtifacts,
} from "../../src/submission-validation/artifact-schema.js";
import { certifiedProofs, challengeText } from "../../src/submission-validation/certify/generate.js";
import { expandRecordedBuildOutput, recordedBuildOutput } from "../../src/submission-validation/recorded-shape.js";
import { spec2TestEnvironment, withTestEnvironments } from "../support/environments.js";
import { spec2Artifacts, successfulArtifacts, validationRequest } from "../support/validation-artifacts.js";

/** A stored (recorded) copy of the fixture, as the validate job writes it. */
function stored() {
  const artifacts = spec2Artifacts();
  const recorded = recordedBuildOutput(artifacts.buildOutput);
  return {
    artifacts,
    report: { ...artifacts.report, buildOutput: recorded },
    buildOutput: JSON.parse(JSON.stringify(recorded)) as Record<string, any>,
  };
}

const parse = (report: unknown, buildOutput: unknown, runtime = spec2Artifacts().report.runtime) =>
  parseSuccessfulValidationArtifacts(report, buildOutput, validationRequest(), runtime);

describe("the trusted parser on a spec-2 record", () => {
  it("stores the telescope, the certificate, and no derivable field, and parses back to the full payload", () => {
    withTestEnvironments([spec2TestEnvironment()], () => {
      const { artifacts, report, buildOutput } = stored();
      // what the record stores
      expect(buildOutput.inputs.manifest).not.toHaveProperty("id");
      expect(buildOutput.capture).not.toHaveProperty("leanToolchain");
      expect(buildOutput.capture).not.toHaveProperty("mathlibCommit");
      expect(buildOutput.capture).not.toHaveProperty("files");
      expect(buildOutput.capture).toMatchObject({ bytes: 3, fileCount: 1, references: { digest: "f".repeat(64), bytes: 10_240 } });
      expect(Object.keys(buildOutput.proofs[0])).toEqual(["id", "path", "levelParams", "telescope", "description"]);
      expect(Object.keys(buildOutput.certificate)).toEqual(["judge", "kernels", "bundle", "challengeExportSha256", "solutionExportSha256", "challenge"]);
      expect(Object.keys(buildOutput.certificate.judge)).toEqual(["selfTest", "tools"]);
      // and what the code holds again
      const parsed = parse(report, buildOutput);
      // the full payload again — minus the inventory, which only the report
      // and the tar itself hold
      const { files: _files, ...capture } = artifacts.buildOutput.capture;
      expect(parsed.buildOutput).toEqual({ ...artifacts.buildOutput, capture });
      expect(parsed.report.capture).toEqual(artifacts.report.capture);
      // the lenient readers' inverse fills the judge from the row the same way
      const expanded = expandRecordedBuildOutput(buildOutput, artifacts.buildOutput.inputs.manifest.id) as Record<string, any>;
      expect(expanded.certificate).toEqual(artifacts.buildOutput.certificate);
    });
  });

  it("holds the stored capture summary to the report's inventory", () => {
    withTestEnvironments([spec2TestEnvironment()], () => {
      for (const [mutate, expected] of [
        [(c: Record<string, any>) => { c.fileCount = 2; }, "different capture manifests"],
        [(c: Record<string, any>) => { c.bytes = 4; }, "different capture manifests"],
        [(c: Record<string, any>) => { c.references.digest = "9".repeat(64); }, "different capture manifests"],
        [(c: Record<string, any>) => { c.files = [{ path: "concepts/Lax42.olean", bytes: 3, sha256: "5".repeat(64) }]; }, "capture manifest must contain exactly"],
        [(c: Record<string, any>) => { delete c.references; }, "capture manifest must contain exactly"],
        [(c: Record<string, any>) => { c.references.registryBlob = "ghcr.io/lax-archive/lax-captures@sha256:" + "f".repeat(64); }, "capture references must contain exactly"],
      ] as const) {
        const { report, buildOutput } = stored();
        mutate(buildOutput.capture);
        mutate((report.buildOutput as Record<string, any>).capture);
        expect(() => parse(report, buildOutput), expected).toThrow(expected);
      }
    });
  });

  it("refuses a stored copy of a derivable field", () => {
    withTestEnvironments([spec2TestEnvironment()], () => {
      for (const [mutate, expected] of [
        [(output: Record<string, any>) => { output.proofs[0].conclusion = "Lax42.Primes.InfinitelyManyPrimes"; }, "generated proof 1 must contain exactly"],
        [(output: Record<string, any>) => { output.proofs[0].assumptions = []; }, "generated proof 1 must contain exactly"],
        [(output: Record<string, any>) => { output.inputs.manifest.id = "lax-42"; }, "generated manifest must contain exactly"],
        [(output: Record<string, any>) => { output.capture.leanToolchain = "leanprover/lean4:v4.35.0-rc3"; output.capture.mathlibCommit = "3".repeat(40); }, "capture manifest must contain exactly"],
        // the judge's toolchain is the row's and its exit code a constant
        [(output: Record<string, any>) => { output.certificate.judge.toolchain = "leanprover/lean4:v4.35.0-rc3"; }, "generated certificate judge must contain exactly"],
        [(output: Record<string, any>) => { output.certificate.judge.comparatorExitCode = 0; }, "generated certificate judge must contain exactly"],
      ] as const) {
        const { report, buildOutput } = stored();
        mutate(buildOutput);
        mutate(report.buildOutput as Record<string, any>);
        expect(() => parse(report, buildOutput), expected).toThrow(expected);
      }
    });
  });

  it("refuses a telescope entry that still carries a binder kind", () => {
    withTestEnvironments([spec2TestEnvironment()], () => {
      for (const [mutate, expected] of [
        [(output: Record<string, any>) => { output.proofs[0].telescope.hypotheses[0].binder = "default"; }, "generated proof 1 telescope hypothesis 1 must contain exactly: statement, levels"],
        [(output: Record<string, any>) => { output.proofs[0].telescope.conclusion.binder = "default"; }, "generated proof 1 telescope conclusion must contain exactly: statement, levels"],
      ] as const) {
        const { report, buildOutput } = stored();
        mutate(buildOutput);
        mutate(report.buildOutput as Record<string, any>);
        expect(() => parse(report, buildOutput), expected).toThrow(expected);
      }
    });
  });

  it("holds the certificate's Challenge to the generator: a weakened conclusion is refused", () => {
    withTestEnvironments([spec2TestEnvironment()], () => {
      const { report, buildOutput } = stored();
      const weakened = (buildOutput.certificate.challenge as string).replace("_root_.Lax42.Primes.InfinitelyManyPrimes.{«u»}", "True");
      expect(weakened).not.toBe(buildOutput.certificate.challenge);
      buildOutput.certificate.challenge = weakened;
      (report.buildOutput as Record<string, any>).certificate.challenge = weakened;
      expect(() => parse(report, buildOutput)).toThrow("not what the generator writes for the record's proofs");
      // a telescope edited to match the weakened text is not the proof the
      // record classified either: the Challenge is regenerated from it
      const { report: report2, buildOutput: buildOutput2 } = stored();
      buildOutput2.proofs[0].telescope.hypotheses = [];
      (report2.buildOutput as Record<string, any>).proofs[0].telescope.hypotheses = [];
      expect(() => parse(report2, buildOutput2)).toThrow("not what the generator writes");
    });
  });

  it("requires the certificate exactly for a spec-2 record with proofs, judged by this environment's toolchain", () => {
    withTestEnvironments([spec2TestEnvironment()], () => {
      const missing = stored();
      delete missing.buildOutput.certificate;
      delete (missing.report.buildOutput as Record<string, any>).certificate;
      expect(() => parse(missing.report, missing.buildOutput)).toThrow("carries a certificate exactly when it has a proof that is not pending");

      const noProofs = stored();
      noProofs.buildOutput.proofs = [];
      (noProofs.report.buildOutput as Record<string, any>).proofs = [];
      expect(() => parse(noProofs.report, noProofs.buildOutput)).toThrow("carries a certificate exactly when it has a proof that is not pending");
      delete noProofs.buildOutput.certificate;
      delete (noProofs.report.buildOutput as Record<string, any>).certificate;
      expect(parse(noProofs.report, noProofs.buildOutput).buildOutput.certificate).toBeUndefined();

      for (const [mutate, expected] of [
        // the judge proved itself first: a local run's `passed: false`, a
        // missing probe, an extra probe, a missing or malformed tool digest
        [(c: Record<string, any>) => { c.judge.selfTest.passed = false; }, "selfTest must have passed"],
        [(c: Record<string, any>) => { c.judge.selfTest.probes = c.judge.selfTest.probes.slice(1); }, "selfTest probes must be exactly"],
        [(c: Record<string, any>) => { c.judge.selfTest.probes = [...c.judge.selfTest.probes, "extra"]; }, "contains more than"],
        [(c: Record<string, any>) => { delete c.judge.selfTest; }, "generated certificate judge must contain exactly"],
        [(c: Record<string, any>) => { delete c.judge.tools.lake; }, "generated certificate judge tools must contain exactly"],
        [(c: Record<string, any>) => { c.judge.tools.lean = "abc"; }, "lowercase SHA-256"],
        [(c: Record<string, any>) => { c.kernels = ["nanoda"]; }, "unknown kernel"],
        [(c: Record<string, any>) => { c.kernels = ["lean", "lean"]; }, "contains more than"],
        [(c: Record<string, any>) => { c.kernels = ["my-kernel"]; }, "unknown kernel"],
        // the kernels are the environment's configured set, exactly — a
        // record claiming more kernels than the row runs is not this row's
        [(c: Record<string, any>) => { c.kernels = ["lean", "lean4lean"]; }, "contains more than"],
        [(c: Record<string, any>) => { c.kernels = ["lean4lean"]; }, "unknown kernel"],
        [(c: Record<string, any>) => { c.kernels = []; }, "must include Lean's own"],
        [(c: Record<string, any>) => { c.bundle.digest = "abc"; }, "lowercase SHA-256"],
        [(c: Record<string, any>) => { c.solutionExportSha256 = "abc"; }, "lowercase SHA-256"],
        [(c: Record<string, any>) => { delete c.solutionExportSha256; }, "generated certificate must contain exactly"],
        [(c: Record<string, any>) => { c.bundle.registryBlob = `ghcr.io/lax-archive/lax-captures@sha256:${"c".repeat(64)}`; }, "generated certificate bundle must contain exactly"],
        [(c: Record<string, any>) => { c.extra = 1; }, "generated certificate must contain exactly"],
      ] as const) {
        const { report, buildOutput } = stored();
        mutate(buildOutput.certificate);
        mutate((report.buildOutput as Record<string, any>).certificate);
        expect(() => parse(report, buildOutput), expected).toThrow(expected);
      }
    });
  });

  // decision 12: a pending edge is recorded and never judged
  it("records a pending edge, leaves it out of the certificate's Challenge, and needs no certificate when every edge is pending", () => {
    withTestEnvironments([spec2TestEnvironment()], () => {
      const pendingProof = {
        id: "Lax42Proofs.stub",
        path: "proofs/Lax42Proofs/Basic.lean",
        levelParams: [],
        telescope: { hypotheses: [], conclusion: { statement: "Lax42.Primes.ExistsPrimeDivisor", levels: [] } },
        pending: true,
        description: "",
      };
      const both = stored();
      for (const output of [both.buildOutput, both.report.buildOutput as Record<string, any>]) output.proofs.push(structuredClone(pendingProof));
      const parsed = parse(both.report, both.buildOutput).buildOutput;
      expect(parsed.proofs.map((proof) => [proof.id, proof.pending])).toEqual([["Lax42Proofs.euclid", undefined], ["Lax42Proofs.stub", true]]);
      // the stored Challenge is the complete edge's alone
      expect(parsed.certificate!.challenge).not.toContain("stub");
      // stored between the telescope and the description, and parsed back
      const restored = (recordedBuildOutput(parsed).proofs as Record<string, unknown>[])[1]!;
      expect(Object.keys(restored)).toEqual(["id", "path", "levelParams", "telescope", "pending", "description"]);
      expect(restored).toEqual(both.buildOutput.proofs[1]);

      const onlyPending = stored();
      for (const output of [onlyPending.buildOutput, onlyPending.report.buildOutput as Record<string, any>]) {
        output.proofs = [structuredClone(pendingProof)];
      }
      expect(() => parse(onlyPending.report, onlyPending.buildOutput)).toThrow("exactly when it has a proof that is not pending");
      for (const output of [onlyPending.buildOutput, onlyPending.report.buildOutput as Record<string, any>]) delete output.certificate;
      expect(parse(onlyPending.report, onlyPending.buildOutput).buildOutput.certificate).toBeUndefined();

      const malformed = stored();
      for (const output of [malformed.buildOutput, malformed.report.buildOutput as Record<string, any>]) output.proofs[0].pending = false;
      expect(() => parse(malformed.report, malformed.buildOutput)).toThrow("pending must be true when present");
    });
  });

  // R1 of the 2026-10-05 Codex review: the publisher cannot rerun the judge,
  // so a pending flag must not be a soundness input. Absent, the proof is a
  // theorem of the Challenge the judge holds to the background axioms (and
  // the self-test's `comparator-rejects-sorry` proves the judge refuses
  // `sorryAx` there); present, the proof is out of the Challenge and only
  // blocks registration. Either way the flag and the Challenge must agree.
  it("binds the pending flags to the Challenge both ways: an unflagged proof is stated in it, a flagged one is not", () => {
    withTestEnvironments([spec2TestEnvironment()], () => {
      const stub = {
        id: "Lax42Proofs.stub",
        path: "proofs/Lax42Proofs/Basic.lean",
        levelParams: [],
        telescope: { hypotheses: [], conclusion: { statement: "Lax42.Primes.ExistsPrimeDivisor", levels: [] } },
        description: "",
      };
      const withStub = (pending: boolean, challenge?: string) => {
        const artifacts = stored();
        for (const output of [artifacts.buildOutput, artifacts.report.buildOutput as Record<string, any>]) {
          output.proofs.push(structuredClone(pending ? { ...stub, pending: true } : stub));
          if (challenge !== undefined) output.certificate.challenge = challenge;
        }
        return artifacts;
      };
      // the Challenge the generator writes when the stub is judged too
      const flagged = parse(withStub(true).report, withStub(true).buildOutput).buildOutput;
      const judgedToo = challengeText(certifiedProofs(flagged.proofs.map(({ pending: _pending, ...proof }) => proof)));
      expect(judgedToo).toContain("Lax42Proofs.stub");
      expect(flagged.certificate!.challenge).not.toContain("Lax42Proofs.stub");

      // a flag the artifact dropped, with the Challenge left as it was: refused
      const dropped = withStub(false);
      expect(() => parse(dropped.report, dropped.buildOutput)).toThrow("not what the generator writes for the record's proofs");
      // dropped, and the Challenge restated to match: it parses — the edge is
      // now one the judge was handed under the background axioms, which is
      // where a `sorry` behind it is refused
      const restated = withStub(false, judgedToo);
      expect(parse(restated.report, restated.buildOutput).buildOutput.certificate!.challenge).toBe(judgedToo);
      // a flagged proof the Challenge states anyway: refused
      const both = withStub(true, judgedToo);
      expect(() => parse(both.report, both.buildOutput)).toThrow("not what the generator writes for the record's proofs");
    });
  });

  it("requires the published bundle's registry address to carry exactly the bundle digest", () => {
    withTestEnvironments([spec2TestEnvironment()], () => {
      const { artifacts, buildOutput } = stored();
      const runtime = artifacts.report.runtime;
      const published = JSON.parse(JSON.stringify(buildOutput)) as Record<string, any>;
      published.capture.registryBlob = `ghcr.io/lax-archive/lax-captures@sha256:${published.capture.digest}`;
      published.capture.references.registryBlob = `ghcr.io/lax-archive/lax-captures@sha256:${"f".repeat(64)}`;
      published.certificate.bundle.registryBlob = `ghcr.io/lax-archive/lax-captures@sha256:${"c".repeat(64)}`;
      const parsed = parsePublishedBuildOutputPayload(published, validationRequest(), runtime);
      expect(parsed.certificate?.bundle.registryBlob).toBe(`ghcr.io/lax-archive/lax-captures@sha256:${"c".repeat(64)}`);
      expect(parsed.capture.leanToolchain).toBe(runtime.leanToolchain);
      expect(parsed.capture.references?.registryBlob).toBe(`ghcr.io/lax-archive/lax-captures@sha256:${"f".repeat(64)}`);
      // the references address must carry the references digest
      const wrongReferences = JSON.parse(JSON.stringify(published)) as Record<string, any>;
      wrongReferences.capture.references.registryBlob = `ghcr.io/lax-archive/lax-captures@sha256:${"9".repeat(64)}`;
      expect(() => parsePublishedBuildOutputPayload(wrongReferences, validationRequest(), runtime))
        .toThrow("references registryBlob digest does not match");

      published.certificate.bundle.registryBlob = `ghcr.io/lax-archive/lax-captures@sha256:${"9".repeat(64)}`;
      expect(() => parsePublishedBuildOutputPayload(published, validationRequest(), runtime))
        .toThrow("registryBlob digest does not match the bundle digest");
      delete published.certificate.bundle.registryBlob;
      expect(() => parsePublishedBuildOutputPayload(published, validationRequest(), runtime))
        .toThrow("generated certificate bundle must contain exactly");
    });
  });

  it("leaves a spec-1 record byte-identical and without a certificate", () => {
    const spec1 = successfulArtifacts();
    expect(recordedBuildOutput(spec1.buildOutput)).toBe(spec1.buildOutput);
    const withCertificate = successfulArtifacts();
    (withCertificate.buildOutput as Record<string, any>).certificate = { judge: {}, kernels: [], bundle: {}, challengeExportSha256: "", solutionExportSha256: "", challenge: "" };
    (withCertificate.report.buildOutput as Record<string, any>).certificate = (withCertificate.buildOutput as Record<string, any>).certificate;
    expect(() =>
      parseSuccessfulValidationArtifacts(withCertificate.report, withCertificate.buildOutput, validationRequest(), withCertificate.report.runtime),
    ).toThrow("a spec-1 build output carries no certificate");
  });
});
