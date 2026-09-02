// Destination extraction and the count check (paper-plan.md, "Extraction"):
// read the compiled PDF's `lax.<n>.<b|e>.<v|h>` destinations back out with
// pdf.js in a capped child process, then require exactly one begin and one
// end per mark-table entry and nothing else. Coordinates never order marks —
// two markers closing back to back in vertical mode sit at the same point —
// so the mark number stays authoritative and there is no "end before begin"
// check. A mark with a missing half landed in verbatim, listings, or a moving
// argument, where `\laxmark` was text rather than a command.

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PaperMarkPoint, PaperMarkTableEntry } from "../contracts.js";
import { run } from "../host/proc.js";
import type { ExtractedDestination, ExtractedPdf } from "./extract-destinations.js";

/** A mark located in the PDF, before its id is resolved to a card. */
export interface LocatedMark {
  n: number;
  id: string;
  begin: PaperMarkPoint;
  end: PaperMarkPoint;
}

export interface ExtractionOptions {
  timeoutMs: number;
  maxOutputBytes: number;
}

/** Run the pdf.js child on a PDF and parse its answer. Throws when the child
 * fails or prints something that is not its contract — that is a broken
 * installation or a PDF pdf.js cannot open, not an author finding. */
export async function extractPdf(pdfPath: string, options: ExtractionOptions): Promise<ExtractedPdf> {
  const { command, args } = extractorCommand();
  const result = await run(command, [...args, pdfPath], path.dirname(pdfPath), {
    timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes,
  });
  if (result.code !== 0) {
    throw new Error(`could not read the compiled PDF (exit ${result.code}):\n${result.output.trim()}`);
  }
  const line = result.output.trim().split("\n").pop() ?? "";
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("the PDF reader printed no result");
  }
  return parseExtracted(value);
}

/**
 * The child script: the compiled `.js` beside this module in `dist/`, or —
 * when lax runs from source through tsx (tests, `npm run lax`) — the `.ts`
 * through tsx's loader. Production installs always have `dist/`.
 */
function extractorCommand(): { command: string; args: string[] } {
  const here = fileURLToPath(import.meta.url);
  const compiled = path.join(path.dirname(here), "extract-destinations.js");
  if (fs.existsSync(compiled)) return { command: process.execPath, args: [compiled] };
  const source = path.join(path.dirname(here), "extract-destinations.ts");
  const tsx = createRequire(import.meta.url).resolve("tsx/cli");
  return { command: process.execPath, args: [tsx, source] };
}

function parseExtracted(value: unknown): ExtractedPdf {
  if (value === null || typeof value !== "object") throw new Error("the PDF reader printed no result");
  const object = value as Record<string, unknown>;
  const pages = object.pages;
  if (!Number.isSafeInteger(pages) || (pages as number) < 0) throw new Error("PDF reader: invalid page count");
  const pageSizes = object.pageSizes;
  if (!Array.isArray(pageSizes) || pageSizes.length !== pages) throw new Error("PDF reader: invalid page sizes");
  const sizes = pageSizes.map((size) => {
    if (!Array.isArray(size) || size.length !== 2 || !size.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
      throw new Error("PDF reader: invalid page size");
    }
    return [size[0], size[1]] as [number, number];
  });
  if (!Array.isArray(object.destinations)) throw new Error("PDF reader: invalid destinations");
  const destinations = object.destinations.map((entry): ExtractedDestination => {
    const d = entry as Record<string, unknown>;
    if (
      typeof d.name !== "string" ||
      !Number.isSafeInteger(d.n) ||
      (d.kind !== "b" && d.kind !== "e") ||
      (d.mode !== "v" && d.mode !== "h") ||
      !Number.isSafeInteger(d.page) ||
      typeof d.x !== "number" ||
      typeof d.y !== "number"
    ) throw new Error("PDF reader: invalid destination");
    return { name: d.name, n: d.n as number, kind: d.kind, mode: d.mode, page: d.page as number, x: d.x, y: d.y };
  });
  const unknown = Array.isArray(object.unknown) ? object.unknown.filter((name): name is string => typeof name === "string") : [];
  return { pages: pages as number, pageSizes: sizes, destinations, unknown };
}

/**
 * The count check: every mark of the table has exactly one begin and one end
 * destination, and no destination exists that the table does not explain.
 * Both halves of a marker in verbatim go missing together, so one bad
 * marker is one finding, naming the id.
 */
export function matchDestinations(
  table: readonly PaperMarkTableEntry[],
  extracted: ExtractedPdf,
): { marks: LocatedMark[]; problems: string[] } {
  const problems: string[] = [];
  const byNumber = new Map<number, { b?: ExtractedDestination; e?: ExtractedDestination }>();
  for (const destination of extracted.destinations) {
    const slot = byNumber.get(destination.n) ?? {};
    if (slot[destination.kind] !== undefined) {
      problems.push(`the PDF carries destination ${destination.name} twice`);
    }
    slot[destination.kind] = destination;
    byNumber.set(destination.n, slot);
    if (destination.page < 1 || destination.page > extracted.pages) {
      problems.push(`destination ${destination.name} points at page ${destination.page} of ${extracted.pages}`);
    }
  }
  for (const name of extracted.unknown) problems.push(`the PDF carries a destination lax cannot read: ${name}`);
  const marks: LocatedMark[] = [];
  const known = new Set(table.map((entry) => entry.n));
  for (const entry of table) {
    const slot = byNumber.get(entry.n);
    const missing = [
      ...(slot?.b === undefined ? ["begin"] : []),
      ...(slot?.e === undefined ? ["end"] : []),
    ];
    if (missing.length > 0) {
      problems.push(
        `${entry.file}:${entry.line}: the marker for ${entry.id} left no ${missing.join(" and ")} destination ` +
          "in the PDF — it sits inside a verbatim or listings environment, a moving argument " +
          "(section title, caption), or display math; put the markers around the environment instead",
      );
      continue;
    }
    marks.push({
      n: entry.n,
      id: entry.id,
      begin: point(slot!.b!),
      end: point(slot!.e!),
    });
  }
  for (const n of [...byNumber.keys()].sort((a, b) => a - b)) {
    if (!known.has(n)) problems.push(`the PDF carries destinations for a mark number lax never emitted: ${n}`);
  }
  return { marks, problems };
}

function point(destination: ExtractedDestination): PaperMarkPoint {
  return { page: destination.page, x: destination.x, y: destination.y, mode: destination.mode };
}
