// How a paper is compiled, shared by the host path (`lax build`, latexmk from
// PATH) and the trusted container path (the pinned TeX Live image): the
// command line and the environment are the same, only the executor differs.
// Pure — no I/O.

import path from "node:path";
import type { PaperEngine } from "../contracts.js";

/** The latexmk engine selector; `-pdflatex` alone would be the *command*
 * option (`-pdflatex="…"`), so pdfTeX is `-pdf`. */
export function latexmkEngineFlag(engine: PaperEngine): string {
  return engine === "pdflatex" ? "-pdf" : `-${engine}`;
}

/** The job name TeX writes its outputs under: the entry file's stem. Passed
 * explicitly because `-usepretex` makes latexmk run `<engine> "\RequirePackage
 * {laxmark}\input{main.tex}"`, under which `\jobname` would be `texput` and
 * latexmk would then abort looking for `main.log`. */
export function paperJobName(main: string): string {
  return path.posix.basename(main, ".tex");
}

/** The latexmk invocation, to run with `paper.folder`'s copy as the working
 * directory. Restricted shell escape (TeX Live's default) — never
 * `-shell-escape`, as on arXiv. latexmk runs bibtex or biber when a `.bib` is
 * present and uses a shipped `.bbl` otherwise. */
export function latexmkArguments(engine: PaperEngine, main: string): string[] {
  return [
    latexmkEngineFlag(engine),
    "-interaction=nonstopmode",
    "-halt-on-error",
    "-usepretex",
    "-pretex=\\RequirePackage{laxmark}",
    `-jobname=${paperJobName(main)}`,
    main,
  ];
}

/**
 * The environment of a compile. `TEXINPUTS` is the directory holding the
 * archive's marker packages and nothing else, **non-recursive** (`<dir>:`, not `<dir>//:`
 * — with `//` an engine can pick up another run's `.bbl`); the trailing colon
 * appends TeX Live's default path. The source date makes pdfTeX and XeTeX
 * byte-reproducible (LuaTeX additionally needs the package's trailer id).
 */
export function paperCompileEnvironment(styDir: string, sourceDateEpoch: number): Record<string, string> {
  return {
    TEXINPUTS: `${styDir}:`,
    SOURCE_DATE_EPOCH: String(sourceDateEpoch),
    FORCE_SOURCE_DATE: "1",
  };
}

/** The PDF latexmk leaves in the working directory. */
export function paperPdfName(main: string): string {
  return `${paperJobName(main)}.pdf`;
}

/** The last `limit` characters of a transcript, for a finding: the error is
 * at the end, and the report artifact has the whole log for the rest. */
export function logTail(transcript: string, limit: number): string {
  const text = transcript.trimEnd();
  return text.length <= limit ? text : `[…]\n${text.slice(text.length - limit)}`;
}
