# Paper web view — plan

Status: proposed 2026-09-02 from the reflow design discussion;
adversarially reviewed the same day and revised — the review's anchor
audit, trust findings, and gap list are folded in below. **Stage 0
executed the same day: GO** — see "Spike results" at the end and
`spike/paper/reflow/REPORT.md` for the full measurements. Design
decisions recorded here are fixed unless Jan revisits them; stage order
and caps are suggestions. This plan builds on the PDF
paper layer (paper-plan.md); its stages are independent of paper-plan
stages 4 and 6, but **web stage 5 depends on paper-plan stage 5** — the
`~/.lax/papers` cache and `lax serve` paper wiring do not exist yet, and
the web bundles ride on them.

## Goals (Jan, 2026-09-02)

- **Transparent.** A declared paper gets an HTML view with no new manifest
  requirements, no source restructuring, and no new author vocabulary. The
  author writes a normal paper; the web render happens on its own.
- **Failures are reflow-internal.** The residual failure class is rendering
  quality, never contract friction — and every failure surfaces as a
  recorded reason, never as a validation failure.
- **One source.** The author's actual `main.tex` feeds both targets. The
  PDF remains the canonical, archival, digest-bound object; the web view
  is a derived presentation surface, regenerable at any time.

## What this adds

Beside the compiled PDF, the archive derives a reflowable HTML rendering
of the same paper. The mechanism is ReflowTeX
(github.com/radek-p/reflowtex, AGPL-3.0-or-later, alpha): LuaTeX compiles
the document while a Lua serializer captures the finished node list —
paragraphs *unbroken* (`pre_linebreak_filter`), displays as finished
boxes at the shipout walk, page furniture discarded — and a browser
viewer runs Knuth–Plass line breaking at the reader's width and paints
inline SVG. Line width, zoom, and theme become reader parameters;
intra-line typesetting stays genuine TeX. The site's paper page renders
this beside (or instead of — a layout decision, cheap to change) the
pdf.js canvas, and the marked-passage cards attach to exact stream
positions instead of extracted page geometry.

## Derivation model: injection, not splitting

The web compile takes a **fresh rewritten copy of its own**
(`paper/web/src` in the job directory, never the PDF compile's
`paper/src` — sharing the directory would overwrite `main.pdf` under
`-jobname` and fail the whole validation at the digest re-hash in
`outputs.ts:153-163`, besides stale-aux hazards) and injects everything
it needs the way `laxmark.sty` is injected today: latexmk's
`-usepretex -pretex='\RequirePackage{laxreflow}' -jobname=<main stem>`
(the `-jobname` lesson from paper-plan.md applies verbatim), running
lualatex regardless of the manifest's `engine` (which keeps governing the
PDF). `laxreflow.sty` — lax-authored, Apache-licensed, only *loading* the
AGPL serializer — installs, before the author's class:

- the luaotfload location-precedence fix (texmf first);
- the node-list serializer (`dofile`), our fork;
- the shipout hook (`\AddToHook{shipout/before}`);
- the TikZ externalization capture, deferred behind
  `\AddToHook{package/tikz/after}` so it applies only if tikz loads (the
  `pics/` prefix directory must be pre-created — tikz will not);
- the web lowering of `\laxmark`: a `user_defined` whatsit at the current
  point carrying side and mark number — an exact stream position, legal in
  both modes, replacing the PDF path's destination geometry entirely (no
  boundary rule, no `v`/`h` tags, no coordinates on this target).

A best-effort preamble/body splitter feeding ReflowTeX's stock wrapper
template was considered and **rejected**: to reach transparency it must
honor the author's own documentclass anyway, at which point it reduces to
disassembling and reassembling the document TeX already knows how to read.
Injection inherits every boundary/option/class decision from TeX itself;
the splitter's residual failures would have been contract failures, while
injection's are reflow-internal — exactly the failure class the goals
accept. (The spike compared both: injection reproduced the wrapper's
content stream on the fixture, under `article` and `amsart` — see Spike
results.) One driver lesson from the spike: the job directory must
precede the source directory on `TEXINPUTS`, or the job's rewritten
`main.tex` loses to the original.

## Author-facing contract

Almost none — that is the point — but the one key it does add is a real
manifest change, not a footnote:

- **`paper.web: false`**, the opt-out, ships with web stage 2. It touches
  the whole manifest-threading checklist (the `supersedes` commit 84f6c77
  is the model): `PAPER_KEYS` and the paper-block validator
  (`validators/manifest.ts:22`, :190-193), `PaperManifest` in
  `contracts.ts`, the embedded-manifest exactObject in
  `artifact-schema.ts:420`, scaffold, docs, and the three test files. An
  author who writes the key against an older CLI gets a local unknown-key
  violation — acceptable, and the reason the key ships early rather than
  "when someone asks": later means no author recourse while derivation is
  already running for everyone.
- Markers, the rewriter, and the PDF path are untouched. The same marker
  grammar feeds both compiles; only the injected package differs.
- `laxreflow.sty` (and `laxmark.sty`, as a no-op) define `\iflaxweb`, so
  an author *may* guard print-only material (marginalia, a
  `\pageref`-bearing sentence) — optional, additive, documented in
  `instructions.md` with the degradation list (marginal notes, float
  placement, page references; geometry/margins are neutralized by design
  and need no guard).
- One authoring note the spike forces: an end marker **directly** after
  `\end{equation}`-style displays, with a blank line after it, leaves a
  whatsit-only resumed paragraph — a phantom line worth one
  `\baselineskip`, and **the same pattern is a live ~12 pt shift on the
  shipped PDF path today** (paper-plan's byte-identical claim holds only
  for fixtures without display-wrapping markers; spec-notes owes the
  caveat). Guidance in `instructions.md`: put a blank line before an end
  marker that follows a display (both paths are then clean); a
  serializer-side normalization stays a knob if guidance proves
  insufficient.

## Build mechanics

- **Compile** in the same pinned TeX image (`PAPER_IMAGE` in
  `pins.ts:49`), through the same runner, on the web copy, after the PDF
  compile inside the existing paper phase (`startPaperPhase`,
  `pipeline.ts:406`, still started before the runtime check :530 and
  still concurrent with the Lean chain). Deviation from the PDF compile's
  flags: the web compile runs with `-shell-escape`, which tikz's external
  library requires for its picture sub-runs — contained by the sandbox
  (no network, read-only root, caps, no Lean mounts; Compile already
  executes arbitrary author code) and used by nothing else; the PDF
  compile keeps restricted shell escape for arXiv parity. Consequence
  owned below: dvisvgm-raw specials let a paper inject arbitrary SVG, so
  the encode step sanitizes (see the fork).
- **What leaves the container**, enumerated and bounded: `output.json`
  (read through a size-capped reader — a chapter-scale document produces
  tens of MB), the externalized tikz pictures (converted to SVG
  in-image, sanitizer still applied host-side), and the font files the
  run actually used — **including legacy Type1 outlines (`.pfb`) for
  8-bit math faces**, which the conversion consumes as its *only*
  outline source so a missed export fails loudly instead of being
  masked by a host tree (stage 3's `REFLOWTEX_PFB_DIR`; without it,
  every math-bearing paper would lose its web view on the TeX-less
  Validate host). Nothing else; count, byte, and timeout caps on the
  export.
- **Serializer fork.** Our fork of ReflowTeX (serializer + encode) adds:
  the marker branches the spike validated (**three** sites, not two —
  inside paragraphs, in the shipout walk between them, and the
  glyphless-resumed-paragraph hoist — plus `last_flow` transparency so
  markers don't perturb the walk's display-spacing logic; the spike's
  `serializer.patch` is the shape to productionize), a **`latex.proto`
  marker content-item kind** (stock `encode_pb` crashes on stream
  markers — `KeyError: 'marker'` — so the schema extension is mandatory,
  with `latex_pb2.py` regenerated via a hash-pinned `grpcio-tools`
  rather than an apt protoc; and `_ensure_pb2`'s mtime trigger must
  never write into the vendored tree), an SVG sanitizer in picture
  conversion (element/attribute allowlist — CSP is defense-in-depth, not
  the only wall), a runner-mediated seam for dvisvgm (upstream
  `transforms.py` shells out directly; ours converts pictures through
  the pinned TeX image via the container runner, so no host dvisvgm
  exists), and deterministic protobuf serialization (measured already
  byte-stable; made explicit). Home:
  a public **`lax-archive/reflowtex` fork repo** (creation is Jan-owned),
  consumed at a pinned rev recorded in `pins.ts`, fetched in the workflow
  the way the page-builder is (`page-builder:fetch` pattern) — **AGPL
  bytes never enter the Apache-labelled npm tarball** (the `lax` package
  publishes `assets/`, so `assets/reflowtex/` is not an option). Until
  the fork repo exists, development pins the upstream clone rev.
- **Encode** (Python: `protobuf`, `fonttools`) runs as a capped child
  process on the host of the Validate job — the pdf.js-extraction
  precedent holds only with provenance closed: the workflow installs a
  **hash-pinned** Python environment (`pip install --require-hashes`
  against a lock in the fork), and `protoc` is not needed at build time
  (the fork commits its generated `latex_pb2.py`). Credential-free job,
  untrusted input, bounded output, own timeout — the pdf.js rules.
- **The oracle — in the paper phase, not the join.** The join piece stays
  milliseconds (the paper-plan doctrine). After both compiles, still
  inside the concurrent paper phase, the oracle extracts the PDF's text
  (pdf.js, already present) and the stream's glyph text and requires the
  token sequences to agree within tolerance. Normalization is specified,
  not hand-waved: hyphenation (the stream holds unbroken paragraphs with
  disc nodes; the PDF has applied hyphens), ligature decomposition via
  the PDF's toUnicode, furniture stripping on the PDF side only, plus
  two tolerances the spike established: unreferenced captures
  (`\marginpar` text is captured but never referenced — PDF-only
  marginal text must not count as divergence, and an "unreferenced
  glyph-bearing paragraph" check is the cheap loud diagnostic for it)
  and class-specific heading punctuation and `\MakeUppercase` casing
  (amsart titles reach the stream as uppercase glyphs).
  Divergence ⇒ the web view is skipped with the first mismatch location.
  This converts reflow's silent misread class into loud, attributable
  skips.
- **Non-blocking, by the finding vocabulary.** A successful report must
  carry zero violations (`artifact-schema.ts:106`), so every
  web-derivation failure — lualatex error, marker count mismatch in the
  stream, oracle divergence, cap overrun — is a **warning** finding on
  the existing `paper` phase with `web-*` rule names: `paper.web` is
  omitted, the reason and log tail ride the report artifact and `lax
  submit` (`carryWarnings`, `commands.ts:403`) for free, and nothing else
  changes. Marker *validation* stays anchored to the PDF path's
  destination count check. Because derivation is non-blocking,
  permissiveness is safe: the deriver may improve release over release.
  Backfill honesty: the admin `revalidate` sweep is designed but not
  implemented (admin-plan.md), so until it lands the only backfill is
  author resubmission.
- **Caps, named**: the web compile reuses the paper compile timeout and
  memory caps (`config.ts` limits); the encode child gets its own timeout
  and output cap (the `runProcess` pattern); the bundle cap is 25 MiB
  (`MAX_PAPER_BYTES` precedent, `capture-store.ts:33`) with the *page
  embed budget* below holding the practical size far under it.
- **Digest stance.** The bundle digest is a **content address, not a
  reproducibility claim** — the deliberate opposite of the PDF digest.
  Within-run integrity is inherited (hash → push → verify → record), but
  cross-run byte-identity is not promised while any of the encode stack
  floats; a re-derivation may produce a new digest, which is a record
  edit. Upgrading to a reproducibility claim (deterministic tar writer as
  in `sealCapture`, `SerializeToString(deterministic=True)`, the pinned
  env everywhere) is a later, additive tightening.

## Recorded shape

`build-output.json`'s `paper` gains one optional key, present iff
derivation succeeded (digests are bare 64-hex like every recorded digest
— `sha256()` at `artifact-schema.ts:681` rejects prefixed values; the
`sha256:` prefix appears only inside the OCI `registryBlob` address):

    "web": {
      "format": { "tool": "reflowtex", "rev": "<fork commit>", "schema": "<64-hex>" },
      "bundle": { "digest": "<64-hex>", "bytes": 4321000, "registryBlob": "ghcr.io/…@sha256:…" }
    }

Deliberately absent: split keys (there is no split), block lists, font
maps, and any web-side mark coordinates — markers ride *inside* the blobs
as stream nodes, the viewer exposes them as anchors keyed by mark number,
and the existing `marks` table remains the single truth for id/kind/order
on both substrates.

Threading (the stage-2 checklist): `parsePaperOutput`
(`artifact-schema.ts:301`) grows `web` via the conditional-key idiom
(`parseManifest`'s `paper` handling is the model), with the published
branch requiring registryBlob digest == bundle digest;
`CompiledPaper`/`PaperPhaseResult` (`paper/phase.ts:38-52`),
`joinPaperMarks`' constructed output (`paper/join.ts`),
`ValidationOutcome` (`outputs.ts`), and `emitBuildOutput` all carry it.
Published-side consumers: `archive/snapshot.ts` does **not** parse
`paper` (lenient by design — nothing to extend there); the website's
`rendererOutput`/`paperEntry` (`lax-website/src/database.ts:51`) is
lenient and simply learns to use the key; any future fail-closed
published-record parser (the admin `verify` sweep) must accept both
shapes.

## Storage

A **third layer of the existing capture OCI manifest**
(`application/vnd.lax.paper-web.v1+tar`, beside
`CAPTURE_MEDIA_TYPE`/`PAPER_MEDIA_TYPE`, `capture-store.ts:27-33`): one
tar holding `index.json` (ordered block list, font map), `blocks/*.pb`,
`fonts/*.otf` (cmap-patched, per-paper, all names content-hashed — see
Website), and `schema/latex.proto`. One digest to record, one anonymous
download, the single-URL rule kept. `promote` (:133) gains the optional
blob in its one manifest PUT (:175-197), so push-before-CAS ordering and
retry idempotency are inherited unchanged.

Conditional-artifact mechanics, enumerated: `paper-web.tar` joins
`resetValidationOutputs` (`outputs.ts:30` — without this a reused
runner's stale tar spuriously fails the iff check), the
`writeValidationOutputs` iff+hash (:153-163), the validate-artifact
upload list (`submission.yml:150-162`), a `VALIDATION_PAPER_WEB_PATH`
env in both publish steps (:212/:250), the two-directional iff in
`readSuccessfulArtifacts` (`workflows/submission.ts:562-566` is the
template: tar without recorded `web` rejected, and vice versa), and
`publish()`'s optional path threading. The job-level
`timeout-minutes: 180` (:72) is ample for a second TeX compile.

The capture tar is unchanged — the paper sources under `paper/` already
guarantee the bundle is regenerable from source plus pins (to a *new*
content address; see the digest stance). **Homes and join keys are
frozen, formats are not**: the bundle is self-describing (schema text
inside, format pin in the record). GC: the third layer inherits the
existing "ghcr blobs survive a tombstone, no GC" stance; the future
`gc-captures` admin verb must understand two- and three-layer manifests.

## Website

`lax-website`: `papers:fetch` learns bundle digests beside PDF digests
(own cache directory, `bundlesDir`); previews get the `--no-papers`
analog (`cli.ts:34`) — note a preview build changes `paper.html`'s bytes,
not just the file set, since blocks are embedded.

- **Schema gate — the deploy-safety rule.** The site build regenerates
  every page with the *current* viewer over old bundles, so it must check
  each record's `format.schema` against the viewer's supported set and
  drop that page to the PDF-only surface (logged) on mismatch. Without
  this, one schema bump breaks every old paper page at the next deploy.
  Embedded `latex.proto` gives wire decoding, not semantics.
- **Embed budget.** Base64 inflates by 4/3; a 25 MiB bundle would mean a
  ~33 MB page. Blocks embed inline up to ~2 MiB total; beyond that they
  ship as same-origin files fetched by the viewer — `PAPER_CSP`
  (`html.ts:51-52`) already carries `connect-src 'self'` for pdf.js, so
  **no CSP change is needed at all** (fonts under `font-src 'self'`,
  `@font-face` injection under the existing style rules).
- **Safe untar.** The site build and `lax serve` extract an
  attacker-shaped tar: bounded extractor, exact path allowlist
  (`index.json`, `blocks/*.pb`, `fonts/*.otf`, `schema/latex.proto`),
  entry-count and size caps, no links, no traversal.
- **Fonts.** The stock viewer hardcodes absolute `/fonts/<file>` and
  unmodified fonts keep their original names — a cross-record collision
  under differing TeX pins. Ours content-hashes *all* served font names
  via the per-page font-map island, emits them under the site's root
  `fonts/` output, and adds the font MIME to `SITE_MIME`
  (`assets.ts:9`).
- **Anchors and cards.** The viewer emits `data-mark` anchors carrying
  `id="m<n>"`, so every existing cross-link (`paper.html#m<n>`, the "In
  the paper" blocks) hits the reflow surface unchanged. The rail/cards
  machinery joins on those anchors and re-places on resize — structural,
  no text matching, no geometry.
- **Viewer vendoring.** The fork's viewer + protobuf.js land beside
  pdf.js, the viewer *unminified* with its AGPL license file (serving
  source satisfies AGPL §13), protobuf.js under its BSD notice — the
  GUST/pdf.js precedent shelf.
- The pdf.js view remains as the "as printed" surface and the fallback
  for records without a bundle (or gated by schema). Layout of the two
  surfaces is a page decision, cheap to change.
- **Attribution footer** (Jan, 2026-09-02): the reflow surface ends in a
  small, muted-gray notice — "Rendered with ReflowTeX — free software
  under AGPL-3.0-or-later" — linking the ReflowTeX repository (upstream
  until the `lax-archive` fork exists), modeled on the transducer
  book's own footer; rendered only when the reflow surface is, plain
  anchor, CSP untouched.
- **Fixture.** lax-website cannot run lax's pipeline: stage 2's host path
  generates a committed bundle fixture once (regenerated on schema
  change), the way sitegen fixtures work today.

## CLI

Archive-first, and explicitly: **`lax build` does not derive the web view
by default.** The host path exists for tests and fixture generation and
auto-skips when lualatex, the pinned fork, or the Python env is absent —
the latexmk-skip pattern (`host/pipeline.ts:491-504`) — so the plan's
stage 2 and this section agree. `lax serve` renders bundles from the
`~/.lax/papers` cache beside PDFs **once paper-plan stage 5 lands** (that
wiring does not exist yet and this plan does not duplicate it). The `lax
submit` success row for papers (already owed, TODO.md) grows the web
facts (derived or skip reason) when the CLI report reader learns to
surface build-output data it currently drops (`run-artifacts.ts:31`).

## Stages

Owner flags: **[Jan]** marks steps agents must flag and never attempt.

0. **Spike** (running): marker capture at exact stream positions (both
   capture sites), wrapper-vs-injection stream comparison, an `amsart`
   linearization observation, geometry/setspace/marginpar/includeonly
   edges, determinism, sizes, a rendered reflow proof. Verdicts below
   gate everything after.
1. **Fork.** The serializer/encode fork with the three-site marker
   branch + `last_flow` transparency (the spike's patch productionized),
   the `latex.proto` marker item kind + regenerated `latex_pb2.py`, SVG
   sanitizer, dvisvgm seam, deterministic serialization, hash-locked
   requirements; `laxreflow.sty` (Apache, lax-authored) + the
   `\iflaxweb` no-op in `laxmark.sty`; fork tests (marker capture at
   all three sites incl. the glyphless hoist, double-run determinism of
   `output.json` and the pb, a **tikz fixture end-to-end with dvisvgm**
   — the one -shell-escape justification the spike did not exercise —
   and luaotfload precedence). Fork repo creation under `lax-archive`
   **[Jan]**; until then, pinned upstream rev + local patches applied by
   a fetch script (checkout gitignored, kept out of the npm `files`
   set).
2. **Host path.** The web compile (own fresh copy), export bounds,
   encode child, oracle (tokenizer cases: hyphenation, ligatures, math
   tokens, accents), bundle writer, `paper.web` emit and the full
   threading checklist above, warning-finding vocabulary (`web-*` rules),
   the manifest opt-out key with its checklist, default-off `lax build`
   behavior, the committed website fixture; tests: fake-runner units,
   fresh-copy isolation (PDF digest unchanged after a web compile),
   bundle double-derivation identity under the pinned env, cap cases;
   CI: apt lualatex (+ `texlive-pictures` — 313 MB / ~38 s measured for
   the whole set) + hash-pinned pip env.
3. **Trusted path.** Container web compile via the injected package,
   runner-mediated dvisvgm, the third OCI layer + publisher, the
   conditional-artifact mechanics enumerated under Storage, docker smoke
   fixture with a tikz picture, fake-ghcr three-layer manifest test,
   stale-tar reset test, iff rejection both directions; re-measure the
   luaotfload cold cache inside the pinned image (the spike's warm
   numbers came from Debian's prebuilt name database). Then the
   scratch-repo rehearsal per the standing rule **[Jan]** (the scratch
   repos were torn down; recreation and tokens are Jan's) before
   anything Actions-side ships.
4. **Website.** Fetch + `bundlesDir`, schema gate, embed budget +
   fetched-blocks path, safe untar, fonts pipeline + `SITE_MIME`, page +
   anchor join, viewer vendoring with licenses, previews policy; tests:
   schema-mismatch → PDF-only page, untar bounds, font collision/dedupe,
   embed-budget behavior, `node:vm` anchor-join, determinism and MIME.
   Renderer/page-builder release **[Jan]** (npm publish is the deploy
   gate).
5. **Serve + round trip.** After paper-plan stage 5: bundle cache beside
   the PDF cache, offline fallback, watcher. Production round trip with
   a real paper **[Jan]**, recorded in `history/`.
6. **Docs.** spec-notes amendment (the derived view, the third layer,
   the format-pinning and digest stance, the `-shell-escape` deviation,
   the opt-out key), README, `instructions.md`, TODO reconciliation,
   retire this plan to `history/`.

## Risks and accepted trade-offs

- **ReflowTeX is alpha** and AGPL. Mitigations: pinned fork rev,
  self-describing bundles, regenerability from captured sources (to a new
  content address), the schema gate on the site build, AGPL kept out of
  the npm tarball by the fork-repo + workflow-fetch home.
- **lualatex compatibility** is the honest residual: papers written for
  pdflatex mostly compile under lualatex (luatex85 shims the primitives),
  but not all — those papers keep a PDF-only page, with the reason in the
  report as a warning.
- **Class furniture** (title machinery, running heads, float pages) is
  linearized by heuristics tuned for simple documents; the oracle turns
  the misreads into skips. The spike's `amsart` probe sizes this risk.
- **`-shell-escape`** in the web compile is a deliberate, contained
  deviation for tikz externalization; the SVG sanitizer plus CSP own its
  injection surface.
- **Cost**: a second TeX compile plus encode per paper-bearing
  submission, overlapped with the Lean chain; bundle bytes on ghcr and
  up to the embed budget inline per page.

## Decisions (2026-09-02 — Jan delegated gate authority to the session)

The former open questions, resolved under that authority:

- **Licensing home confirmed**: `lax-archive/reflowtex` fork repo +
  workflow fetch at the pin; the viewer vendored unminified in
  lax-website with its AGPL license. Interim state — the workflow
  fetches upstream at `REFLOWTEX_REV` — stays functional until the fork
  exists. Creating the fork was attempted from the session and refused
  (repository allowlist blocks the fork call; org repo creation returns
  403 "Resource not accessible by integration"), so it stays a
  one-click Jan step: fork `radek-p/reflowtex` into `lax-archive` on
  github.com and enable the new repo for Claude; a session then
  populates the `lax` branch (patches applied, provenance README) and
  flips `REFLOWTEX_URL` in `pins.ts`.
- **Oracle tolerance confirmed** at the shipped default: 0.98 token-LCS
  (`paperWebOracleSimilarity` in `config.ts`).
- **Digest stance confirmed**: content address now; the reproducibility
  upgrade (pin the encode stack end to end) stays a deferred, additive
  tightening.
- **Rehearsal-before-merge upheld**: the standing scratch-repo-rehearsal
  rule is deliberately *not* waived — the trusted path touches
  `submission.yml`, the publisher, and the capture store. Execution
  needs credentials the session lacks and remains with Jan, alongside
  the other environment-blocked steps: the docker smoke run and pinned-
  image cold-cache measure (no docker in the session container), the
  renderer npm release (no npm auth), the production round trips
  (interactive `lax login`), and the throwaway-repo deletion.

## Spike results (2026-09-02)

Full detail and the serializer diff: `spike/paper/reflow/REPORT.md`
(reference `radek-p/reflowtex` @ `36f8365eed25`); `run-all.sh` replays
the suite in ~26 s.

- **Markers: GO.** 14/14 marker instances (block, inline, nested,
  display-wrapping, second-`\input`-file; ids from the real rewriter)
  surface as exact stream positions in document order with asserted
  word adjacency — on the wrapper path, the injected unmodified
  `main.tex`, and injected `amsart`. Stock serializer surfaces 0/14:
  the shipout walk drops all six vertical-mode whatsits (hypothesis
  confirmed), and a third capture site nobody predicted was needed —
  markers trapped in glyphless resumed paragraphs must be hoisted.
- **Injection ≡ wrapper.** After dropping the title block
  (`\maketitle` linearizes to two centered paragraphs; folios and
  running heads produce no stream items), the injected stream equals
  the wrapper's except the phantom-line site below and one invisible
  `\input`-depth trailing space. `amsart`: compiles, adopts its 360 pt
  band, titles arrive `\MakeUppercase`d — oracle tolerances set
  accordingly.
- **Layout neutrality.** Marked vs unmarked streams equal except three
  display-adjacent paths: two invisible retained trailing spaces, and
  the **phantom line** when an end marker directly follows a display
  before a blank line — which cross-checking showed is a live
  ~11.96 pt shift on the shipped pdflatex + `laxmark.sty` path too
  (spec-notes caveat owed; instructions guidance adopted above). The
  vertical-mode glue lift re-earned its keep: without it, `\topsep`
  inflates two sites by exactly 8 pt.
- **Determinism.** `output.json`, transformed json, and `nodelist.pb`
  byte-identical across fresh directories; converted font names
  content-hashed and stable; no `SOURCE_DATE_EPOCH` needed, no
  absolute paths. (Same-box measurement — the content-address stance
  stands until the encode env is pinned end to end.)
- **Edges.** geometry `[margin=1in]`: paragraph nodes byte-inert,
  displays bake `\displaywidth` into bands as designed; setspace
  carries per-paragraph baselineskip 12 → 15 pt; `\marginpar` text is
  captured but unreferenced — silently dropped, hence the oracle
  diagnostic; `\includeonly` leaves excluded markers cleanly absent
  (the loud count-check failure we want); `[11pt]` carries via class
  options; `thebibliography` + `\cite` resolve under two passes.
- **Encode + render.** Stock schema has no marker item kind
  (`encode_pb` crashes on stream markers) — the proto extension is
  stage 1's mandatory piece. Rendered fixture: 0 missing glyphs, 25
  lines at 64 rem vs 36 at 34 rem (reflow proven), math faithful;
  screenshots committed.
- **Numbers.** TeX toolchain 313 MB / 37.6 s apt install
  (`texlive-pictures` is required by the template's hard tikz load);
  compile 0.8–1.2 s warm per pass; full pipeline 2.5–2.8 s;
  fixture-scale page ≈ 829 KB (556 KB of that fonts). Chapter-scale
  sizing, tikz-with-dvisvgm, real bibtex, footnotes, hyperref
  coexistence, and the oracle itself remain untested — owed to stages
  1–3 as marked.
