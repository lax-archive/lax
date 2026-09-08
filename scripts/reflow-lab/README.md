# The reflow lab

A local corpus harness for the paper layer's derived web view
(`paper-web-plan.md`). It runs the **production** derivation over a corpus
of real LaTeX papers, builds the **real** lax-website over the results,
screenshots every reflow page beside its PDF, and aggregates a report — so
reflow bugs can be found and fixed locally (in the fork, in
`src/submission-validation/paper/`, in the viewer) and then merged back.

Nothing in the derivation is faked:

- the PDF compile is `containerPaperCompiler` in the pinned TeX Live image
  (`src/submission-validation/paper/container.ts`), and the web derivation is
  `containerWebDeriver` (`paper/web-container.ts`): the `-shell-escape`
  lualatex compile with `laxreflow.sty` injected, the in-image export
  (fonts by name, pictures to SVG through the mounted PyMuPDF), the encode
  child in the fork's hash-pinned venv (`reflowtex/`), marker sanity, the
  oracle, the deterministic bundle seal — all through the same hardened
  `ContainerRunner` with the epoch's production limits;
- the site is `lax-website`'s own `src/cli.ts build` over a synthesized
  `lax-database` directory: the real schema gate (`src/sitegen/paper-web.ts`),
  the real vendored viewer, the real CSS;
- the screenshots are headless Chromium over that site, served from its
  root the way GitHub Pages serves it.

What differs from the Validate job is listed under "Fidelity" below.

## Setup

```sh
npm install                                  # the repository itself
npm run reflowtex:fetch                      # the fork, its venv, PyMuPDF
docker pull texlive/texlive:TL2025-historic  # or let the first derive pull it
(cd scripts/reflow-lab && npm install)       # playwright, for `shots`
(cd scripts/reflow-lab && npx playwright install chromium)   # once, if missing
```

`~/git/lax-website` must be checked out and installed (`npm install` there);
`LAX_WEBSITE_DIR` points elsewhere. `pdftoppm` (poppler-utils) rasterizes
the PDF pages. Everything the lab generates lives under `LAX_REFLOW_LAB`
(default `~/.cache/lax-reflow-lab`), never in the repository.

### Two roots, one convention

Both roots are meant to be moved, and an experiment that changes the
viewer needs both moved together:

- **`LAX_REFLOW_LAB`** is one experiment's whole world — corpus, jobs,
  synthesized database, site, shots, report. Point it at a fresh
  directory (`LAX_REFLOW_LAB=~/.cache/lax-reflow-lab-<topic>`) to run a
  second experiment without disturbing the first's baseline; the skip key
  lives in each job's `lab.json`, so two roots never share cached
  outcomes. Copy `corpus/` across rather than re-materializing it.
- **`LAX_WEBSITE_DIR`** is the lax-website checkout `site` builds with.
  Use a **git worktree on its own branch** (`git -C ~/git/lax-website
  worktree add ~/git/lax-website-<topic> -b <topic>`) rather than the
  main checkout: viewer and schema-gate changes are then committable and
  reviewable on their own branch, `npm install` in the worktree is
  independent, and the main checkout stays clean for everything else.
  Remember that `site` runs the *vendored* viewer and the *real* schema
  gate — a bundle derived under a fork schema the worktree's
  `supported-schemas.json` does not admit is dropped to the PDF-only page
  and `shots` reports "no reflow surface", which is the gate working, not
  a defect.

## The corpus

One directory per paper under `<lab root>/corpus/<name>/`, holding the
paper's sources exactly as the author would submit them (the whole folder
is the `paper.folder`), plus a `lab.json`:

```json
{
  "main": "main.tex",
  "engine": "pdflatex",
  "class": "amsart",
  "source": "arXiv:2204.07670v2",
  "title": "Twin-width can be exponential in treewidth",
  "sourceDateEpoch": 1700000000
}
```

- `main` — the entry file, relative to the entry directory (a contained
  path like `paper/main.tex` is fine); **required**;
- `engine` — `pdflatex` | `lualatex` | `xelatex`, the engine of the PDF
  compile (the web compile is always lualatex, as in production);
  **required**;
- `class` — a free-form label for the document class or venue, for the
  report (`amsart`, `lipics`, `acmart`, `revtex4-2`, …);
- `source` — free-form provenance (an arXiv id, a URL, a note);
- `title` — optional; the record's title on the built page (defaults to the
  name);
- `sourceDateEpoch` — optional; the compile's `SOURCE_DATE_EPOCH` (defaults
  to a fixed `1700000000`, so reruns reproduce bytes).

`lab.json` itself is not copied into the compile; `.git/` and `.lake/`
directories are skipped, as the static gate skips them. An entry whose
`lab.json` is missing or does not parse is reported and skipped, so a
corpus that is still being populated does not block a run. Names are used
as directory names and as record ids (`site/<name>/paper.html`); keep them
to letters, digits, `-`, `_` and `.`.

The corpus papers carry no `% lax` markers, so every mark table is empty;
the rewriter still runs over every `.tex` file, exactly as the static gate
runs it.

## Commands

```sh
npm run reflow-lab -- derive [name…] [--jobs N] [--force]
npm run reflow-lab -- site
npm run reflow-lab -- shots [name…] [--width 1100]
npm run reflow-lab -- report
npm run reflow-lab -- all [name…] [--jobs N] [--force] [--width W]
npm run reflow-lab -- smoke
```

### `derive`

For each corpus entry (or the named ones): build the `StaticPaper` the
static gate would build for a manifest `paper: {folder: ".", main, engine}`
(the same walk, caps, and `rewriteMarkers` call), then `runPaperPhase` with
the container paper compiler and `containerWebDeriver` into
`jobs/<name>/`. `N` entries run concurrently (default 3); each is
time-boxed by the production limits (`limitsFor(epoch())`).

The whole job directory is kept for debugging:

```
jobs/<name>/
  lab.json                  the job record (below)
  oracle-pdf.txt            the oracle's PDF-side tokens, one per line
  oracle-stream.txt         the stream-side tokens — `diff` the two
  paper/src/                the PDF compile copy: <main>.pdf, .log, .aux, …
  paper/web/src/            the web compile copy: output.json (the
                            serializer's node list, after the host's slot
                            rewrite), <main>.log, pics/*.pdf + *.svg,
                            lax-fonts/ (the exported font bytes), the
                            export script and lists
  paper/web/out/            the encode child's output: stream.json,
                            encode.json, blocks/000.pb, fonts/
  paper/web/paper-web.tar   the sealed bundle (when derived)
```

`jobs/<name>/lab.json` records: `status` (`derived` | `web-skipped` |
`pdf-failed`), every finding with `rule` and `message`, the PDF's page
count, digest, bytes and page sizes, the bundle digest/bytes/format, wall
time per step (`timings.pdfCompileMs`, `timings.webMs`, and the container
spans `paper-compile`, `paper-web-compile`, `paper-web-export`; the encode
child is `webMs` minus the two web containers), the `skipRule` the
derivation stopped at, and the recomputed `oracle`.

**The oracle number.** Production reports a similarity only when the
derivation fails, so the lab recomputes it from the kept artifacts with the
code `encodeAndSealWebBundle` runs (`paper/web.ts`): `stream.json` through
the deriver's `parseStreamReport`, the PDF's text layer through pdf.js, and
both into `judgeWebOracle` (`paper/web-oracle.ts`) — assembly with the
furniture stripped (folios, running heads, margin line numbers), the
relocated footnotes settled against the PDF, the PDF's margin text
(`\marginpar` notes) settled against the stream, `subtractUnreferenced` under
its budget, `compareTokens` at the production floor for the verdict and the
divergence. The lab adds one more comparison at 0.5 for the number
(`bounded: true` means the pair is under 0.5 and the number is the bound
the search stopped at). `firstDifference` is where the two compared
sequences first differ whether or not the gate passes, and the two
`oracle-*.txt` dumps are exactly those sequences, one token per line. The
lab restates none of the rules: a change to the oracle changes the lab's
number by itself.

**The skip key.** An entry is skipped when its inputs are unchanged since
its last run: a hash of the corpus files, the fork checkout's HEAD plus a
hash of its working-tree diff (and of `reflowtex/encode_web.py` +
`requirements.lock`), and a hash of `src/submission-validation/paper/*.ts`
+ `assets/tex/*.sty`. `--force` reruns regardless. The key and its parts
are in `lab.json` (`inputKey`, `inputs`).

### `site`

Synthesizes `db/` — one lax-database record per job with a PDF, in the
shape of a real paper record (`record.json`, `owner-list.json`,
`build-output.json` with `paper.pdf` and `paper.web` pointing at the lab's
digests; no concepts, proofs, or marks) — copies the PDFs into
`papers/<digest>.pdf` and the bundles into `bundles/<digest>.tar`, then
runs

```sh
cd $LAX_WEBSITE_DIR && npx tsx src/cli.ts build --database <db> --papers <papers> --bundles <bundles> --out <site>
```

The full site builds as is; nothing is faked beyond the records. The
transcript is in `site-build.log`, and `site.json` records the records the
site's schema gate dropped to the PDF-only page (a bundle whose schema the
vendored viewer does not support — e.g. after a fork experiment that
changes `latex.proto`). `site/<name>/paper.html` is the real generated
paper page.

### `shots`

Serves `site/` from its root on a local port (the viewer resolves the font
map's `data-fonts-base="../fonts/"` against the page), opens each paper
page in headless Chromium, switches to the reflow view (`data-view="reflow"`),
waits for every `.latex-block` to lay out, lets fonts load, dispatches
`beforeprint` (the viewer's own hook that paints every lazily-painted
segment), then records console errors and page errors, the
`.latex-missing-glyph` count, the block/SVG/`<text>` counts, and the
rendered height. It writes

```
shots/<name>/
  shots.json                the stats, both widths
  reflow-<W>.png            the full page at --width (default 1100)
  reflow-<W>-<k>.png        the same, in ~1400 px slices, k from 1
  reflow-700-1.png, -2.png  the narrow rendering, first two slices
  pdf-<k>.png               the PDF's first 4 pages (pdftoppm -r 110)
```

Console errors from the site's comment widget (Remark42's frame-ancestors
refusal on a foreign origin) are counted as `ignoredConsoleErrors`, never
listed. A page without a reflow surface (derivation skipped, or gated) is
noted and only its PDF pages are rasterized.

### `report`

Aggregates `jobs/*/lab.json`, `shots/*/shots.json`, and `site.json` into
`report.json` and `report.md`: a table (name, class, engine, pages, status,
skip rule, oracle similarity, blocks, missing glyphs, console errors, wall
seconds) and, per entry, the warnings under it — every finding, the site
gate line, the oracle's first difference, missing glyphs, render errors,
page and console errors.

### `all` and `smoke`

`all [name…]` is derive → site → shots → report. `smoke` copies
`fixtures/smoke/` (a three-page article with a section, theorems, a list,
an `align`, a footnote, a small table, a tikz picture with transparency,
and BibTeX citations) to `corpus/_smoke/` and runs `all _smoke` — the
harness's self-test, and a quick check that docker, the fork, the website,
and Chromium are all in place.

## Fidelity

What the lab does exactly as production: the static gate's paper half, the
container compile and derivation, the limits, the oracle, the bundle, the
site build, the viewer. What differs:

- `SOURCE_DATE_EPOCH` is a fixed value (or `lab.json`'s), not the commit's
  time — the corpus entries are not commits;
- the paper folder is the entry root (`folder: "."`), so the static gate's
  submission-level checks (manifest, license, the Lean packages, the
  generated-files rule) do not run — they do not touch the paper;
- the records are synthesized: no concepts, no marks, so the cards rail is
  empty and the mark anchors are not exercised; the site build otherwise
  runs whole;
- the Validate job's outer harness (the phase wrapper's workspace cap
  assertion after the phase, the report artifact) is not reproduced; the
  runner's own workspace watchdog during each container run is.

## Reading a result

- `web-skipped` with a `web-*` rule names the derivation's own reason; the
  message is the production warning verbatim.
- An oracle number just above 0.98 with a `firstDifference` is a real
  text loss the gate happens to forgive — `diff oracle-pdf.txt
  oracle-stream.txt` in the job directory shows what.
- Missing glyphs above zero are a font export or font-map problem, never
  the paper's.
- Compare `reflow-<W>-<k>.png` with `pdf-<k>.png` for layout: float
  placement follows the shipout order (a figure lands where the print put
  it, not where the source has it), and footnotes are lifted out of the
  page — set as sidenotes where the page has a margin rail, as endnotes
  otherwise.

## Results

The lab's first campaign is the record in
`history/reflow-maturation-20260908.md`: three rounds over 44 papers, the
per-round derived counts and the target book's similarity, every defect
class it found with its mechanism and fix, and the lessons — including the
two that are about the harness itself (an order-sensitive oracle charges
declared relocations twice, and a corpus convention that disagrees with
the production contract costs entries, not defects). Read it before
starting a second campaign; the open items it leaves are in TODO.md under
the paper layer.
