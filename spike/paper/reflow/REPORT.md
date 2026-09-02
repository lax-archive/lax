# Spike: lax markers through ReflowTeX (the paper layer's HTML view)

Measurement spike for paper-web-plan.md stage 0. Everything lives under
`spike/paper/reflow/`; `./run-all.sh` replays the whole suite (26.3 s on this
box), `build-site.py` + `node shots.mjs` the render check. Reference clone:
`radek-p/reflowtex` @ `36f8365eed25ece1db38e0059bcbba3c250802e1`
(AGPL-3.0-or-later), read-only; the one derived artifact is the serializer
patch quoted at the end.

## Verdict

**GO. Markers are exact stream positions — no geometry, no boundary rule, no
mode tags — and injection into the author's unmodified `main.tex` produces the
same stream as the controlled wrapper.** The fixture (3 sections, theorem +
definition + proof, itemize, `equation` + `align`, markers block / inline /
nested / display-wrapping / in the second `\input` file, ids from the real
rewriter) surfaces **14/14 marker instances, in document order, adjacent to
the expected words**, on both the wrapper path and the injected path, under
`article` and `amsart`. Two bounded artifacts around display-wrapping markers
are the whole cost, and one of them turns out to be a live bug on the shipped
PDF path too.

| check | result |
|---|---|
| marker capture (wrapper, patched serializer) | 14/14, order + word-adjacency asserted by `check_markers.py` |
| marker capture (stock serializer) | 0/14 — hypothesis confirmed, see below |
| layout neutrality (marked vs unmarked stream) | identical except 3 display-adjacent paths |
| injected (no wrapper) vs wrapper stream | identical except title block + 2 known paths |
| `amsart` | compiles, 14/14 in order; cosmetic decode diffs only |
| determinism | raw json, transformed json, `nodelist.pb` all byte-identical across fresh dirs |
| render + reflow | 0 missing glyphs; 25 lines at 64rem vs 36 at 34rem |

## Toolchain (P0-1)

`apt-get install --no-install-recommends texlive-luatex texlive-latex-base
texlive-latex-recommended texlive-fonts-recommended fonts-lmodern
texlive-pictures`: 21 packages, **313 MB, 37.6 s** (Ubuntu 24.04).
`texlive-pictures` is not optional: ReflowTeX's `template.tex` hard-loads
`tikz`. LuaHBTeX 1.17.0, TeX Live 2023/Debian (2023.20240207-1), fontspec /
mathtools / amsthm / geometry / setspace all present. Not installed: latexmk
(the pipeline execs `lualatex` directly; the injected path passes
`--jobname`), dvisvgm (no TikZ fixture), protoc (see the pb2 trap below).
Debian's apt trigger prebuilds the luaotfload name database
(`/var/lib/texmf/luatex-cache`), so the first-ever compile cost 1.9 s and warm
ones 0.8–1.2 s — **no cold font-db penalty exists on this box; re-measure in
the pinned container image**, where a first run may pay tens of seconds.

Python side: venv with protobuf 7.36.1 + fonttools 4.64.0. **Trap:**
`Pipeline._ensure_pb2` regenerates `latex_pb2.py` *into the clone* whenever
`latex.proto` has a newer mtime than the committed pb2 — which a fresh clone's
checkout order produced here (0.6 ms newer). Handing the Pipeline a copy of
the proto with an old mtime (`spike.py setup`) sidesteps both the protoc
dependency and the clone write. This also rules out driving
`integrations/vanilla/build.py` as-is (it builds a stock Pipeline, and its
one-block-per-`.tex`-file model cannot see `\input` anyway); `build-site.py`
drives the same Pipeline through the spike wiring instead.

## Marker capture (P0-3) — the headline

`laxweb.sty` lowers `\laxmark{b|e}{n}` (produced by the **real** rewriter,
`dist/submission-validation/paper/rewrite.js`, over `fixture/`) to a
`user_defined` whatsit — `user_id` 90210, string value `"b:<n>"`/`"e:<n>"`,
`node.write` at the current point, legal in both modes — with the same
vertical-mode glue lift as `laxmark.sty`.

**Stock serializer, hypothesis run:** 0 markers surface. The 7 horizontal-mode
whatsits land in paragraph captures as anonymous `{type:"whatsit"}` (9 bare
whatsits = those 7 + the `e` of the equation-wrapping mark trapped in a
glyphless capture + one `\label` `\write`); the 6 vertical-mode whatsits (b2
e2 b3 b4 e4 e3) appear **nowhere** — `walk_page` has no whatsit branch, so
between-paragraph markers are silently dropped, exactly as hypothesized.

**Patched serializer** (diff at the end) surfaces them at both capture sites:
in-paragraph markers as `{type:"marker"}` nodes at their exact node-list
position, vertical-mode markers as `{kind:"marker"}` content-stream items. A
third site was needed that the task list did not predict: `\end{equation}`
directly followed by `% lax end` and a blank line puts the whatsit into a
**glyphless resumed paragraph**, which the walk skips — the patch hoists
markers out of skipped glyphless paragraphs, else e5 vanishes.
`check_markers.py` asserts: exactly one `b` and one `e` per table mark, the
global order `b1 e1 b2 e2 b3 b4 e4 e3 b5 e5 b6 e6 b7 e7` (nesting explicit),
and decoded glyph context per instance (`b2` between `"2 Treewidth"` and
`"Definition 1 (Treewidth)"`, `e5` between the display and `"Equality
holds"`, …). Passes on wrapper, injected, and amsart-injected builds.

### Layout neutrality, measured

Marked (markers stripped) vs unmarked, full-fidelity canonical compare —
**equal except three paths, all display-adjacent**:

- **Trailing space kept** (2 paths): a marker whatsit directly before
  `\begin{equation}`/`align` shields the line-final space glue from TeX's
  end-of-paragraph glue removal (§816) — the interrupted paragraph part keeps
  one 290980 sp space. Invisible (absorbed before `\parfillskip`), and shared
  physics with `laxmark.sty`.
- **Phantom line** (1 path): the `e` whatsit alone in the resumed paragraph
  after `\end{equation}` forces a glyph-free line the unmarked build never
  creates (TeX discards an *empty* resumed segment, not one holding a
  whatsit). Web: the below-display vspace shrinks 786432 → 294912 sp (12 →
  4.5 pt), faintly visible under equation (1) in the shots. **PDF path
  cross-check: this bug ships today** — pdflatex + the real
  `assets/tex/laxmark.sty` on a minimal doc moves the paragraph after the
  display down by **11.96 pt** (y 663.29 → 651.33), one `\baselineskip`; the
  pipeline spike's byte-identical claim holds only because its fixture had no
  display-wrapping marker. The `align` wrapped with text continuing right
  after `% lax end` (mark 6) is clean on both paths, and so is
  `…\end{equation}` + *blank line* + `% lax end`. Candidates: instructions.md
  guidance (blank line before the end marker), a serializer normalization, or
  accepting ±1 baselineskip at that one authoring pattern; spec-notes should
  caveat the PDF claim either way.

**The glue lift earns its keep** here too: with `[nolift]`, the theorem/proof
`\addvspace` sites inflate 524288 → 1048576 sp and 988610 → 1512898 sp (+8 pt
= `\topsep` each, the reflow twin of the PDF spike's 7.97 pt); with the lift
they are exact.

## Determinism (P0-4)

Three fresh-directory compiles: raw `output.json` **byte-identical**; two
fresh full-pipeline runs: post-transform json and `nodelist.pb` (29157 B)
**byte-identical**, converted-font names content-hashed and stable
(`cmmi10.reflowtex-76a9a304.otf`…). No `SOURCE_DATE_EPOCH` needed, no
absolute paths or timestamps found in any output. (LuaTeX's PDF trailer-id
nondeterminism is invisible here — the PDF byproduct is discarded.)

## Transparent derivation (injection, no wrapper)

The promoted probe, per paper-web-plan.md's derivation model. `laxreflow.sty`
reimplements the wrapper's three hooks — luaotfload location precedence,
`dofile("serializer.lua")`, `\AddToHook{shipout/before}` — arms the TikZ
capture behind `\AddToHook{package/tikz/after}` (fires only if the author
loads tikz; unfired here), and pulls `\laxmark` in from `laxweb.sty`. Run as

    lualatex -shell-escape -interaction=nonstopmode --jobname=main \
      "\RequirePackage{laxreflow}\input{main.tex}"

on the fixture's standalone `main.tex` (own `\documentclass{article}`,
`\title`/`\author`/`\maketitle`, `\input{body}`). The explicit `--jobname` is
the paper-plan lesson verbatim: without it the log is `texput.log`. One
driver lesson: the job directory must precede the source dir on `TEXINPUTS`,
or the job's `main.tex` copy loses to the fixture's.

**Result: 14/14 markers, checker green with zero fixture changes**, and the
content stream equals the wrapper's after dropping the title block, except:

- `\maketitle` linearizes to two leading `align=center` paragraphs ("Treewidth
  and colorings", "A. Author") + two vspaces; empty `\date{}` emits nothing;
  folios and running heads are correctly discarded (page furniture never
  produces stream items).
- The e5 phantom-site vspace differs (655360 vs 294912 sp) — same site as
  above; the amount depends on where pages break, which the title block
  shifted. A page-break-position dependence of vspace amounts around that
  artifact, not a new divergence.
- One invisible end-of-paragraph space glue: **every `\input` nesting level
  ending inside a paragraph contributes one space glue** (EOF returns the
  reader mid-line), and the injected build is one `\input` deeper than the
  wrapper. Trailing, before `\parfillskip`, zero visual effect.

**`amsart`** (`--replace-class amsart`): compiles clean (amsthm coexists),
14/14 markers in order; band 23592960 sp = 360 pt adopted automatically;
sections centered; title reaches the stream as real uppercase glyphs
(`\MakeUppercase` — original casing is not recoverable downstream); small-caps
author falls back with a font-shape warning; running heads discarded (45
stream items vs article's 47, no repeated title paragraphs). The only checker
failures are decode cosmetics of my article-tuned expectations: amsart's
"2.Treewidth" section punctuation (kern, not space) and its QED/bullet glyphs
living in 8-bit slots < 0x20 that the spike's decoder shows as `?`. For the
oracle this means: furniture stays out, but glyph-level text comparison must
tolerate class-specific punctuation/casing around headings.

## Edges (P1)

- **geometry** (`[margin=1in]`): paragraph node lists **byte-inert** (zero
  diffs with band fields ignored); recorded bands track `\textwidth`
  22609920 → 30785865 sp (345 → 469.75 pt), which the renderer overrides at
  its own width anyway. Displays are the exception by design: `\[…\]`
  centering kerns (8377635 → 12465608 sp) and align tabskips bake
  `\displaywidth` into the box (+1 sp rounding jitter), absorbed by the
  band-centring contract. Geometry is neutralized for text; wide margins make
  wide display bands (scroll box in the viewer).
- **setspace** (`\onehalfspacing`): per-paragraph `baselineskip` 786432 →
  983040 sp (12 → 15 pt; headings 1179648 → 1474560). Line spacing survives
  reflow, as the per-paragraph capture promises.
- **`\marginpar`**: the note text is captured as its own paragraph (fired
  *before* its host paragraph) but never referenced by the stream — **silently
  dropped**, not spliced, not duplicated. Matches the plan's degradation
  list; an "unreferenced glyph-bearing paragraph" check is a cheap loud
  diagnostic, and the oracle must expect PDF-only marginal text.
- **`\include`/`\includeonly`**: `\include{chapter}` works through its
  `\clearpage` (4/4 markers); `\includeonly` excluding it yields exactly the
  included file's 2/4 — the excluded markers are cleanly absent, which is the
  loud count-check failure lax wants.
- **Class options on the wrapper**: `[11pt]` carries — LMRoman10 `size_sp`
  655360 → 717619 (10 → 10.95 pt). (Injection makes this moot: the author's
  class line rules.)
- **`thebibliography` + `\cite`** (passes=2): `[1]`/`[2]` resolve; entries
  come through as hanging-indent paragraphs (band 1019740+21590180),
  "References" as a plain heading paragraph. Real bibtex/biber untested — the
  pipeline never runs them, only re-runs lualatex.

## Encode + render (P0-2, P2-11)

`Pipeline.compile` on a trivial snippet: `output.json` + `nodelist.pb`
(1306 B) + 4 fonts, 1.2 s warm. On the fixture: in-paragraph marker *nodes*
are stripped gracefully by stock `transforms.strip_unsupported_nodes`, but
stream marker *items* crash `encode_pb` (`KeyError: 'marker'`) — **the stock
schema has no content-item kind for markers, so the production fork must
extend `latex.proto`**; the spike drops stream markers pre-encode instead
(schema was out of scope) and verifies markers on the raw json.

Render: `build-site.py` (Pipeline + the clone's vanilla page template) →
headless chromium (playwright 1.62.1). At a 64rem column: 17 SVGs, 25 line
`<text>`s, block height 904 px; at 34rem: same 17 SVGs, **36 lines, 1179 px —
the reflow proof** — with **0 `.latex-missing-glyph`** and 0 page errors at
both widths (`shots/reflow-1400.png`, `shots/reflow-700.png`). Math is
faithful: subscripted bags, `⊆`/`∈`, theorem/definition styling, the QED box,
resolved `\eqref` and equation numbers. Note the viewer's failure vocabulary
is per-glyph `.latex-missing-glyph`, not a `.latex-block--missing` class.

## Numbers (P1-10)

| thing | size / time |
|---|---|
| TeX install | 313 MB, 37.6 s (21 packages) |
| fixture raw `output.json` | 195,317 B |
| fixture `nodelist.pb` | 29,157 B |
| page html (blob + schema embedded) | 61,269 B |
| viewer + protobuf.js | 111,336 + 100,714 B |
| provisioned fonts | 10 OTFs, 555,628 B (4 LM text + 6 converted CM math) |
| whole page weight | ≈ 829 KB uncompressed |
| lualatex pass (extract) | 0.8–1.2 s warm |
| full pipeline (2 passes + transforms + encode + fonts) | 2.5–2.8 s |
| entire committed suite (`run-all.sh`) | 26.3 s |

## For production

1. The fork (paper-web-plan stage 1) carries exactly this patch shape: the
   marker branch at **both** capture sites, the glyphless-paragraph hoist,
   marker-transparency in the walk's spacing logic (`last_flow`), **plus a
   `latex.proto` content-item kind** so markers reach the browser as anchors.
2. `laxreflow.sty` works as designed pretex; keep `--jobname`, and put the
   job directory first on `TEXINPUTS`.
3. Decide the display-wrapping stance (phantom line): instructions guidance
   vs serializer normalization — and caveat paper-plan's byte-identical claim
   for the shipped PDF path, which has the same 1-baselineskip bug today.
4. The oracle must ignore marginal/unreferenced captures and tolerate
   class-specific heading punctuation and `\MakeUppercase` casing.
5. Re-measure the luaotfload cold cache and the pb2/proto mtimes inside the
   pinned image; never let `_ensure_pb2` write into a read-only vendored tree.
6. Vanilla `build.py` is not the integration surface; drive `Pipeline`
   directly (per-paper single block, `TEXINPUTS` for `\input`).

## Not tested

TikZ pictures end-to-end (hook arms, nothing drawn; no dvisvgm installed);
real bibtex/biber; xcolor; footnotes; floats/figures and `\twocolumn`;
hyperref/microtype coexistence; non-ASCII text and babel; pdflatex-only
documents under lualatex (luatex85 shims); the PDF-vs-stream oracle itself;
chapter-scale documents (sizes here are fixture-scale); the pinned container
image; encoding markers into the pb / browser-side anchors (schema frozen for
the spike); `\iflaxweb`; `compile_many` concurrency; markers in inline math
or moving arguments (PDF spike's list applies); Safari/Firefox.

## The serializer patch

Derived from AGPL-3.0-or-later `radek-p/reflowtex` @ `36f8365eed25ece`
(`src/extract/serializer.lua`); applied by `spike.py setup` onto a runtime
copy under `build/` — the clone is never modified and no ReflowTeX source is
committed to this repository. Same bytes as `serializer.patch`.

```diff
--- a/src/extract/serializer.lua
+++ b/serializer.lua
@@ -129,6 +129,16 @@
 local RULE_IMAGE  = 2
 local picture_files = {}
 
+-- lax spike: \laxmark (laxweb.sty) lowers each lax marker to a user_defined
+-- whatsit with this user_id and a string value "b:<n>" / "e:<n>".
+local LAX_MARK_ID = 90210
+local function lax_marker(n)
+    if n.user_id ~= LAX_MARK_ID then return nil end
+    local side, num = tostring(n.value):match("^([be]):(%d+)$")
+    if not side then return nil end
+    return side, tonumber(num)
+end
+
 Serializer = Serializer or {}
 function Serializer.note_picture(id, file)
     picture_files[id] = file
@@ -208,6 +218,12 @@
                 end
             end
 
+        elseif t == "whatsit" and lax_marker(n) then
+            -- lax spike: a marker inside a paragraph (horizontal mode) is an
+            -- exact position in the captured node list.
+            local side, num = lax_marker(n)
+            cur[#cur + 1] = { type = "marker", side = side, n = num }
+
         elseif t == "whatsit" and n.stack ~= nil and n.command ~= nil then
             -- pdf_colorstack whatsit: update colour state; nothing to emit
             -- (the resolved colour is baked into glyph/rule nodes).
@@ -517,6 +533,15 @@
     end
 end
 
+-- lax spike: markers must be transparent to the spacing logic below, so the
+-- "what did the stream just emit" questions skip over trailing marker items.
+local function last_flow()
+    for i = #content, 1, -1 do
+        if content[i].kind ~= "marker" then return content[i] end
+    end
+    return nil
+end
+
 -- The band of the most recent paragraph; displays inherit it.
 local cur_band = { indent = 0, width = 0 }
 
@@ -531,6 +556,7 @@
             end
             if p and not seen_para[p] and has_glyphs(all_paragraphs[p].nodes) then
                 seen_para[p] = true
+                local lf = last_flow()   -- lax spike: look through marker items
                 if not pending.body_seen then
                     -- First body line on this page: the glue above it is page
                     -- furniture — the top margin, the running header, and \headsep —
@@ -544,10 +570,10 @@
                     -- furniture. In the reflowed (pageless) output the display and
                     -- this paragraph are adjacent, so restore that skip — TeX's own
                     -- parameter, not a guessed constant — or they abut too tightly.
-                    if content[#content] and content[#content].kind == "display" then
-                        emit_vspace(content[#content].below_skip or 0)
+                    if lf and lf.kind == "display" then
+                        emit_vspace(lf.below_skip or 0)
                     end
-                elseif content[#content] and content[#content].kind == "display" then
+                elseif lf and lf.kind == "display" then
                     -- Abutting a display, keep TeX's full glue: above/belowdisplayskip
                     -- carries the display's spacing.
                     emit_vspace(pending.sp)
@@ -559,24 +585,43 @@
                 end
                 content[#content + 1] = { kind = "paragraph", para = p }
             end
+            if p and not seen_para[p] and not has_glyphs(all_paragraphs[p].nodes) then
+                -- lax spike: a glyphless paragraph capture is skipped, but a
+                -- marker whatsit inside it (e.g. `\end{equation}` directly
+                -- followed by the end marker and then a blank line — the resumed
+                -- paragraph holds only the whatsit) must not vanish with it:
+                -- hoist its markers into the stream at this position.
+                seen_para[p] = true
+                local function hoist(nodes)
+                    for _, it in ipairs(nodes) do
+                        if it.type == "marker" then
+                            content[#content + 1] = { kind = "marker", side = it.side, n = it.n }
+                        end
+                        if it.children then hoist(it.children) end
+                        if it.replace then hoist(it.replace) end
+                    end
+                end
+                hoist(all_paragraphs[p].nodes)
+            end
             pending.sp = 0
             pending.explicit = 0
         elseif t == "hlist" and (n.subtype == HL_EQUATION or n.subtype == HL_ALIGNMENT) then
+            local lf = last_flow()   -- lax spike: look through marker items
             if pending.body_seen then
                 emit_vspace(pending.sp)
-            elseif content[#content] and content[#content].kind == "paragraph" then
+            elseif lf and lf.kind == "paragraph" then
                 -- Display first on a page after a paragraph on the previous page:
                 -- its \abovedisplayskip was discarded with the furniture at the
                 -- break. Restore it (the symmetric case to belowdisplayskip above).
                 emit_vspace(param_dimen("abovedisplayskip"))
-            elseif content[#content] and content[#content].kind == "display" then
+            elseif lf and lf.kind == "display" then
                 -- Two displays split by a page break (no glyph-bearing paragraph
                 -- between them, so they are adjacent in the stream). In continuous
                 -- flow TeX separates them by \belowdisplayskip + \abovedisplayskip;
                 -- both were discarded at the break (one as the page-bottom breakpoint
                 -- glue, the other as top-of-page furniture), so without this the two
                 -- displays abut. Restore the pair so the join matches unbroken flow.
-                emit_vspace((content[#content].below_skip or 0) + param_dimen("abovedisplayskip"))
+                emit_vspace((lf.below_skip or 0) + param_dimen("abovedisplayskip"))
             end
             pending.body_seen = true
             pending.sp = 0
@@ -616,6 +661,14 @@
             end
         elseif t == "kern" then
             pending.sp = (pending.sp or 0) + (n.kern or 0)
+        elseif t == "whatsit" and lax_marker(n) then
+            -- lax spike: a vertical-mode marker sits in the page's vertical
+            -- list between line boxes / displays; stock code has no branch for
+            -- whatsits here and would silently drop it. Emitted in place, and
+            -- deliberately not touching `pending`, so glue accounting around
+            -- the marker is unchanged.
+            local side, num = lax_marker(n)
+            content[#content + 1] = { kind = "marker", side = side, n = num }
         end
     end
 end
```
