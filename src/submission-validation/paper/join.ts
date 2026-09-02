// The join piece of the paper phase as both pipelines run it: every located
// mark's id against the cards this submission produced (from Inspect) and
// the recorded build outputs of the packages it requires directly (from the
// archive snapshot resolution already holds). Milliseconds; the one part of
// the paper that needs Lean, which is why it runs after the Lean chain while
// the compile ran beside it. Pure apart from reading the snapshot.

import type { ArchiveSnapshot } from "../archive/snapshot.js";
import type { InspectionResult, PaperOutput, ResolutionResult, StaticResult } from "../contracts.js";
import type { CompiledPaper } from "./phase.js";
import { resolvePaperMarks, type CardIds } from "./resolve.js";

export function joinPaperMarks(
  compiled: CompiledPaper,
  staticResult: StaticResult,
  resolution: ResolutionResult,
  archive: ArchiveSnapshot,
  inspection: InspectionResult,
): { output?: PaperOutput; problems: string[] } {
  const direct = new Set([
    ...(staticResult.concepts?.lakefile.gitRequires ?? []).map((entry) => entry.name),
    ...(staticResult.proofs?.lakefile.gitRequires ?? []).map((entry) => entry.name),
  ]);
  const required = new Map<string, CardIds>();
  for (const dependency of resolution.all) {
    if (!direct.has(dependency.packageName)) continue;
    const record = archive.get(dependency.submissionId);
    const cards = record === undefined ? { concepts: [], proofs: [] } : archive.cardIds(record);
    required.set(
      dependency.packageName,
      dependency.kind === "concepts"
        ? { concepts: cards.concepts, proofs: [] }
        : { concepts: [], proofs: cards.proofs },
    );
  }
  const resolved = resolvePaperMarks(compiled.located, {
    conceptPackage: staticResult.concepts!.lakefile.packageName,
    own: {
      concepts: inspection.concepts.map((concept) => concept.id),
      proofs: inspection.proofs.map((proof) => proof.id),
    },
    required,
  });
  if (resolved.problems.length > 0) return { problems: resolved.problems };
  const manifest = staticResult.paper!.manifest;
  return {
    output: {
      folder: manifest.folder,
      main: manifest.main,
      engine: manifest.engine,
      pdf: { digest: compiled.digest, bytes: compiled.bytes, pages: compiled.pages },
      pageSizes: compiled.pageSizes,
      marks: resolved.marks,
    },
    problems: [],
  };
}
