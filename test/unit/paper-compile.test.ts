import { describe, expect, it } from "vitest";
import { MIN_LATEXMK_VERSION, parseLatexmkVersion } from "../../src/submission-validation/host/paper.js";
import {
  latexmkArguments,
  latexmkEngineFlag,
  logTail,
  paperCompileEnvironment,
  paperJobName,
  paperPdfName,
} from "../../src/submission-validation/paper/compile.js";

describe("paper compile helpers", () => {
  it("selects the engine the way latexmk spells it", () => {
    // `-pdflatex` alone would be the command option, so pdfTeX is `-pdf`
    expect(latexmkEngineFlag("pdflatex")).toBe("-pdf");
    expect(latexmkEngineFlag("lualatex")).toBe("-lualatex");
    expect(latexmkEngineFlag("xelatex")).toBe("-xelatex");
  });

  it("derives the job name and the PDF name from the entry file's stem", () => {
    expect(paperJobName("main.tex")).toBe("main");
    expect(paperJobName("src/paper.tex")).toBe("paper");
    expect(paperJobName("v2.final.tex")).toBe("v2.final");
    expect(paperPdfName("main.tex")).toBe("main.pdf");
    expect(paperPdfName("src/paper.tex")).toBe("paper.pdf");
  });

  it("builds the latexmk command line with the marker package injected and no shell escape", () => {
    const args = latexmkArguments("pdflatex", "main.tex");
    expect(args).toEqual([
      "-pdf",
      "-interaction=nonstopmode",
      "-halt-on-error",
      "-usepretex",
      "-pretex=\\RequirePackage{laxmark}",
      "-jobname=main",
      "main.tex",
    ]);
    expect(args.some((arg) => arg.includes("shell-escape"))).toBe(false);
    expect(latexmkArguments("xelatex", "src/paper.tex")).toEqual([
      "-xelatex",
      "-interaction=nonstopmode",
      "-halt-on-error",
      "-usepretex",
      "-pretex=\\RequirePackage{laxmark}",
      "-jobname=paper",
      "src/paper.tex",
    ]);
  });

  it("puts only the sty directory on a non-recursive TEXINPUTS and pins the source date", () => {
    expect(paperCompileEnvironment("/opt/lax/tex", 1_700_000_000)).toEqual({
      TEXINPUTS: "/opt/lax/tex:",
      SOURCE_DATE_EPOCH: "1700000000",
      FORCE_SOURCE_DATE: "1",
    });
    expect(paperCompileEnvironment("/opt/lax/tex", 0).TEXINPUTS).not.toContain("//");
  });

  it("keeps a short transcript whole and the tail of a long one", () => {
    expect(logTail("all fine\n\n", 100)).toBe("all fine");
    const long = Array.from({ length: 50 }, (_, index) => `line ${index}`).join("\n");
    const kept = logTail(long, 20);
    expect(kept.startsWith("[…]\n")).toBe(true);
    expect(kept.endsWith("line 49")).toBe(true);
    expect(kept.length).toBe(20 + "[…]\n".length);
    expect(logTail("exact", 5)).toBe("exact");
  });
});

describe("latexmk version probe", () => {
  it("parses the version line and checks it against the -usepretex minimum", () => {
    expect(MIN_LATEXMK_VERSION).toBe("4.77");
    expect(parseLatexmkVersion("Latexmk, John Collins, 31 Jan. 2024. Version 4.83")).toEqual({
      version: "4.83",
      supported: true,
    });
    expect(parseLatexmkVersion("Latexmk, John Collins, 1 Jan. 2021. Version 4.70")).toEqual({
      version: "4.70",
      supported: false,
    });
    expect(parseLatexmkVersion("Version 4.77")).toEqual({ version: "4.77", supported: true });
    expect(parseLatexmkVersion("Version 4.76")).toEqual({ version: "4.76", supported: false });
    expect(parseLatexmkVersion("Version 4.85a")).toEqual({ version: "4.85a", supported: true });
    expect(parseLatexmkVersion("Version 5")).toEqual({ version: "5", supported: true });
  });

  it("returns undefined for output without a version", () => {
    expect(parseLatexmkVersion("")).toBeUndefined();
    expect(parseLatexmkVersion("latexmk: command not found")).toBeUndefined();
    expect(parseLatexmkVersion("Version unknown")).toBeUndefined();
  });
});
