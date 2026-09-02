# Paper web view — plan

Status: proposed 2026-09-02, from the reflow design discussion. Stage 0
(the spike) is running; its verdicts get folded into the "Spike results"
section when `spike/paper/reflow/REPORT.md` lands, and they gate every
later stage. Design decisions recorded here are fixed unless Jan revisits
them; stage order and caps are suggestions. This plan builds on the PDF
paper layer (paper-plan.md — its stages 4–6 are still open and are not
blocked by, nor blocking, this plan).

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
paragraphs *unbroken*, displays as finished boxes, page furniture
discarded — and a browser viewer runs Knuth–Plass line breaking at the
reader's width and paints inline SVG. Line width, zoom, and theme become
reader parameters; intra-line typesetting stays genuine TeX. The site's
paper page renders this beside (or instead of — a layout decision, cheap
to change) the pdf.js canvas, and the marked-passage cards attach to
exact stream positions instead of extracted page geometry.

## Derivation model: injection, not splitting

The web compile takes the **rewritten job copy unchanged** — the same
sources the PDF compile consumes — and injects everything it needs the
way `laxmark.sty` is injected today: latexmk's
`-usepretex -pretex='\RequirePackage{laxreflow}' -jobname=<main stem>`
(the `-jobname` lesson from paper-plan.md applies verbatim), running
lualatex regardless of the manifest's `engine` (which keeps governing the
PDF). `laxreflow.sty` installs, before the author's class loads:

- the luaotfload location-precedence fix (texmf first);
- the node-list serializer (`dofile`), our fork;
- the shipout hook (`\AddToHook{shipout/before}`);
- the TikZ externalization capture, deferred behind
  `\AddToHook{package/tikz/after}` so it applies only if tikz loads;
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
accept. (The wrapper remains what the spike compares against, since a
controlled class is the low-variance baseline.)

## Author-facing contract

Almost none — that is the point.

- No new required manifest keys. The only surface is an opt-out,
  `paper.web: false`, for an author who dislikes the derived view.
- Markers, the rewriter, and the PDF path are untouched. The same
  rewritten sources feed both compiles; only the injected package differs.
- `laxreflow.sty` (and `laxmark.sty`, as a no-op) define `\iflaxweb`, so
  an author *may* guard print-only material (marginalia, a
  `\pageref`-bearing sentence) — optional, additive, documented in
  `instructions.md` with the degradation list (marginal notes, float
  placement, page references; geometry/margins are neutralized by design
  and need no guard).

## Build mechanics

- **Compile** in the same pinned TeX image (`PAPER_IMAGE` in `pins.ts`),
  through the same runner, on the rewritten copy, after the PDF compile
  inside the existing paper phase (still concurrent with the Lean chain,
  joined before Emit). Deviation from the PDF compile's flags: the web
  compile runs with `-shell-escape`, which tikz's external library
  requires for its picture sub-runs — contained by the sandbox (no
  network, read-only root, caps) and used by nothing else; the PDF compile
  keeps restricted shell escape for arXiv parity.
- **Serializer fork.** Our fork of ReflowTeX's `serializer.lua` +
  `src/encode/` adds the marker branch (emit the `\laxmark` whatsits into
  the stream at both capture sites — inside paragraphs and in the shipout
  walk between them) and whatever the spike's verdicts require. The fork
  is public (AGPL obligations met by publication); the pinned rev lives in
  `pins.ts` beside the image digests. Where the fork's files ride
  (a `lax-archive/reflowtex` fork repo vendored at build, or files under
  `assets/reflowtex/` with license and provenance beside them, on the
  pdf.js/GUST precedent) is an open question for Jan — see below.
- **Encode** (Python: `protobuf`, `fonttools`; `dvisvgm` from the TeX
  image for pictures) runs as a capped child process on the host of the
  Validate job, the pdf.js-extraction precedent: credential-free job,
  untrusted input, bounded output.
- **The oracle.** Reflow's bad failure mode is silent — a class's shipout
  structure the linearizer misreads yields a plausible but wrong stream.
  Both compiles run on every paper, so the join step extracts the PDF's
  text (pdf.js, already present) and the stream's glyph text, strips
  furniture on both sides, and requires the token sequences to agree
  within a tolerance. Divergence ⇒ the web view is skipped with the first
  mismatch location in the report. This converts the silent class into
  loud, attributable skips.
- **Non-blocking, always.** Any web-derivation failure — lualatex error,
  marker count mismatch in the stream, oracle divergence, cap overrun —
  omits `paper.web`, adds a report-artifact row with the reason and log
  tail, and changes nothing else. Marker *validation* stays anchored to
  the PDF path's destination count check. Because derivation is
  non-blocking, permissiveness is safe: the deriver may improve release
  over release, and existing records pick the view up on any later
  revalidation (the admin `revalidate` sweep is the backfill path).
- **Caps**: reuse the paper caps (wall clock, memory, folder) plus a
  bundle-size cap (25 MiB proposed) and the compile timeout already on
  the validate job.

## Recorded shape

`build-output.json`'s `paper` gains one optional key, present iff
derivation succeeded:

    "web": {
      "format": { "tool": "reflowtex", "rev": "<fork commit>", "schema": "sha256:…" },
      "bundle": { "digest": "sha256:…", "bytes": 4321000, "registryBlob": "ghcr.io/…@sha256:…" }
    }

Deliberately absent: split keys (there is no split), block lists, font
maps, and any web-side mark coordinates — markers ride *inside* the blobs
as stream nodes, the viewer exposes them as anchors keyed by mark number,
and the existing `marks` table remains the single truth for id/kind/order
on both substrates. Parsers (`parsePaperOutput` in
`artifact-schema.ts:301`, `archive/snapshot.ts`) extend fail-closed; the
published branch requires the `registryBlob` digest to equal the bundle
digest, as for the PDF.

## Storage

A **third layer of the existing capture OCI manifest**
(`application/vnd.lax.paper-web.v1+tar`, beside
`CAPTURE_MEDIA_TYPE`/`PAPER_MEDIA_TYPE` in `capture-store.ts`): one tar
holding `index.json` (ordered block list, font map), `blocks/*.pb`,
`fonts/*.otf` (cmap-patched, per-paper), and `schema/latex.proto`. One
digest to record, one anonymous download, the single-URL rule kept.
`promote` gains the optional blob; the publisher pushes it before the
database CAS commit; `paper-web.tar` joins the validate artifact and the
credential-free re-hash in `readSuccessfulArtifacts`; local builds write
it beside `paper.pdf` (gitignored). The capture tar is unchanged — the
paper sources under `paper/` already guarantee the bundle is regenerable
from source plus pins, which is what makes the alpha-format risk
acceptable: **homes and join keys are frozen, formats are not.** The
bundle is self-describing (schema text inside, format pin in the record),
so old records keep rendering without migration; worst case, a bundle is
re-derived under its recorded pin.

## Website

`lax-website`: `papers:fetch` learns bundle digests beside PDF digests;
the paper page embeds the blocks (base64 islands, self-contained — no new
`connect-src`; fonts under the site's assets with `font-src 'self'`); the
vendored fork viewer + protobuf.js land beside pdf.js with their license
files. The rail/cards machinery joins on `data-mark` anchors the viewer
emits and re-places on resize — structural anchors, no text matching, no
geometry. The pdf.js view remains as the "as printed" surface and the
fallback for records without a bundle. Layout of the two surfaces is a
page decision, cheap to change.

## CLI

Archive-first: `lax build` does not derive the web view initially (local
preview requires lualatex + python + the fork; the archive run is the
authority, as for Lean). `lax serve` renders bundles from the
`~/.lax/papers` cache like PDFs. A local derivation path and doctor rows
are a later stage if wanted.

## Stages

0. **Spike** (running): marker capture at exact stream positions (both
   capture sites), wrapper-vs-injection stream comparison, an `amsart`
   linearization observation, geometry/setspace/marginpar/includeonly
   edges, determinism, sizes, a rendered reflow proof. Verdicts below
   gate everything after.
1. **Fork.** The serializer/encode fork with the marker branch and its
   own tests; `laxreflow.sty`; the vendoring/licensing decision executed;
   rev pinned in `pins.ts`.
2. **Host path.** Derivation + oracle + bundle writer behind the paper
   phase on the host pipeline, `paper.web` emit, report rows, unit tests
   with a fake runner and a real-lualatex e2e case (CI apt TeX, as for
   the PDF path).
3. **Trusted path.** Container compile with the injected package, host
   encode step, the capture layer, publisher, artifact, re-validation,
   docker smoke fixture — then the scratch-repo rehearsal per the
   standing rule before anything Actions-side ships.
4. **Website.** Fetch, page, viewer vendoring, CSP, cross-links, tests
   (determinism, MIME, a `node:vm` test for the anchor-join logic).
5. **Serve + production round trip** with a real paper, recorded in
   `history/`.
6. **Docs.** spec-notes amendment (the derived view, the third layer, the
   format-pinning stance, the `-shell-escape` deviation), README,
   `instructions.md`, TODO reconciliation, retire this plan to `history/`.

## Risks and accepted trade-offs

- **ReflowTeX is alpha** and AGPL. Mitigations: pinned fork rev,
  self-describing bundles, regenerability from captured sources; the
  license posture (vendor files vs. fork repo; AGPL viewer JS served by
  the site beside Apache pdf.js) is Jan's call before stage 1.
- **lualatex compatibility** is the honest residual: papers written for
  pdflatex mostly compile under lualatex (luatex85 shims the primitives),
  but not all — those papers simply keep a PDF-only page, with the reason
  in the report.
- **Class furniture** (title machinery, running heads, float pages) is
  linearized by heuristics tuned for simple documents; the oracle turns
  the misreads into skips. The spike's `amsart` probe sizes this risk.
- **`-shell-escape`** in the web compile is a deliberate, contained
  deviation; it exists only for tikz externalization.
- **Cost**: a second TeX compile plus encode per paper-bearing
  submission, overlapped with the Lean chain; bundle bytes on ghcr and
  embedded block bytes on the page (chapter-scale documents measured
  ~0.5 MB of blocks).

## Open questions (Jan)

- The AGPL/vendoring stance (fork repo vs. `assets/reflowtex/`; the
  viewer JS in `lax-website`).
- Oracle tolerance: how much furniture divergence before skipping.
- Whether the opt-out key ships in stage 2 or waits for someone to ask.
- Whether local `lax build` ever derives the view, or archive-only stays
  the contract.

## Spike results

To be folded in from `spike/paper/reflow/REPORT.md` when stage 0 lands.
