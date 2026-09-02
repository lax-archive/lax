# Spike: pdf.js viewer for `lax.<n>.b` / `lax.<n>.e` ranges

Throwaway, all under `spike/paper/viewer/`: `fixture/main.tex` (3 pages,
`twocolumn`, 6 ranges) -> `site/` (page + vendored pdf.js 6.3.289) ->
`server.mjs` (static, strict CSP) -> `shots.mjs` (playwright).

## What works

All six ranges land on the intended text:

| n | case | result |
|---|------|--------|
| 1 | own-line markers round a `definition` | Definition 1 ... "bag size minus one." |
| 2 | inline 3-word phrase | exactly "a tree decomposition", clipped inside one item |
| 3 | page break, p1 col 2 -> p2 col 1 | stops at "lation would matter."; folio not swallowed |
| 4 | column break, foot of col 1 -> col 2 | last 3 lines of col 1 + top of col 2 |
| 5 | nested in 1 | own colour, layered over range 1 |
| 6 | begin marker at a line start | correct **only** with the mode tag (below) |

Cards sit at the y of their begin point, greedily pushed down, re-stacked on
expand. Highlight click toggles its card; card click scrolls to the highlight.
Text-layer selection lines up with the glyphs
(`shots/text-layer-selection.png`), except under a highlight div, which needs
`pointer-events`.

## The boundary rule

Highlights come from `getTextContent()` item transforms, never the text-layer
DOM. Items stay in **content-stream order** (= reading order: col 1, col 2,
folio) and are cut into *blocks* -- runs of that order, never a re-sort: a block
ends when a baseline rises by > 20 pt (new column) or drops by > 22 pt (heading,
folio).

For a begin point `(page, x, y)` with TeX mode `m`:

0. Pick the block whose bbox contains the point, else the nearest. **Never
   compare y across blocks**: in two columns the same baseline occurs twice
   (p2 has two lines at y=695.17, one per column).
1. `S` = items of that block with baseline within 3 pt of `y` (keeps subscripts
   on their line, well below the 11.96 pt leading).
2. `m = h` (emitted inside a line): first item of `S` whose right edge is past
   `x`; if it straddles `x` the *rectangle* is clipped at `x`, so no
   per-character work is needed. Nothing past `x` -> first item after `S`.
3. `m = v` (emitted between blocks): a non-empty `S` is the *preceding* line --
   pdfTeX reports the baseline of the last line already typeset -- so the range
   starts at the first item after `S`.
4. `S` empty (point between baselines): first item of the block below `y`; if
   the block has none, first item of the **next block** -- that is what makes
   "begins at the foot of column 1" land in column 2.
5. Nothing left on the page -> first flow item of the next page.

End points mirror this (last for first, clip right). Covered items are
`[begin ... end]` in content order, cut per page at `flowSpan`, which drops
trailing single-item blocks far below the text (the folio). Rects merge items
sharing a baseline: one per line.

## The one thing that needs a spec change

`\pdfdest ... xyz` alone is **ambiguous**. In vertical mode pdfTeX reports
`x` = column left, `y` = the baseline of the line *above*; an inline marker that
TeX pushes to the start of a line reports the identical pair for the line
*below*. Geometry cannot separate them. So `\laxmark` here also emits a
mode-tagged twin, `lax.<n>.b.v` / `.h`, chosen by `\ifvmode` -- two extra
whatsits, no cost. `shots/range6-modetag.png` vs `shots/range6-nomode.png`:
without it the fallback heuristic (x at the line's left edge => vertical) drops
the range's whole first line. Ranges 1-5 are identical either way
(`node compare-modes.mjs`), so it matters only for a marker on a column's left
edge -- i.e. any begin marker whose phrase happens to start a line.

Also: `\pdfdest name{...} xyz` scans ahead for the optional `zoom` keyword and
**eats following spaces** -- harmless when the marker is followed by `%`, as the
rewrite guarantees; `\laxmark{e}{2} of` produced "decompositionof".

## Coordinates seen

Vertical-mode marks all have `x` in {72, 310.605}, the two column left edges;
inline marks land mid-line (352.371, 449.556, 172.952, 91.617, 452.711). `y`
either equals a baseline exactly (1.b at 358.33, the line *above*) or falls
between two (1.e at 250.892, between 257.76 and 240.87). Page box 595.276 x
841.89, origin bottom-left -- the same space as the item transforms.

## pdf.js pitfalls

- **`getDestinations()` returns a `Map`**, not the plain object older docs show;
  `Object.entries()` on it silently yields `[]`. `getDestination(name)` works
  either way. `dest[0]` is a `Ref` needing `getPageIndex()`.
- **`Math.sumPrecise`**: pdf.js 6.3 calls it while building fonts. This chromium
  (playwright 1.58) lacks it; the error is swallowed and glyphs vanish --
  "Definition" rendered "De nition", on canvas *and* in the text layer. A 3-line
  polyfill prepended to the vendored files fixes it and cut render from 576 ms
  to 195 ms. Pin an older pdf.js, polyfill, or require Chrome >= 146.
- **Text layer scaling** needs `--scale-factor` *and* `--total-scale-factor` on
  the page container; without them spans render at scale 1.
- `default-src 'none'; script-src/worker-src/connect-src/style-src 'self';
  img-src 'self' data: blob:; font-src 'self' data:` gives zero violations. The
  module worker (`new URL(..., import.meta.url)`) is fine; `connect-src` is
  required for the PDF fetch.
- The `paper.pdf` request always ends `net::ERR_ABORTED`: pdf.js cancels the
  fetch reader once it has the bytes. Cosmetic, but it shows up in logs.
- Type1 CM fonts, no `ToUnicode`, no Type3: item boundaries shift when font
  conversion goes wrong, but highlight geometry never reads `str`.

## Numbers

Warm cache, 1400x1000 headless chromium: load 160-170 ms, destinations 4-6 ms,
3 pages (canvas + text layer) 190-200 ms, total ~375 ms. `pdf.mjs` 860 KB,
`pdf.worker.mjs` 2.23 MB; minified 459 KB / 1.27 MB, gzipped 128/367 KB.

## For production

1. Put the `\ifvmode` tag in `laxmark.sty`, record `mode` per mark, and reject a
   mark whose twin is missing.
2. Run the same boundary rule in the Node extractor: a range resolving to an
   empty span should be a validation finding, not a silent viewer bug.
3. Ship `pdf.min.mjs`/`pdf.worker.min.mjs` + `text_layer.css` + Apache licence.
4. The rail is ordered by *visual* y, so with two columns a col-2 card can
   precede a col-1 card from earlier in the text (`shots/page1-bottom.png`) --
   choose visual y or mark order deliberately.
5. Render pages lazily; 3 pages are cheap, 40 are not.

## Screenshots (`spike/paper/viewer/shots/`)

`page1-top.png` (1, 2, 3 begin) · `page1-bottom.png` (1 + nested 5) ·
`page2-top.png` (3 after the page break; 4 in col 2) · `page2-bottom.png`
(4 from the foot of col 1; 6) · `page3-top.png` (clean) ·
`range6-modetag.png` / `range6-nomode.png` · `click-card3.png` ·
`click-highlight5.png` · `text-layer-selection.png` · `full.png`.
Reproduce: `node server.mjs 8123`, `node shots.mjs`.
