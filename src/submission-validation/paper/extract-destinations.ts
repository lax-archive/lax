// Child process of paper/extract.ts: read a PDF with pdf.js (legacy build,
// pure JavaScript) and print its page sizes and every `lax.<n>.<b|e>.<v|h>`
// named destination as JSON. A separate process so that a hostile or merely
// pathological PDF can be killed on a timeout and its output capped.
//
//   node extract-destinations.js [--text] <pdf>
//
// `--text` additionally emits each page's text items as
// `[str, hasEOL, x, y, width]` tuples — the PDF side of the web derivation's
// oracle (paper-web-plan.md); the geometry is what lets the oracle tell a
// margin line number from a number in the text.
//
// pdf.js runs on the host of the job, never in the TeX image (which has no
// node); on the trusted path that host is the credential-free Validate job.

import fs from "node:fs";

interface PdfjsLike {
  getDocument(options: { data: Uint8Array; useSystemFonts: boolean; isEvalSupported: boolean }): {
    promise: Promise<PdfDocumentLike>;
    destroy(): Promise<void>;
  };
}

interface PdfDocumentLike {
  numPages: number;
  getPage(index: number): Promise<{
    view: number[];
    getTextContent(): Promise<{
      items: Array<{ str?: string; hasEOL?: boolean; transform?: number[]; width?: number }>;
    }>;
  }>;
  getDestinations(): Promise<Map<string, unknown[]> | Record<string, unknown[]>>;
  getPageIndex(ref: unknown): Promise<number>;
}

export interface ExtractedDestination {
  name: string;
  n: number;
  kind: "b" | "e";
  mode: "v" | "h";
  page: number;
  x: number;
  y: number;
}

/** One text item of a page: the string, whether pdf.js marks a line end
 * after it, and — when the reader supplied them — its position and advance
 * in page units (points from the page's lower left corner, the baseline
 * origin of the item's transform, and its width). A tuple keeps a
 * chapter-scale emission compact; the geometry is optional so a bare
 * `[str, eol]` pair stays a valid item for consumers that need only text. */
export type ExtractedTextItem = [text: string, eol: 0 | 1, x?: number, y?: number, width?: number];

export interface ExtractedPdf {
  pages: number;
  pageSizes: Array<[number, number]>;
  destinations: ExtractedDestination[];
  /** `lax.` destinations that do not follow the naming scheme, or whose page
   * cannot be resolved — evidence of something other than laxmark writing them. */
  unknown: string[];
  /** Per-page text items, present only under `--text`. */
  text?: ExtractedTextItem[][];
}

const DESTINATION = /^lax\.([1-9][0-9]*)\.([be])\.([vh])$/u;

async function main(pdfPath: string, withText: boolean): Promise<ExtractedPdf> {
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsLike;
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const loading = pdfjs.getDocument({ data, useSystemFonts: false, isEvalSupported: false });
  try {
    const document = await loading.promise;
    const pageSizes: Array<[number, number]> = [];
    const text: ExtractedTextItem[][] = [];
    for (let index = 1; index <= document.numPages; index += 1) {
      const page = await document.getPage(index);
      const [x0, y0, x1, y1] = page.view as [number, number, number, number];
      pageSizes.push([round(x1 - x0), round(y1 - y0)]);
      if (withText) {
        const content = await page.getTextContent();
        text.push(content.items.map((item): ExtractedTextItem => {
          const transform = Array.isArray(item.transform) ? item.transform : [];
          const x = transform[4];
          const y = transform[5];
          const width = item.width;
          const str = typeof item.str === "string" ? item.str : "";
          const eol = item.hasEOL === true ? 1 : 0;
          // A text item pdf.js gives no placement for (it never does, but
          // the contract allows it) is emitted as the bare pair.
          if (
            typeof x !== "number" || typeof y !== "number" || typeof width !== "number" ||
            !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width)
          ) return [str, eol];
          return [str, eol, round(x), round(y), round(width)];
        }));
      }
    }
    // pdfjs-dist ≥ 5 returns a Map here; older versions a plain object.
    // `Object.entries` on a Map silently yields nothing, which reads exactly
    // like "no destinations were written".
    const raw = await document.getDestinations();
    const entries = raw instanceof Map ? [...raw.entries()] : Object.entries(raw ?? {});
    const destinations: ExtractedDestination[] = [];
    const unknown: string[] = [];
    for (const [name, destination] of entries) {
      if (!name.startsWith("lax.")) continue;
      const match = DESTINATION.exec(name);
      if (match === null || !Array.isArray(destination)) {
        unknown.push(name);
        continue;
      }
      let page: number;
      try {
        page = (await document.getPageIndex(destination[0])) + 1;
      } catch {
        unknown.push(name);
        continue;
      }
      const x = destination[2];
      const y = destination[3];
      if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
        unknown.push(name);
        continue;
      }
      destinations.push({
        name,
        n: Number(match[1]),
        kind: match[2] as "b" | "e",
        mode: match[3] as "v" | "h",
        page,
        x: round(x),
        y: round(y),
      });
    }
    destinations.sort((a, b) => a.n - b.n || (a.kind === b.kind ? 0 : a.kind === "b" ? -1 : 1));
    return {
      pages: document.numPages,
      pageSizes,
      destinations,
      unknown,
      ...(withText ? { text } : {}),
    };
  } finally {
    await loading.destroy();
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

const args = process.argv.slice(2);
const withText = args[0] === "--text";
const pdfPath = withText ? args[1] : args[0];
if (pdfPath === undefined) {
  process.stderr.write("usage: extract-destinations [--text] <pdf>\n");
  process.exit(2);
}
main(pdfPath, withText).then(
  (result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
