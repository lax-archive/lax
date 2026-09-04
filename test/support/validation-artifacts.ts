import type { SuccessfulValidationArtifacts } from "../../src/submission-validation/artifact-schema.js";
import type {
  BuildOutputPayload,
  CaptureManifest,
  ValidationReport,
  ValidationRequest,
  ValidationRuntimeIdentity,
} from "../../src/submission-validation/contracts.js";

export const TEST_SOURCE = {
  repository: "https://github.com/alice/submission",
  commit: "1".repeat(40),
  folder: ".",
};

export const TEST_RUNTIME: ValidationRuntimeIdentity = {
  environment: "v4.30.0",
  image: `ghcr.io/lax-archive/validation@sha256:${"2".repeat(64)}`,
  imageDigest: "2".repeat(64),
  layoutVersion: 1,
  leanToolchain: "leanprover/lean4:v4.30.0",
  leanVersion: "v4.30.0",
  mathlibRepository: "https://github.com/leanprover-community/mathlib4",
  mathlibCommit: "3".repeat(40),
};

export const TEST_CAPTURE: CaptureManifest = {
  formatVersion: 1,
  digest: "4".repeat(64),
  sourceCommit: TEST_SOURCE.commit,
  leanToolchain: TEST_RUNTIME.leanToolchain,
  mathlibCommit: TEST_RUNTIME.mathlibCommit,
  files: [{ path: "concepts/Lax42.olean", bytes: 3, sha256: "5".repeat(64) }],
};

export function validationRequest(id = "lax-42"): ValidationRequest {
  return {
    requestVersion: 1,
    id,
    source: TEST_SOURCE,
    archiveSha: "a".repeat(40),
  };
}

export function buildOutput(id = "lax-42"): BuildOutputPayload {
  return {
    inputs: {
      manifest: {
        specVersion: "1",
        id,
        leanVersion: TEST_RUNTIME.leanVersion,
        mathlibVersion: TEST_RUNTIME.mathlibCommit,
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
    capture: structuredClone(TEST_CAPTURE),
  };
}

export function successfulArtifacts(id = "lax-42"): SuccessfulValidationArtifacts {
  const request = validationRequest(id);
  const output = buildOutput(id);
  const report: ValidationReport & {
    ok: true;
    buildOutput: BuildOutputPayload;
    capture: CaptureManifest;
  } = {
    reportVersion: 1,
    ok: true,
    request,
    runtime: TEST_RUNTIME,
    dependencies: [],
    warnings: [],
    violations: [],
    buildOutput: output,
    capture: structuredClone(TEST_CAPTURE),
  };
  return { report, buildOutput: output };
}
