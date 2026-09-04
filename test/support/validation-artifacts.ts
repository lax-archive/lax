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
