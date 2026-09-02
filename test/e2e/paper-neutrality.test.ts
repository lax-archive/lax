// Layout neutrality of the injected markers, distilled from the phantom-line
// investigation's byte-identity harness: each pattern compiles twice — the
// author's own build (original text, no injection) and the archive's
// (rewritten text, `-pretex laxmark`, production flags) — and every text
// item must sit at identical coordinates in both PDFs. The phantom pattern
// (an own-line `% lax end` directly after an `\end{equation}`-style display,
// a blank line after it) regressed exactly here before the rewriter's
// blank-line relocation: the whatsit alone in the paragraph TeX resumes
// after the display forced a glyph-free line — TeX discards an *empty*
// resumed segment but not one holding a whatsit — and everything below
// dropped one \baselineskip (~12 pt). Gated like host-paper.test.ts on
// latexmk; the lualatex rows run only where that engine exists.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  latexmkArguments,
  latexmkEngineFlag,
  paperCompileEnvironment,
} from "../../src/submission-validation/paper/compile.js";
import { rewriteMarkers } from "../../src/submission-validation/paper/rewrite.js";
import { engineAvailable, laxmarkDirectory, probeLatexmk } from "../../src/submission-validation/host/paper.js";
import { freshLaxHome, tmpDir } from "../support/host.js";

const withTex = probeLatexmk()?.supported === true;
if (!withTex) console.warn("paper-neutrality: latexmk >= 4.77 not found, skipping");
const engines: Array<"pdflatex" | "lualatex"> = withTex
  ? ["pdflatex", ...((await engineAvailable("lualatex")) ? (["lualatex"] as const) : [])]
  : [];

beforeAll(() => {
  freshLaxHome();
});

const PREAMBLE = `\\documentclass{article}
\\usepackage{amsmath}
\\usepackage{amsthm}
\\newtheorem{theorem}{Theorem}
\\newcommand{\\tw}{\\operatorname{tw}}
\\begin{document}
`;

/** The phantom pattern itself: relocation must make it match the author's
 * build (before the fix this shifted ~12 pt on both engines). */
const PHANTOM = `${PREAMBLE}The treewidth of a graph never exceeds its vertex count:
% lax begin Lax261.MainBound
\\begin{equation}
  \\tw(G) \\le |V(G)| - 1.
\\end{equation}
% lax end

Equality holds for complete graphs, which is the tight case of the bound.
\\end{document}
`;

/** Text resuming on the marker's next line: the case that forbids ending the
 * paragraph at the marker — the same paragraph must continue. */
const CONTINUATION = `${PREAMBLE}The two sides agree on every clique:
% lax begin Lax261.CliqueCase
\\begin{align}
  \\tw(K_n) &= n - 1, \\\\
  |V(K_n)| - 1 &= n - 1.
\\end{align}
% lax end
so the bound is tight for complete graphs of every order.
\\end{document}
`;

/** Two nested ends on consecutive own lines before one blank line, directly
 * after a display: the run relocates as a block, order preserved. */
const NESTED_RUN = `${PREAMBLE}% lax begin Lax261.Outer
The treewidth of a graph never exceeds its vertex count:
% lax begin Lax261.MainBound
\\begin{equation}
  \\tw(G) \\le |V(G)| - 1.
\\end{equation}
% lax end
% lax end

Equality holds for complete graphs, which is the tight case of the bound.
\\end{document}
`;

/** Markers at \addvspace boundaries (theorem/proof): the package's
 * vertical-mode glue lift keeps them neutral; relocation across the blank
 * lines here must change nothing. */
const THEOREM = `${PREAMBLE}\\section{A theorem with a proof}

% lax begin Lax261.Treewidth
\\begin{theorem}
  A graph $G$ satisfies $\\tw(G) \\le 1$ if and only if $G$ is a forest.
\\end{theorem}

% lax begin Lax261Proofs.thm3
\\begin{proof}
  A forest admits singleton-plus-parent bags of size at most two.
\\end{proof}
% lax end

% lax end

\\section{The next section}

More text after the wrapped theorem and proof.
\\end{document}
`;

const PATTERNS: Array<{ name: string; text: string; relocated: number[] }> = [
  { name: "display end + blank line (the phantom)", text: PHANTOM, relocated: [1] },
  { name: "display end + continuing text", text: CONTINUATION, relocated: [] },
  { name: "nested end run after a display", text: NESTED_RUN, relocated: [1, 2] },
  { name: "theorem and proof boundaries", text: THEOREM, relocated: [] },
];

function compile(text: string, marked: boolean, engine: "pdflatex" | "lualatex"): string {
  const dir = tmpDir("lax-neutrality-");
  let source = text;
  if (marked) {
    const rewritten = rewriteMarkers([{ path: "main.tex", text }]);
    expect(rewritten.problems).toEqual([]);
    source = rewritten.rewritten[0]!.text;
  }
  fs.writeFileSync(path.join(dir, "main.tex"), source, "latin1");
  const args = marked
    ? latexmkArguments(engine, "main.tex")
    : [latexmkEngineFlag(engine), "-interaction=nonstopmode", "-halt-on-error", "main.tex"];
  const result = spawnSync("latexmk", args, {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ...paperCompileEnvironment(laxmarkDirectory(), 1_700_000_000) },
  });
  expect(result.status, `latexmk failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
  return path.join(dir, "main.pdf");
}

interface ReadPdf {
  /** Per page, every text item with its full transform — glyph positions. */
  items: string;
  /** `lax.<n>.<b|e>.<v|h>` destination names, sorted. */
  destinations: string[];
}

async function readPdf(pdfPath: string): Promise<ReadPdf> {
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as {
    getDocument(options: object): { promise: Promise<never> };
  };
  const document = (await pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(pdfPath)),
    useSystemFonts: false,
    isEvalSupported: false,
  }).promise) as {
    numPages: number;
    getPage(index: number): Promise<{
      getTextContent(): Promise<{ items: Array<{ str?: string; transform?: number[]; width?: number; height?: number }> }>;
    }>;
    getDestinations(): Promise<Map<string, unknown> | Record<string, unknown>>;
    destroy(): Promise<void>;
  };
  const pages: unknown[] = [];
  for (let index = 1; index <= document.numPages; index += 1) {
    const content = await (await document.getPage(index)).getTextContent();
    pages.push(content.items.map((item) => [item.str, item.transform, item.width, item.height]));
  }
  const raw = await document.getDestinations();
  const names = raw instanceof Map ? [...raw.keys()] : Object.keys(raw ?? {});
  await document.destroy();
  return {
    items: JSON.stringify(pages),
    destinations: names.filter((name) => name.startsWith("lax.")).sort(),
  };
}

describe.skipIf(!withTex)("marker layout neutrality (author build vs injected build)", () => {
  for (const engine of engines) {
    it(`keeps every glyph position identical under ${engine}`, async () => {
      for (const pattern of PATTERNS) {
        const plain = await readPdf(compile(pattern.text, false, engine));
        const marked = await readPdf(compile(pattern.text, true, engine));
        expect(marked.items, `${pattern.name}: glyph positions moved`).toBe(plain.items);
        expect(plain.destinations).toEqual([]);
        // Every mark keeps both destinations, and each relocated end is the
        // vertical-mode form — proof the blank-line relocation engaged.
        const marks = rewriteMarkers([{ path: "main.tex", text: pattern.text }]).marks;
        for (const mark of marks) {
          const begin = marked.destinations.filter((name) => name.startsWith(`lax.${mark.n}.b.`));
          const end = marked.destinations.filter((name) => name.startsWith(`lax.${mark.n}.e.`));
          expect(begin, `${pattern.name}: mark ${mark.n} begin`).toHaveLength(1);
          expect(end, `${pattern.name}: mark ${mark.n} end`).toHaveLength(1);
          if (pattern.relocated.includes(mark.n)) {
            expect(end[0], `${pattern.name}: mark ${mark.n} end mode`).toBe(`lax.${mark.n}.e.v`);
          }
        }
      }
    }, 600_000);
  }
});
