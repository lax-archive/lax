import fs from "node:fs";
import path from "node:path";
import type {
  BuildOutputPayload,
  CaptureManifest,
  InspectionResult,
  PaperOutput,
  StaticResult,
} from "../contracts.js";

export function emitBuildOutput(
  sourceRoot: string,
  staticResult: StaticResult,
  inspection: InspectionResult,
  capture: CaptureManifest,
  paper?: PaperOutput,
): BuildOutputPayload {
  if (
    staticResult.manifest === undefined ||
    staticResult.abstract === undefined ||
    staticResult.concepts === undefined ||
    staticResult.proofs === undefined
  ) throw new Error("cannot emit build output from an incomplete static result");
  // A paper result without a declaration is a pipeline bug. The converse is
  // legitimate locally: a host without latexmk skips the compile and omits
  // the key; the trusted parser is where "declared implies present" holds.
  if (paper !== undefined && staticResult.manifest.paper === undefined) {
    throw new Error("cannot emit build output: a paper result for a manifest that declares none");
  }
  const concepts = inspection.concepts.map((concept) => ({
    ...concept,
    sourceText: boundedSource(path.join(sourceRoot, concept.path)),
    imports: [...concept.imports].sort(),
    mathlibImports: [...concept.mathlibImports].sort(),
    statements: [...concept.statements].sort((a, b) => a.id.localeCompare(b.id)),
  }));
  return {
    inputs: { manifest: staticResult.manifest, abstract: staticResult.abstract },
    requiredByConcepts: staticResult.concepts.lakefile.gitRequires
      .map((entry) => entry.name)
      .sort(),
    requiredByProofs: staticResult.proofs.lakefile.gitRequires
      .map((entry) => entry.name)
      .sort(),
    concepts: concepts.sort((a, b) => a.id.localeCompare(b.id)),
    proofs: inspection.proofs
      .map((proof) => ({ ...proof, assumptions: [...proof.assumptions].sort() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    capture,
    ...(paper === undefined ? {} : { paper }),
  };
}

function boundedSource(filename: string): string {
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error(`${filename} is missing or exceeds 4 MiB`);
  return fs.readFileSync(filename, "utf8").replace(/\r\n?/gu, "\n");
}
