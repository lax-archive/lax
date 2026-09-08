# The reflow web view's maturation pass (2026-09-08)

Closed record of the day spent making the derived web view (ReflowTeX,
`paper-web-plan.md`) render a real paper the way its PDF does. The layer
had shipped on 2026-09-02 and had been exercised by exactly two records
(lax-48, lax-65) and one tikz fixture; this pass ran it over 44 real
papers, found what breaks, and fixed it. The measurements below come from
the lab's own report and job records under `~/.cache/lax-reflow-lab`.

Nothing here is a plan. The work lands through the deploy gates TODO.md
lists (fork push and pin bump, website merge, fixture recut, renderer
release, production revalidation); at the time of writing it sits on the
fork's `lab` branch, in the lax working tree, and in the
`lax-website-reflow` worktree.

## The goal

Jan, that morning: make the reflow view render like the PDF; iterate
locally over a corpus of real papers rather than one submission at a time;
then deploy. The target paper was **lax-157538**, the Transducers book —
179 pages, Libertine, a `\includegraphics[page=N]` figure file, footnotes,
`lineno`, `bbm` — for which the archive had derived no web view at all.
The bar for deploying: round 3 clean on the book, no regression against
round 2, screenshot triage clean.

## The lab

`scripts/reflow-lab/` (its README is the reference; `npm run reflow-lab --
derive|site|shots|report|all|smoke`). Nothing in it is faked: **derive**
runs the *production* derivation — the static gate's paper half,
`containerPaperCompiler` and `containerWebDeriver` in the pinned TeX Live
image, the in-image export, the encode child in the fork's hash-pinned
venv, the marker sanity check, the oracle, the bundle seal — under the
epoch's production limits; **site** builds the *real* lax-website over a
synthesized `lax-database`, so each record meets the real schema gate and
the real vendored viewer; **shots** drives headless Chromium over that
site; **report** aggregates it all.

The corpus is 44 papers — 30 of Jan's own repositories, 13 arXiv e-prints,
and lax-157538 — plus the harness's own three-page `_smoke` fixture, 45
entries in all, in 19 document classes (`corpus-notes.md`). None of it is
committed anywhere; the arXiv slice is a local fixture only.

One thing the lab does that production does not: production reports an
oracle similarity only when the derivation *fails*, so the lab recomputes
it from the kept artifacts — by calling the deriver's own code
(`judgeWebOracle`), not by restating the rules, so a change to the oracle
moves the lab's number by itself.

## The three rounds

| | derived | web-skipped | of those: oracle / compile / unreferenced-cap | pdf-failed | refused by the static gate |
|---|---:|---:|---|---:|---:|
| baseline (07:42) | 3 | 27 | 15 / 8 / 4 | 10 | 3 |
| round 2 (08:20) | 4 | 35 | 24 / 11 / 0 | 3 | 3 |
| round 3 (10:16) | 16 | 26 | 20 / 6 / 0 | 3 | 0 |

(The baseline ran 44 entries — `_smoke` was skipped as unchanged; rounds 2
and 3 ran all 45.)

lax-157538 across the same rounds: **0.9493 → 0.9421 → 0.9903**, against a
0.98 floor. (The book joined the corpus after the baseline sweep, so its
first number comes from its own run at 07:39, `derive-157538.log`.) Round
3's run: 429 s wall (55.7 s PDF compile, 293 s web
compile, 12.3 s export), 70 208 PDF against 69 981 stream tokens, 313 folio
lines and 2 running-head lines stripped, 52 margin line numbers stripped,
15 relocated footnote paragraphs (703 tokens) all matched in the PDF, no
unreferenced captures at all.

Round 2 going *down* on the book while going up in aggregate is the pass's
most useful single number; the reason is in "Lessons" below. The three
`pdf-failed` entries (`history-thesis`, `mw-mc`, `transducer-book` — the
repo-root copy of the same book lax-157538 carries as a submission folder)
never reach the web view: their PDF compile fails first, corpus-side.

### Rounds 4 and 5

Round 4 (12:01) was invalidated by the machine, not the code: the validation
host refuses to derive under 5 GiB free, and the parallel lab roots plus
scratch copies had eaten the disk — most entries came back `pdf-failed` or
`web-derivation` ("less than 5 GiB free"). Round 5 (13:07, disk recovered,
everything integrated: oracle normalizations, clipped-figure capture,
footnote references, heading skips, apostrophe drop; the four compile shims
landed mid-round) was stopped at Jan's wrap-up after 36 of 45 entries:
**24 derived**, 9 oracle skips (all in the residual classes above: two
R-plot papers at 0.92, the Euler/Palatino thesis at 0.88, the memoir book
at 0.95, the rest 0.96–0.98), one web-compile skip (`decomposition-trees`,
run before the acmart shim was in), two source-level PDF failures
(`history-thesis`, `mw-mc`). lax-157538 derived at **0.9944** (0.9493 →
0.9421 → 0.9903 → 0.9944 across rounds 1/2/3/5).

## What was broken

Grouped by the layer that owns the fix. Every class below was found by
comparing a rendered page or the oracle's two token dumps against the PDF,
never by reading code alone.

### The shipout walk (the fork, `src/extract/serializer.lua`)

The walk told exactly two box shapes apart — columns and everything else —
and everything else became a synthesized paragraph. That single
coarseness produced most of the corpus's content loss:

- **Two-column bodies, short captions, `\centerline`, class title blocks.**
  A plain hlist in a vertical list was dropped outright. In the baseline
  this was the top failure mode: four papers skipped on
  `web-unreferenced-cap` at similarities near 0.50 (`approxmso` 0.4997,
  `arxiv-1801-00125` 0.4987) — their captions *were* captured, so the
  omission surfaced as "the stream never references this paragraph".
  Columns are now walked in reading order and inky boxes become
  re-breakable synthesized paragraphs.
- **Rules.** Vertical rules vanished and a rule-only paragraph failed the
  ink gate; rules now become rule displays.
- **Footnotes.** They surfaced wherever TeX had floated them, at page
  bottoms in the middle of the prose. They are now emitted as endnotes
  behind TeX's own footnote rule, and (see the oracle) declared as moved.
- **Running heads and folios.** The page body was located by the kernel's
  `\@outputpage` anatomy alone; `laxreflow.sty` now stamps `\@outputbox`
  with attribute 905 just before `\@outputpage` runs, and the walk prefers
  a stamped vlist — identification rather than guesswork.
- **`lineno` frames and margin decorations.** Every LIPIcs submission
  version carries line numbers as zero-width boxes `\hss`-ed into the
  margin; each became a paragraph holding one number, and an output
  routine that re-wraps a line to decorate it hid the line inside a box
  the walk read as text. Two more shapes are told apart now: a box holding
  a stamped line or a display at any depth is a *frame*, walked with line
  and display semantics; a box whose ink lies wholly outside its own
  horizontal extent is a *margin decoration* and is dropped, its height
  and depth kept as pending glue.
- **Headings that open a page.** `\@startsection` puts the beforeskip
  above the heading with `\addvspace`, and TeX discards that glue with the
  top-of-page furniture; the walk discarded the furniture too and could
  not tell them apart, so such a heading was welded to the paragraph
  before it (`quelim` §2 and §3, `parity`'s run-in "Results."). The skip
  is not guessed back: `laxreflow.sty` records `\lastskip` as `\@sect` /
  `\@ssect` begins in a whatsit below that glue, which survives the break
  the glue does not.

### The encode (the fork's Python side, and `reflowtex/encode_web.py`)

- **Private-use math.** Converted 8-bit math faces gave a real codepoint
  only to glyph names inside a short allowlist, so every operator and
  relation landed at `U+E000 + slot`: 24 distinct PUA codepoints in lax-48
  alone, copy and find-in-page both useless. Names now resolve through
  texglyphlist (the table pdfTeX builds its ToUnicode maps from) plus AGL
  and a suffix rule for size and style variants.
- **Ligatures, small caps, old-style figures.** An OpenType face sets them
  at private codepoints (Libertine's `Th`, `ft`, `.sc`, `.oldstyle`), so
  the stream read "e" for "the" — the largest single term in the book's
  baseline oracle. A glyph whose codepoint is not its text now carries a
  `text` field, and the oracle prefers it.
- **Characters the font could not set.** LuaTeX keeps a zero-metric glyph
  node for a missing character; the converted OTF's cmap then gave that
  slot to a glyph the font *does* carry, drawn with a zero advance and
  stacked on the next letter — `al.'s` rendered as `al.ŝ`
  (`recursive-backdoor`, the only font-level defect the corpus turned up).
  Such nodes are now filtered out.
- **Listing glue.** Zero-width glue — `listings`' `\hss` around each
  column-aligned character, `\hfil`, `\hspace{0pt}` — was a word break on
  the oracle's stream side, reading "f o r" for "for" where pdf.js reads
  no space. Only glue with natural width is a break now.

### The trusted export (`paper/web-container.ts`, `laxreflow.sty`)

- **`\includegraphics[page=N]`.** One multi-page PDF holding every figure
  of a paper, addressed by page, is how whole books ship theirs — and every
  such figure was the file's first page or nothing. The page now travels
  with the file: `laxreflow.sty` passes `\Gin@page` to the serializer, the
  host keys a slot by *(file, page)*, and the converter refuses a page the
  document does not have rather than substituting one.
- **Picture text sidecars.** A tikz label or a vector figure's internal
  lettering is in the PDF's text layer and not in the node list, so every
  picture cost the oracle its own text. The converter now writes each
  vector picture's page text beside its SVG as a bounded `<slot>.txt`, and
  the encode child folds it into the oracle's stream at the picture's
  position — oracle data only, never rendered, never trusted.

### The oracle (`paper/web-oracle.ts`)

- **Relocated footnotes.** The stream deliberately moves footnotes to the
  end while the PDF keeps them at page bottoms, and an order-sensitive
  comparison charges each one *twice* its length for the move. The fork
  now marks a footnote's paragraphs with its ordinal, and `relocateRuns`
  settles each declared run on its own — removed from the PDF side when
  the PDF carries it contiguously, appended to the stream side when it
  does not, so text one substrate lacks still counts as divergence. No
  budget bounds this and none is needed: only order evidence is given up.
- **Margin line numbers.** `lineno`'s numbers sit in the text layer and
  pdf.js glues each onto its line's last word (`width1`, `bounded5`) — a
  divergence the stream, which drops margin decorations, can never show.
  `stripMarginNumbers` is geometric: a digits-only item is a line number
  only when it lies wholly outside the page's own measured text column, by
  more than 2 pt. Items without geometry are never stripped, which is why
  `extract-destinations.ts` now emits `[str, eol, x, y, width]`.
- **One verdict.** Assembly, tokenization, relocation, subtraction and
  comparison are now a single `judgeWebOracle`, called by the deriver and
  by the lab; `web.ts` used to sequence the steps itself and the lab had
  to restate them.

### Compile shims (`assets/tex/laxreflow.sty`, `config.ts`)

The web compile is lualatex with `-shell-escape` under an injected
package, and that combination breaks documents the author's own pdflatex
build compiles fine:

- **luatex85** is loaded before the author's class, so packages that still
  probe `\pdftexversion` (xy-pic's pdf driver refuses to run without it)
  see the aliases.
- **tikz-cd** under externalization: the external library's collector
  reads a picture's body up to `\end{tikzpicture}` and overshoots a
  `tikzcd`. Inside every `tikzcd` the collector is told which environment
  to stop at, and the library's end-of-picture command is made to end it.
- **tcolorbox** under externalization: a skin draws its frame with
  tikzpictures from inside its own conditionals, and the skip-collector
  leaves a stray `\else` behind. `shield externalize` is armed globally
  when the package loads — so the boxes typeset inline and their *text*
  reaches the stream, while their frames (pgf literals) do not.
- **`paperWebCompileTimeoutMs`, 30 minutes**, its own limit rather than the
  PDF compile's 10: tikz externalization re-runs the whole document once
  per picture, so a long figure-rich paper costs figures × pages. The
  derivation is non-blocking and runs concurrently with the Lean chain.

### The viewer and the site (`lax-website-reflow`)

- **Numbered display equations** lost their number and were set flush
  left: the tag was parked outside a silent horizontal scroll box while
  the body, unable to centre beside it, pinned to the left edge. amsmath
  tags and `\eqno` boxes are now painted flush right on the row's
  baseline when the centred body leaves room, else on their own line, and
  the scroll box appears only when the body itself overflows.
- **Wide pictures** were not scaled and bled off the page — asymmetrically,
  so lax-48's Figure 1 lost three nodes off the left edge with nothing to
  warn the reader. A picture chain wider than the band, kerns included,
  now gets one uniform scale, so composition survives.
- **First paint** was a full-document flash of unstyled text at different
  metrics (lax-48 grew 47 px between the two captures); it now waits for
  the injected faces, capped at 3 s.
- **Right insets** (an abstract, a quotation) were lost — the left indent
  survived and the right did not. The fork carries `Paragraph.width`
  (wire field 7) and the viewer keeps the band.
- **Rules, preset paragraphs, picture lines.** A lone rule in a paragraph
  (the LIPIcs abstract rule) and a rule display kept their compile width —
  38 % over the reader's measure — and are now fitted to the column; a
  paragraph that is one vlist of pre-broken lines (a `\parbox` caption) is
  unboxed and re-broken instead of overhanging. Wide displays sit in a
  frame whose pannable edges fade, so a scroll box is visible as one.
- **The schema gate** admits the fork's schema (fnref nodes,
  `footnote_ref` items, `Paragraph.footnote`), the decoder tables read
  them, and the intermediate width-only hash that never shipped is
  dropped.

## Residual oracle

Round 3 still skipped 20 entries on `web-oracle` (0.8534 to 0.9799), so
all 20 were decomposed into `diff --minimal` hunks — a decomposition that
*is* the oracle's Myers metric, verified by re-implementing `web-oracle.ts`
against pdf.js and reproducing every job's similarity to six decimals.
27 481 divergence tokens fall into: token-boundary skew in math **33 %**,
moved text — floats and captions — **22 %**, math-font glyph asymmetry
**21 %**, token-boundary skew in words **10 %**, and text inside included
figures **6 %**.

Three oracle-side normalizations take **12 of 20 over the floor**, from
zero: (A) a merge-tolerant comparison, where a hunk whose two sides
concatenate to the same characters is no divergence at all (10 of 20 by
itself); (B) character-level run matching in `removeTokenRun`, which also
drives `relocatedUnmatched` to zero everywhere; (C) folding U+2206 to
U+0394 in `oracleTokens`, one line. The obvious fourth — dropping
single-character tokens — was measured and rejected: it *lowers* similarity
on 14 of 18 jobs, removing more matched tokens than divergent ones.

**The lesson is the count of real defects that survived.** After the
normalizations, nothing in 20 papers was what the oracle exists to catch —
the view dropping text the PDF sets — except one: a clipped
`\includegraphics` that attribute 902 never stamps, so two papers lose
their figures and their figure text. The rest is substrate fidelity (a
font decode gap, cmex/cmsy slot letters) or float ordering, which is a
question about what the renderer should *declare*. An oracle paid mostly
in false positives gets loosened eventually, for the wrong reason;
measuring the residue before touching the floor is what avoided that.

## What the corpus itself cost

Six entries never reached the derivation, for reasons that were the
harness's and not the code's — both of them the production contract being
taken seriously. Three (`bounded-exp-erdos`, `bounded-exp-erdos-sofsem`,
`monadic-stability`) were refused by the static gate's 50 MB paper-folder
cap, because the corpus was materialized with the *repo root* as the
entry: 66 MB of slides and 36 MB of reference PDFs the paper never reads.
Three (`preprocmso`, `struc-bound-exp`, `recursive-backdoor-constraintsj`)
had their class file and `.bst` beside the main document in a
subdirectory — `aaai24.sty`, `lmcs.cls`, `sn-jnl.cls`, none of them in TeX
Live — while latexmk runs with the *entry root* as its working directory,
so none was on the search path. Both were fixed in the corpus (entry root
= the document's own directory), and the baseline's 10 `pdf-failed`
entries fell to 3.

## Lessons

- **An order-sensitive oracle makes moved text cost double.** Every
  relocation the renderer performs deliberately — footnotes today, floats
  tomorrow — is charged twice by an LCS comparison unless the stream
  *declares* the move. The fix was not to loosen the floor; it was to make
  the renderer say what it moved, and settle those runs separately. This
  is also why round 2 lowered the book's similarity while raising the
  corpus's: round 2's page walk started emitting footnotes as endnotes,
  which is right, and paid double for it until round 3 declared them.
- **Rules belong at boundaries, not at call sites** — the same diagnosis
  as the 0.1.35 audit (`history/audit-20260903.md`). The oracle's rules
  were sequenced in `web.ts` and would have been sequenced again in the
  lab; they are now one `judgeWebOracle` that both call. The picture
  page, likewise, is validated once where the slot is assigned rather than
  at each consumer.
- **A harness convention that disagrees with the production contract
  breaks the experiment, not the product.** Six of 44 corpus entries were
  lost to "the entry root is the repo root", which is not what a
  `paper.folder` means. The lab is worth having precisely because it does
  not relax the gate.
- **Measure before claiming.** Several screenshot readings that looked
  like defects were not: text apparently running under the mark cards (the
  gutter is clean, x=747 against x=798), highlights overshooting their
  passages (4 px tail), dropped prose (a token diff showed none). The
  equation number "deleted by the renderer" was in the DOM the whole time,
  56 px right of a scroll box with no affordance — a layout refusal, not a
  data loss. The residual study above is the same discipline applied to
  the oracle: 33 % of its complaints were token boundaries.
- **One paper is not coverage.** The layer had been exercised by two
  records; 44 papers in 19 classes found six page-walk defects, four
  encode defects, and six compile classes in one day.

## What stays open

All of it in TODO.md, under the paper layer: the six web-compile classes
still failing or shimmed, the residual oracle classes for the papers still
under 0.98, the deploy gates, sidenote rendering, tcolorbox callout frames,
hyperlinks in the reflow view, the fixed-measure column at wide viewports,
and the upstreaming candidates for `radek-p/reflowtex`.
