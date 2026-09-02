# Spike: comment markers -> PDF named destinations

Throwaway prototype of `paper-plan.md` sections *Author-facing contract* and
*Build mechanics*. Everything lives under `spike/paper/pipeline/`.

## Verdict

**It works on all three engines, with zero layout change.** Comment markers the
author never declares become PDF named destinations, and pdf.js reads them back
with page + coordinates. Two things in the plan are wrong as written; both are
fixed below.

| engine | compile | marks found | layout diff vs author build | run1 == run2 |
|---|---|---|---|---|
| pdflatex (TL2023) | ok, 2.7 s | 12/12 real | none | byte-identical |
| lualatex (TL2023) | ok, 3.4 s | 12/12 real | none | byte-identical *(after `trailerid`)* |
| xelatex (docker TL2025) | ok, 18.1 s incl. container | 12/12 real | none | byte-identical |

"12/12 real" = the six genuine markers; the seventh (the verbatim trap) is
correctly absent and correctly flagged. `bibtex` ran in every engine's job dir
(`main.bbl`, 2 `\bibitem`, `[1]`/`[2]` in the text, 0 undefined citations).

## Two corrections to the plan

**1. `-usepretex` breaks `\jobname`.** The plan says latexmk ≥ 4.77 "keeps
`\jobname` right". It does not. latexmk 4.83 turns `-usepretex` into
`pdflatex … "\RequirePackage{laxmark}\input{main.tex}"`, so `\jobname` becomes
`texput`; the PDF is `texput.pdf` and latexmk then fails with *"LaTeX didn't
generate the expected log file 'main.log'"*. latexmk only adds `--jobname` when
the user asks for it (`/usr/bin/latexmk:2543`). **Fix: add `-jobname=%A`.**

**2. The whatsit is not layout-neutral in vertical mode.** A bare `\pdfdest`
between `\end{theorem}` and `\begin{proof}` added **7.97 pt** of vertical space
and moved a page break two lines. Cause: the whatsit terminates the vertical
list, so the `\addvspace` that opens every LaTeX list/theorem/float sees
`\lastskip = 0` and can no longer merge with the glue the previous environment
left; the two skips then add instead of overlapping. **Fix (in `laxmark.sty`):
in vertical mode lift the trailing glue over the whatsit** —

    \DeclareRobustCommand\laxmark[2]{%
      \ifvmode
        \ifdim\lastskip=\z@ \lax@dest{#1}{#2}%
        \else \lax@skip\lastskip \vskip-\lax@skip
              \lax@dest{#1}{#2}\vskip\lax@skip \fi
      \else \lax@dest{#1}{#2}\fi}

`\vskip-\lastskip` rather than `\unskip`, for the same reason LaTeX's own
`\addvspace` does: `\unskip` cannot reach material the page builder already
moved to the current page. With this, every text item in the rewritten PDF is at
a **byte-identical coordinate** to the author's own build, on all three engines
(compared per text run via pdf.js, not just `pdftotext`).

## The engine dispatch that worked

    \RequirePackage{iftex}
    \ifPDFTeX \def\lax@dest#1#2{\pdfdest name{lax.#2.#1} xyz\relax}
    \else\ifLuaTeX \def\lax@dest#1#2{\pdfextension dest name{lax.#2.#1} xyz\relax}
    \else\ifXeTeX  \def\lax@dest#1#2{%
            \special{pdf:dest (lax.#2.#1) [@thispage /XYZ @xpos @ypos null]}}
    \fi\fi\fi

All three worked first try (LuaTeX's `\pdfextension dest … xyz` is correct for
TL2023). The trailing `\relax` terminates pdfTeX/LuaTeX's optional `zoom`
keyword scan. **No duplicate-destination warnings** in any log.

## hyperref coexistence

Yes. The author loads `hyperref` normally; the injected package is loaded
*before* `\documentclass` and never touches it. Drivers autodetected as
`hpdftex` / `hluatex` / `hxetex`. Each PDF carries **29 destinations: 17
hyperref's** (`section.*`, `cite.*`, `thm:forest`) **+ 12 ours**, all resolvable.

## Coordinates

Destinations land exactly on the current point. For the inline marker
(`Lax42.Colorings`, marker at line end around a mid-sentence phrase) pdflatex
gives `b = p1 (285.51, 400.55)`, `e = p1 (389.84, 400.55)` — same baseline,
104 pt apart, and 400.55 is exactly the baseline of that text line. xelatex gives
`(285.50, 399.70)` / `(389.83, 399.70)`; the 0.85 pt is that engine's own
baseline for the line, not a placement difference. The page-spanning marker
(`Lax261Proofs.longproof`) gives `b = p2 (133.77, 531.93)`, `e = p3 (293.64,
477.91)` — `spansPage: true`, and the `b`-before-`e` reading-order check handles
it. Nested marks 3/4 share an `e` coordinate (`p2 133.77, 565.73`): two markers
closing in vertical mode with nothing between them are at the same point. That is
correct but means coordinates alone cannot order two marks; the mark *number*
must stay authoritative.

## Verbatim trap

`% lax begin Trap` inside `verbatim` **is** rewritten textually — the plan is
right that the rewriter must not try to detect verbatim. The compiled PDF then
shows the literal `\laxmark{b}{6}%` (with the trailing `%`) where the author
wrote the marker, so it is visible and ugly. The count check catches it exactly
as designed: 12 destinations for 7 table entries, and the finding names the id —
`mark 6 (Trap): missing begin and end destination in the PDF`. Note both halves
go missing, so one bad marker produces one finding, not two.

## Determinism

With `SOURCE_DATE_EPOCH=1700000000 FORCE_SOURCE_DATE=1`, two compiles from fresh
copies in different directories are byte-identical for **pdflatex** and
**xelatex** out of the box. **LuaTeX is not**: the only differing bytes are the
`/ID` trailer (`<C07545E9…>` vs `<805D0232…>`, offsets 297745–297811). An *empty*
`\pdfvariable trailerid{}` does **not** help — LuaTeX falls back to the random
ID. A **non-empty** value does: `\pdfvariable trailerid{lax}` (now in
`laxmark.sty`, guarded by `\ifLuaTeX`) makes it byte-identical.

## The TEXINPUTS trap

`TEXINPUTS=<dir>//:` as the plan writes it is dangerous when `<dir>` contains
other job directories. In the first full run, xelatex found
`/work/out/pdflatex/run1/main.bbl` through the recursive `//` and used another
engine's bibliography (latexmk warned *"Foreign .bbl file … appears not to be
associated with .aux file from this run"* but still built). `\input{section2}`
survived only because kpathsea tries the cwd first. **Ship `laxmark.sty` in a
directory that contains nothing else, and prefer a non-recursive
`TEXINPUTS=<dir>:`** — which is what `build.sh` now uses.

## Docker

    docker pull texlive/texlive:TL2025-historic

**409.8 s wall clock** (cold, exit 0). `docker image inspect`: **5,485,336,161
bytes (5.49 GB)**, `sha256:4cf679be3f8e…`, linux/amd64. Run flags as prescribed
plus `-e HOME=/tmp` (needed: `-u $(id -u)` has no home, and `luaotfload`/`mktexfmt`
want one).

## pdf.js surprise

`getDestinations()` in `pdfjs-dist` 6.3.289 returns a **`Map`**, not the plain
object older versions returned. `Object.entries(...)` on it silently yields `[]`,
which reads exactly like "the destinations were never written". `extract.mjs`
normalizes both. Extraction of this 4-page PDF: 1.2 s.

## Exact commands

    node rewrite.mjs fixture out/pdflatex/run1 --main main.tex --table out/pdflatex/run1/marks.json

    cd out/pdflatex/run1 && SOURCE_DATE_EPOCH=1700000000 FORCE_SOURCE_DATE=1 \
      TEXINPUTS=/home/jan/git/lax/spike/paper/pipeline: \
      latexmk -pdf -interaction=nonstopmode -halt-on-error \
        -usepretex -pretex='\RequirePackage{laxmark}' -jobname=%A main.tex

    docker run --rm --network=none -v /home/jan/git/lax/spike/paper/pipeline:/work \
      -w /work/out/xelatex/run1 -u $(id -u):$(id -g) \
      -e SOURCE_DATE_EPOCH -e FORCE_SOURCE_DATE -e TEXINPUTS=/work: -e HOME=/tmp \
      texlive/texlive:TL2025-historic latexmk -xelatex -interaction=nonstopmode \
        -halt-on-error -usepretex -pretex='\RequirePackage{laxmark}' -jobname=%A main.tex

    node extract.mjs out/pdflatex/run1/main.pdf out/pdflatex/run1/marks.json

    ./build.sh            # all three engines, end to end

## Not tested

Overlapping-but-not-nested markers, markers in moving arguments or display math,
`listings`, `biber`, `\include` (only `\input`), multi-file numbering beyond two
files, and the 25 MiB / 500 page caps.
