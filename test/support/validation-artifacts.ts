import type { SuccessfulValidationArtifacts } from "../../src/submission-validation/artifact-schema.js";
import { certifiedProof, challengeText } from "../../src/submission-validation/certify/generate.js";
import { JUDGE_TOOLS, SELF_TEST_PROBES, type JudgeTool } from "../../src/submission-validation/contracts.js";

/** A judge's tool digests as a fixture carries them: one sha256 per tool. */
export function fakeToolDigests(): Record<JudgeTool, string> {
  return Object.fromEntries(JUDGE_TOOLS.map((tool, index) => [tool, String(index).repeat(64)])) as Record<JudgeTool, string>;
}
import type {
  BuildOutputPayload,
  CaptureManifest,
  CertificateOutput,
  ConceptEntry,
  ProofEntry,
  ValidationReport,
  ValidationRequest,
  ValidationRuntimeIdentity,
} from "../../src/submission-validation/contracts.js";
import { environment as environmentById } from "../../src/submission-validation/environments.js";

export const TEST_SOURCE = {
  repository: "https://github.com/alice/submission",
  commit: "1".repeat(40),
  folder: ".",
};

export const TEST_RUNTIME: ValidationRuntimeIdentity = {
  environment: "v4.33.0",
  image: `ghcr.io/lax-archive/validation@sha256:${"2".repeat(64)}`,
  imageDigest: "2".repeat(64),
  layoutVersion: 1,
  leanToolchain: "leanprover/lean4:v4.33.0",
  leanVersion: "v4.33.0",
  mathlibRepository: "https://github.com/leanprover-community/mathlib4",
  mathlibCommit: "3".repeat(40),
};

/** The fixture runtime for another archive environment: the same image and
 * mathlib repository, the entry's own id, toolchain, and commit — what
 * `configuredRuntime(entry)` renders for a row of the table. */
export function testRuntimeFor(entry: {
  id: string;
  leanToolchain: string;
  mathlibCommit: string;
}): ValidationRuntimeIdentity {
  return {
    ...TEST_RUNTIME,
    environment: entry.id,
    leanToolchain: entry.leanToolchain,
    leanVersion: entry.id,
    mathlibCommit: entry.mathlibCommit,
  };
}

export function testCaptureFor(runtime: ValidationRuntimeIdentity): CaptureManifest {
  return {
    formatVersion: 1,
    digest: "4".repeat(64),
    sourceCommit: TEST_SOURCE.commit,
    leanToolchain: runtime.leanToolchain,
    mathlibCommit: runtime.mathlibCommit,
    files: [{ path: "concepts/Lax42.olean", bytes: 3, sha256: "5".repeat(64) }],
  };
}

export const TEST_CAPTURE: CaptureManifest = testCaptureFor(TEST_RUNTIME);

export function validationRequest(id = "lax-42"): ValidationRequest {
  return {
    requestVersion: 1,
    id,
    source: TEST_SOURCE,
    archiveSha: "a".repeat(40),
  };
}

export function buildOutput(id = "lax-42", runtime = TEST_RUNTIME): BuildOutputPayload {
  return {
    inputs: {
      manifest: {
        specVersion: "1",
        id,
        leanVersion: runtime.leanVersion,
        mathlibVersion: runtime.mathlibCommit,
        title: "Accepted submission title",
        authors: [{ name: "Alice Example", github: "alice" }],
        bibEntries: [],
      },
      abstract: "A validated submission.\n",
    },
    requiredByConcepts: [],
    requiredByProofs: [],
    concepts: [],
    proofs: [],
    capture: testCaptureFor(runtime),
  };
}

export function successfulArtifacts(id = "lax-42", runtime = TEST_RUNTIME): SuccessfulValidationArtifacts {
  const request = validationRequest(id);
  const output = buildOutput(id, runtime);
  const report: ValidationReport & {
    ok: true;
    buildOutput: BuildOutputPayload;
    capture: CaptureManifest;
  } = {
    reportVersion: 1,
    ok: true,
    request,
    runtime,
    dependencies: [],
    warnings: [],
    violations: [],
    buildOutput: output,
    capture: testCaptureFor(runtime),
  };
  return { report, buildOutput: output };
}

/**
 * A successful spec-2 artifact set, in memory and full-shaped: the payload
 * the pipeline holds before recorded-shape.ts drops what a record derives.
 * Call it inside `withTestEnvironments([spec2TestEnvironment()], …)`: the
 * runtime names that injected row, and the parser looks the row up.
 */
export function spec2Artifacts(id = "lax-42"): SuccessfulValidationArtifacts {
  const row = environmentById("v4.35.0");
  if (row === undefined) throw new Error("spec2Artifacts needs the spec-2 test environment injected");
  const runtime = testRuntimeFor(row);
  const artifacts = successfulArtifacts(id, runtime);
  const proofs: ProofEntry[] = [
    {
      id: "Lax42Proofs.euclid",
      path: "proofs/Lax42Proofs/Basic.lean",
      levelParams: ["u"],
      telescope: {
        hypotheses: [{ statement: "Lax42.Primes.ExistsPrimeDivisor", levels: [] }],
        conclusion: { statement: "Lax42.Primes.InfinitelyManyPrimes", levels: ["u"] },
      },
      conclusion: "Lax42.Primes.InfinitelyManyPrimes",
      assumptions: ["Lax42.Primes.ExistsPrimeDivisor"],
      description: "Euclid's argument.",
    },
  ];
  const concepts: ConceptEntry[] = [
    {
      id: "Lax42.Primes",
      path: "concepts/Lax42/Primes.lean",
      title: "Primes",
      type: "theorem",
      description: "Two statements.",
      imports: [],
      mathlibImports: [],
      sourceText: "",
      statements: [
        { id: "Lax42.Primes.ExistsPrimeDivisor", levelParams: [], signature: "ExistsPrimeDivisor : Prop", body: "True" },
        { id: "Lax42.Primes.InfinitelyManyPrimes", levelParams: ["u"], signature: "InfinitelyManyPrimes.{u} : Prop", body: "True" },
      ],
    },
  ];
  const certificate: CertificateOutput = {
    judge: { toolchain: runtime.leanToolchain, comparatorExitCode: 0, selfTest: { passed: true, probes: [...SELF_TEST_PROBES] }, tools: fakeToolDigests() },
    kernels: ["lean"],
    bundle: { formatVersion: 1, digest: "c".repeat(64) },
    challengeExportSha256: "e".repeat(64),
    solutionExportSha256: "d".repeat(64),
    challenge: challengeText(proofs.map(certifiedProof)),
  };
  // a spec-2 capture is summarised beside its inventory (seal.ts): the tar's
  // size and member count, and the `references` layer
  const summary = { bytes: 3, fileCount: 1, references: { digest: "f".repeat(64), bytes: 10_240 } };
  for (const output of [artifacts.buildOutput, artifacts.report.buildOutput]) {
    output.inputs.manifest.specVersion = "2";
    output.concepts = structuredClone(concepts);
    output.proofs = structuredClone(proofs);
    output.certificate = structuredClone(certificate);
    output.capture = { ...output.capture, ...structuredClone(summary) };
  }
  artifacts.report.capture = { ...artifacts.report.capture, ...structuredClone(summary) };
  return artifacts;
}
