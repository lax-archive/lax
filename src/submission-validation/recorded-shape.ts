// What a build output *stores* versus what the code *holds*. The in-memory
// `BuildOutputPayload` is the full shape on both specs; a spec-2 record
// (spike/axiomfree/build-output-investigation-20261003.md, "Recommendation")
// drops every field a reader derives from something else in the record or
// from the environment table:
//
//   proofs[].conclusion, proofs[].assumptions   from the telescope
//   capture.leanToolchain, capture.mathlibCommit from the row `inputs.manifest.leanVersion` names
//   capture.files                               from the sealed tar itself, after its digest is verified
//                                               (a spec-2 capture carries `bytes`, `fileCount` and the
//                                               `references` layer instead; nothing restores the list)
//   inputs.manifest.id                          from the record's own id
//   paper.folder, paper.main, paper.engine      from `inputs.manifest.paper`
//   certificate.judge.toolchain                 from the row, like the capture's pins
//   certificate.judge.comparatorExitCode        always 0: a certificate is recorded only on a pass
//
// `recordedBuildOutput` is the one serialization rule — the validate job's
// outputs, the trusted publisher's record, and the local `lax build` file all
// go through it — and `expandRecordedBuildOutput` is the lenient inverse the
// readers of raw records use (`lax generate-prooftree`, the local website
// renderer). The trusted parser (artifact-schema.ts) does its own strict
// inverse: it refuses a stored derivable field and fills it from the source
// of truth. A spec-1 record is byte-identical to what it always was: the
// payload is returned as it is.

import type { BuildOutputPayload, ProofTelescope } from "./contracts.js";
import { environment as environmentById } from "./environments.js";
import { isObject } from "../shared/validation.js";

/** The content spec a payload follows, read where the record keeps it. */
export function recordedSpec(value: { inputs: { manifest: { specVersion: string } } }): "1" | "2" {
  return value.inputs.manifest.specVersion === "2" ? "2" : "1";
}

/** `conclusion` and `assumptions` as a telescope defines them. */
export function derivedEdge(telescope: ProofTelescope): { conclusion: string; assumptions: string[] } {
  return {
    conclusion: telescope.conclusion.statement,
    assumptions: [...new Set(telescope.hypotheses.map((hypothesis) => hypothesis.statement))].sort(),
  };
}

/** The JSON object a record stores for this payload. */
export function recordedBuildOutput(payload: BuildOutputPayload): Record<string, unknown> {
  if (recordedSpec(payload) === "1") return payload as unknown as Record<string, unknown>;
  const { id: _id, ...manifest } = payload.inputs.manifest;
  const { leanToolchain: _toolchain, mathlibCommit: _mathlib, files: _files, ...capture } = payload.capture;
  const proofs = payload.proofs.map(({ conclusion: _conclusion, assumptions: _assumptions, ...proof }) => proof);
  const paper =
    payload.paper === undefined
      ? undefined
      : (({ folder: _folder, main: _main, engine: _engine, ...rest }) => rest)(payload.paper);
  const certificate =
    payload.certificate === undefined
      ? undefined
      : {
          ...payload.certificate,
          judge: (({ toolchain: _toolchain, comparatorExitCode: _exit, ...rest }) => rest)(payload.certificate.judge),
        };
  return {
    inputs: { manifest, abstract: payload.inputs.abstract },
    requiredByConcepts: payload.requiredByConcepts,
    requiredByProofs: payload.requiredByProofs,
    concepts: payload.concepts,
    proofs,
    capture,
    ...(paper === undefined ? {} : { paper }),
    ...(certificate === undefined ? {} : { certificate }),
  };
}

/**
 * A raw record as a reader of both shapes can hold it: a spec-2 record with
 * its derivable fields filled in, a spec-1 record untouched. Lenient on
 * purpose — it fills what it can and leaves the rest to the reader's own
 * checks — and never trusts the result as validated.
 */
export function expandRecordedBuildOutput(
  value: Record<string, unknown>,
  id: string,
): Record<string, unknown> {
  const inputs = isObject(value.inputs) ? value.inputs : undefined;
  const manifest = inputs !== undefined && isObject(inputs.manifest) ? inputs.manifest : undefined;
  if (manifest === undefined || manifest.specVersion !== "2") return value;
  const row = typeof manifest.leanVersion === "string" ? environmentById(manifest.leanVersion) : undefined;
  const capture = isObject(value.capture) ? value.capture : undefined;
  const paperManifest = isObject(manifest.paper) ? manifest.paper : undefined;
  const paper = isObject(value.paper) ? value.paper : undefined;
  const certificate = isObject(value.certificate) ? value.certificate : undefined;
  const judge = certificate !== undefined && isObject(certificate.judge) ? certificate.judge : undefined;
  const proofs = Array.isArray(value.proofs)
    ? value.proofs.map((proof) => {
        if (!isObject(proof) || !isObject(proof.telescope)) return proof;
        const telescope = proof.telescope as unknown as ProofTelescope;
        if (!isObject(telescope.conclusion) || !Array.isArray(telescope.hypotheses)) return proof;
        return { ...proof, ...derivedEdge(telescope) };
      })
    : value.proofs;
  return {
    ...value,
    inputs: { ...inputs, manifest: { id, ...manifest } },
    ...(capture === undefined || row === undefined
      ? {}
      : { capture: { ...capture, leanToolchain: row.leanToolchain, mathlibCommit: row.mathlibCommit } }),
    proofs,
    ...(certificate === undefined || judge === undefined || row === undefined
      ? {}
      : { certificate: { ...certificate, judge: { ...judge, toolchain: row.leanToolchain, comparatorExitCode: 0 } } }),
    ...(paper === undefined || paperManifest === undefined
      ? {}
      : {
          paper: {
            folder: paperManifest.folder,
            main: paperManifest.main,
            engine: paperManifest.engine,
            ...paper,
          },
        }),
  };
}
