// Generate the committed paper-web bundle fixture for lax-website
// (paper-web-plan.md, "Website" — the site build cannot run lax's pipeline,
// so stage 2's host path derives a bundle once, regenerated on schema
// change):
//
//   npm run reflowtex:fetch
//   npm run paper-web:fixture -- <output-directory>
//
// writes `paper-web.tar` (the sealed bundle) and `paper-web.json` (the
// exact `paper.web` record value plus the fixture's mark table) into the
// output directory. Deterministic: a fixed source date and the pinned
// fork, so regeneration on an unchanged toolchain reproduces the bytes.
// Needs latexmk + lualatex (with tikz and dvisvgm for the picture) and the
// fetched fork — the same prerequisites as test/e2e/paper-web.test.ts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_LIMITS } from "../../src/submission-validation/config.js";
import type { StaticPaper } from "../../src/submission-validation/contracts.js";
import { hostPaperCompiler } from "../../src/submission-validation/host/paper.js";
import { runPaperPhase } from "../../src/submission-validation/paper/phase.js";
import { markIdKind } from "../../src/submission-validation/paper/rewrite.js";
import { rewriteMarkers, texRewriteOrder } from "../../src/submission-validation/paper/rewrite.js";
import { hostWebDeriver } from "../../src/submission-validation/paper/web.js";

const MAIN_TEX = `\\documentclass{article}
\\usepackage{amsmath}
\\usepackage{amsthm}
\\usepackage{tikz}
\\newtheorem{theorem}{Theorem}
\\title{A paper-web fixture}
\\author{A. Author}
\\date{}
\\begin{document}
\\maketitle

We use the standard notion of
% lax begin Lax21.One
one being equal to one
% lax end
as everyone does; efficient offices affirm fluffy waffles.

% lax begin Lax21.Zero
\\begin{theorem}
  \\label{thm:zero}
  $0 = 0$.
\\end{theorem}

% lax begin Lax21Proofs.zero_eq
\\begin{proof}
  By reflexivity.
\\end{proof}
% lax end Lax21Proofs.zero_eq
% lax end

The treewidth of a graph never exceeds its vertex count:
\\begin{equation}
  \\operatorname{tw}(G) \\le |V(G)| - 1.
\\end{equation}

A picture with an arrow and a label:

\\begin{tikzpicture}
  \\draw[->] (0,0) -- (2,1);
  \\node[draw, circle] at (3,0.5) {$x$};
\\end{tikzpicture}

\\input{section}
\\end{document}
`;

const SECTION_TEX = `\\section{A second file}

% lax begin Lax21Proofs.one_eq
The second proof also holds by reflexivity, after touching the assumption.
% lax end
`;

async function main(): Promise<void> {
  const outDir = process.argv[2];
  if (outDir === undefined) {
    process.stderr.write("usage: npm run paper-web:fixture -- <output-directory>\n");
    process.exit(2);
  }
  const submissionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lax-web-fixture-"));
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "lax-web-fixture-job-"));
  try {
    fs.mkdirSync(path.join(submissionRoot, "paper"), { recursive: true });
    fs.writeFileSync(path.join(submissionRoot, "paper", "main.tex"), MAIN_TEX);
    fs.writeFileSync(path.join(submissionRoot, "paper", "section.tex"), SECTION_TEX);
    const files = ["main.tex", "section.tex"];
    const order = texRewriteOrder("main.tex", files);
    const rewritten = rewriteMarkers(order.map((file) => ({
      path: file,
      text: fs.readFileSync(path.join(submissionRoot, "paper", file), "latin1"),
    })));
    if (rewritten.problems.length > 0) throw new Error(rewritten.problems.join("\n"));
    const paper: StaticPaper = {
      manifest: { folder: "paper", main: "main.tex", engine: "pdflatex" },
      files,
      texFiles: order,
      rewritten: new Map(rewritten.rewritten.map((file) => [file.path, file.text])),
      marks: rewritten.marks,
    };
    const result = await runPaperPhase({
      paper,
      submissionRoot,
      jobDir,
      sourceDateEpoch: 1_700_000_000,
      limits: DEFAULT_LIMITS,
      compile: hostPaperCompiler({ echo: false, maxOutputBytes: DEFAULT_LIMITS.maxOutputBytes }),
      deriveWeb: hostWebDeriver({ echo: false }),
    });
    for (const finding of [...result.findings.violations, ...result.findings.warnings]) {
      process.stderr.write(`[${finding.rule}] ${finding.message}\n`);
    }
    const web = result.compiled?.web;
    if (result.findings.violations.length > 0 || web === undefined) {
      throw new Error("the fixture derivation did not produce a bundle — see the findings above");
    }
    fs.mkdirSync(outDir, { recursive: true });
    fs.copyFileSync(web.bundlePath, path.join(outDir, "paper-web.tar"));
    const record = {
      web: {
        format: web.format,
        bundle: { digest: web.digest, bytes: web.bytes },
      },
      marks: paper.marks.map((mark) => ({ n: mark.n, id: mark.id, kind: markIdKind(mark.id) })),
    };
    fs.writeFileSync(path.join(outDir, "paper-web.json"), `${JSON.stringify(record, null, 2)}\n`);
    process.stdout.write(
      `wrote ${path.join(outDir, "paper-web.tar")} (${web.bytes} bytes, sha256 ${web.digest})\n` +
        `and ${path.join(outDir, "paper-web.json")} (format rev ${web.format.rev}, schema ${web.format.schema})\n`,
    );
  } finally {
    fs.rmSync(submissionRoot, { recursive: true, force: true });
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
