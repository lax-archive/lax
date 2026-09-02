# Paper layer — plan

Status: proposed 2026-09-02; stages 1 (contract), 2 (host path), and 3
(trusted path, except the scratch-repo rehearsal) were implemented the same
day — see TODO.md for what remains and the deviations noted there. Design decisions from the discussion that produced this plan
are fixed unless Jan revisits them; the stage order and the caps are
suggestions.

## What this adds

A submission may carry a LaTeX document. The archive compiles it itself,
the author marks passages with bare comment lines, and the website shows the
compiled PDF beside cards for the marked concepts and proofs.

The layer sits strictly on top of the existing content. Concepts keep being
defined where they are defined today — the Lean module and its annotation
— and the paper only points at them. A passage marked with a concept id
shows, on the right, the concept as sourced from Lean: its title, type,
description, and statements. A passage marked with a proof id shows the
existing judgment card (assumptions → conclusion, grounded or conditional),
never the proof code. All passages are equal; there is no "primary" passage
and no notion of a paper defining anything.

Three things are hard to change later and are fixed here: the marker syntax
authors put into their `.tex`, the `paper` shape in `build-output.json`, and
where the PDF bytes live. The viewer and the page layout are cheap to change
and are specified only as far as the first version needs.

## Author-facing contract

### Manifest

`manifest.yaml` gains one optional key:

    paper:
      folder: paper          # relative to the submission root, may be "."
      main: main.tex         # relative to folder
      engine: pdflatex       # pdflatex | lualatex | xelatex, default pdflatex

No other keys. The folder must be a plain directory inside the submission
(same containment rule as `source.folder`, `source/fetch.ts:173`), `main`
must be a regular file inside it, and the vocabulary mirrors arXiv's
00README (`compiler`, entry file) so an author carries the same choices to
arXiv. The compile runs with `folder` as working directory.

### Markers

Markers are comments. The author's own build ignores them completely, needs
no package and no preamble change:

    % lax begin Lax261.Treewidth
    \begin{definition}[Treewidth]
      ...
    \end{definition}
    % lax end

    we use the standard definition of % lax begin Lax42.Treewidth
    treewidth % lax end
    as introduced in ...

Grammar, applied to every `.tex` file under `paper.folder` (and only those;
`.sty`/`.cls`/`.bbl` are never touched):

- A marker is an unescaped `%` (preceded by an even number of backslashes),
  optional spaces, `lax`, spaces, `begin <id>` or `end` with an optional
  `<id>` that must equal the innermost open marker. Everything else after
  `%` on that line is ignored, as in any comment.
- `<id>` is one of two kinds, and the kind decides what the card shows:
  - a **concept id** (`Lax261.Myconcept`): the passage is the informal
    counterpart of the concept — a definition, a theorem as stated, the
    paragraph introducing the object. Card: the concept as sourced from
    Lean — title, type badge, description, its statements with status.
  - a **proof id** (`Lax261Proofs.Q`): the passage is a proof or proof
    sketch tied to one specific Lean proof. Card: the judgment card
    (assumptions → conclusion, grounded or conditional). Never Lean code.
  Individual statements are not markable; the concept is the unit.
- Ids resolve if they belong to the submission itself or to a package in
  the **union** of `requiredByConcepts` and `requiredByProofs` — directly
  required only, transitively reachable packages do not qualify, exactly as
  for assumptions: to talk about it, require it. Own ids resolve against the
  inventory and inspection results, foreign ids against the archive
  snapshot the Resolution phase holds. Starting strict is deliberate: a
  mention of an archive concept the submission does not build on is a
  citation and belongs in the bibliography; relaxing later to any
  registered id is additive, tightening later would break papers.
- Not ids: statement ids (`Lax261.Myconcept.X`), submission ids
  (`lax-42`), package roots (`Lax42`), mathlib declarations, and
  frontmatter-less helpers of a proof package — none has a card. Ids
  match exactly, no normalization. Any other id is a validation error.
- Markers nest and may overlap by nesting only; `end` closes the innermost
  open marker; an unclosed marker at end of file, or an `end` with nothing
  open, is a violation. The same id may be marked any number of times.
- Inline passages are bracketed by breaking the line before and after the
  phrase; normal TeX spacing rules around `%` apply and are the author's.
- Markers inside verbatim or listings environments are text, not markers,
  and are caught by the count check below. Markers in moving arguments
  (section titles, captions) and inside display math are unsupported;
  put them around the environment. `instructions.md` says all of this.

### What the archive guarantees

If the manifest declares a paper, the paper compiles or validation fails,
exactly as a broken frontmatter fails it. TeX warnings, overfull boxes, and
rerun notices never fail. The compile log tail reaches the author through
the report artifact like every other finding.

## Build mechanics

### Rewrite

`src/submission-validation/paper/rewrite.ts` (pure TypeScript, no I/O):
given the `.tex` texts, returns the rewritten texts plus the ordered mark
table `[{ n, id }]`. Each marker comment from `%` to end of line becomes

    \laxmark{b}{<n>}%        (begin)
    \laxmark{e}{<n>}%        (end)

The trailing `%` eats the rest of the line and the newline exactly as the
original comment did, so the token stream is unchanged apart from one
robust, zero-size whatsit. Mark numbers are assigned in file order, files in
the order the rewriter is handed them (main first, then the rest sorted).
CRLF is normalized before rewriting. Ids never enter the PDF: destination
names carry only the number, so no escaping question exists.

Rewriting happens on a **copy** of `paper.folder` inside the job directory
— trusted and local alike — never in the author's tree.

### The injected package

`assets/tex/laxmark.sty`, shipped with the CLI in a directory containing
nothing else and mounted read-only into the container. The spike's working
version is `spike/paper/pipeline/laxmark.sty`; its shape:

    \ProvidesPackage{laxmark}
    \RequirePackage{iftex}
    \DeclareRobustCommand\laxmark[2]{%
      \ifvmode
        lift \lastskip over the whatsit: \vskip-\lastskip <dest> \vskip<it>
      \else <dest> \fi}
    <dest> = pdfTeX  \pdfdest name{lax.#2.#1.<m>} xyz\relax
             LuaTeX  \pdfextension dest name{lax.#2.#1.<m>} xyz\relax
             XeTeX   \special{pdf:dest (lax.#2.#1.<m>) [@thispage /XYZ @xpos @ypos null]}
    <m> = v or h, the TeX mode at the marker (\ifvmode)
    LuaTeX only: \pdfvariable trailerid{lax}   (non-empty; see determinism)

The mode tag is not decoration: a destination in vertical mode reports the
column's left edge and the baseline of the line *above*, and an inline
marker that TeX pushes to a line start reports the identical pair for the
line *below*. Geometry cannot tell them apart; the viewer spike lost a
range's whole first line without the tag. The `\relax` stops `\pdfdest`'s
look-ahead for the optional `zoom` keyword, which otherwise eats following
spaces (harmless after the rewrite's `%`, but cheap insurance).

It deliberately does not use hyperref's `\hypertarget`, which wraps the
destination in a box and starts a paragraph — a marker between two
paragraphs would add a blank line. The raw destination is a whatsit, legal
in both modes, but **not layout-neutral in vertical mode on its own**: it
ends the vertical list, so the `\addvspace` opening the next environment
sees `\lastskip = 0` and adds its skip instead of merging — the spike
measured 7.97 pt and a moved page break between `\end{theorem}` and
`\begin{proof}`. The glue lift above (the same trick `\addvspace` uses,
`\vskip-\lastskip` rather than `\unskip`) restores byte-identical text
positions versus the author's own build.

Loading without touching the author's files: latexmk's `-usepretex
-pretex='\RequirePackage{laxmark}' -jobname=%A`. Pretex prepends code
before `\documentclass`; the `-jobname` flag is **required**, since
latexmk then runs `<engine> "\RequirePackage{laxmark}\input{main.tex}"`
and without it `\jobname` becomes `texput` and latexmk aborts looking for
`main.log`. `TEXINPUTS` must be **non-recursive** (`<dir>:`, not
`<dir>//:`): with `//` an engine can pick up another run's `.bbl`. This
needs latexmk ≥ 4.77 (TeX Live 2023 and later); `lax doctor` checks the
version.

### Compile

    latexmk -<engine> -interaction=nonstopmode -halt-on-error
            -usepretex -pretex='\RequirePackage{laxmark}' -jobname=<main stem> <main>

with `TEXINPUTS=<laxmark dir>:`, `SOURCE_DATE_EPOCH=<source commit
time>`, `FORCE_SOURCE_DATE=1`, `HOME=/tmp` in the container (the runner's
`--user` has no home, and luaotfload/mktexfmt want one), and TeX Live's default **restricted** shell
escape (never `-shell-escape`; that excludes minted and tikz externalize,
as on arXiv). latexmk runs bibtex or biber when a `.bib` is present and uses
a shipped `.bbl` otherwise, so both bibliography workflows pass unconfigured.
Network is off in the container; locally it is whatever the host has.

Caps (proposed, all in `config.ts` limits): 10 minutes wall clock, the
compile memory cap, paper folder ≤ 50 MiB and ≤ 2 000 files, PDF ≤ 25 MiB
and ≤ 500 pages, log tail 12 k characters as for other findings.

### Extraction

`src/submission-validation/paper/extract.ts` runs a child process
(`runProcess` from `sandbox/container.ts:274`, for its timeout and output
cap) that loads `pdfjs-dist` (legacy build, pure JavaScript, no native
code), reads the PDF, and prints JSON: page count, per-page media box, and
every `lax.<n>.<b|e>.<v|h>` destination as `{ n, kind, mode, page, x, y }`
in PDF user space (points, origin bottom-left). Note `getDestinations()` returns a
`Map` in current pdf.js; `Object.entries` on it silently yields nothing. pdf.js runs on the host of the job, not
in the TeX image (which has no node) — acceptable because the Validate job
is credential-free (trust rule 1) and the process is capped. Moving it into
the node sandbox image as a `sandbox/tools/*.mjs` tool is a later option.

Checks: every `n` from the mark table has exactly one `b` and one `e`, no
unknown destination exists, and the count equals the rewriter's. Coordinates
never order marks — two markers closing back to back in vertical mode sit
at the same point — so the mark number stays authoritative and there is no
"e before b" check. A mismatch means a marker landed in verbatim or
a moving argument; the finding names the id.

### Recorded shape

`build-output.json` gains one optional key, present iff the manifest
declares a paper:

    "paper": {
      "folder": "paper",
      "main": "main.tex",
      "engine": "pdflatex",
      "pdf": {
        "digest": "sha256:…",
        "bytes": 1234567,
        "pages": 12,
        "registryBlob": "ghcr.io/lax-archive/lax-captures@sha256:…"
      },
      "pageSizes": [[612, 792], …],
      "marks": [
        {
          "id": "Lax261.Treewidth",
          "kind": "concept",
          "begin": { "page": 3, "x": 72.0, "y": 640.2, "mode": "v" },
          "end":   { "page": 3, "x": 301.5, "y": 588.9, "mode": "v" }
        }
      ]
    }

`kind` is `concept` or `proof`, decided at resolution.
`marks` keep mark-number order (which is compile order, i.e. document
order); pages are 1-based; coordinates keep two decimals. Local builds omit
`registryBlob` and instead write `paper.pdf` beside `build-output.json`
(added to the scaffold's `.gitignore`, `src/cli/scaffold.ts:61`); the digest
binds the two.

### Storage

The PDF becomes a **second layer of the existing OCI capture manifest** in
`ghcr.io/<owner>/lax-captures` (`src/shared/capture-store.ts`:
`pushBlob` :189 already exists; `promote` :113 gains the layer, with its own
media type). One manifest keeps both blobs alive together, the publisher's
hash-push-verify order is unchanged, and consumers fetch the PDF alone by
its digest without touching the capture tar. Not in the capture tar, which
would force every website build to download oleans to get a PDF; not in
`lax-database`, which stays three files per record.

The original (unrewritten) paper sources go into the capture tar under
`paper/`, so a registered record stays self-contained if the source
repository disappears — the same promise the capture makes for Lean.

## Pipeline placement

Phase name `paper`, added to `ValidationPhase` (`contracts.ts:12`) and
`PHASES` (`artifact-schema.ts:40`); `ROW_OF_PHASE`/`ROW_LABEL`/`ROW_RUNNING`
in `src/cli/build.ts:58-98` get a row "Compiling the paper".

- **Static gate** (`phases/static.ts`): manifest `paper` block shape and
  containment, entry file exists, folder caps, marker **syntax** (grammar,
  nesting, balance) — everything that needs no Lean. Runs in the fail-early
  gate, so a typo costs seconds, not a compile.
- **Paper phase, concurrent with the Lean chain.** Nothing in the TeX work
  depends on Lean: the rewriter emits numbered marks, and compile and
  extraction work on numbers only. So the phase is a promise started right
  after the static gate (before the lean cache restore) and joined before
  Emit (`pipeline.ts:275` in the trusted pipeline, `host/pipeline.ts:341`
  on the host):
  - *independent piece*: copy + rewrite, pull the TeX image, compile,
    extract destinations, count check — overlapping Compile → Replay →
    Inspect entirely, with its own profiler span and phase events;
  - *join piece* (milliseconds): resolve each mark's id against the
    submission's own concepts/proofs (from Inspect) and the directly
    required packages' build outputs (from the archive snapshot the
    Resolution phase already holds), hand `paper` to `emitBuildOutput`
    (`phases/emit.ts:10`) and the PDF path to the seal.
  Concurrency lives inside the Validate job, not in a second Actions job: a
  second job would cost a runner spin-up and checkout, split the report
  artifact that is the author's channel, and push id resolution into the
  publisher because only the Lean job knows the proof ids. The runner side
  needs only a second `ContainerRunner` bound to the TeX image; watchdog
  and workspace cap are per invocation and per job directory and keep
  working with two containers alive. Resources: four cores and 16 GB on
  the runner, the Lean containers already capped, TeX single-threaded and
  a few hundred MB. If the compile fails while Lean still runs, Lean
  finishes and both findings are reported — one round trip costs the
  author up to half an hour, so a complete report beats saved minutes (a
  knob if minutes ever matter). Expected growth of total run time: the
  join piece, i.e. none. Skipped when `scope !== "both"`. Locally the same
  structure applies; the build's step display must then settle the paper
  row out of order, as doctor's concurrent row group already does.
- **Trusted compile** runs in a second digest-pinned image:
  `PAPER_IMAGE_*` in `pins.ts` beside the node image, a full TeX Live
  historic image (`texlive/texlive:TL2025-historic` or the year the spike
  settles on). `ContainerInvocation` gains an optional `image`
  (`sandbox/container.ts:17`), `verifyRuntime` :77 is factored into a
  per-image `verifyImage`, and the Lean runtime mounts (:121) become
  optional so the TeX run mounts only the job copy, the sty directory, and
  an output directory. Nothing else about the runner changes: read-only
  root, no capabilities, no network, memory/pids caps, watchdog.
- **Local compile** (`host/pipeline.ts`) runs `latexmk` from `PATH` via
  `host/proc.ts` with the same arguments and env. No latexmk → the phase is
  skipped with a warning, `paper` is omitted, Lean validation is unaffected.
  Local is a preview; the archive run is the authority, as for Lean.
- **Publisher** (`src/shared/submit-publisher.ts:72`): pushes the PDF layer
  before the database commit; `constructSubmitChanges` :206 fills
  `paper.pdf.registryBlob`. `prepare-submit`'s credential-free re-validation
  (`artifact-schema.ts:57`) hashes `paper.pdf` from the validate artifact
  against the recorded digest; `parseBuildOutputPayload` :243 and
  `archive/snapshot.ts:64` parse the key fail-closed.
- **Workflow** (`submission.yml`): `paper.pdf` joins the validate artifact
  upload (:136-155) and `resetValidationOutputs` (`outputs.ts:25`). The TeX
  image is pulled on demand like the node image today, only when the
  manifest declares a paper; measure the pull in the rehearsal and add a
  layer cache step only if it hurts. Add a `timeout-minutes` to the
  validate job while there — it has none.

## Website

Repository `lax-website`; the generator stays a pure function of files on
disk and never fetches.

- **Types and loading.** `PaperEntry` in `src/types.ts:72` (`paper?`);
  `rendererOutput` (`src/database.ts:16`) validates it beside the four
  array checks; `SiteSubmission` (`src/sitegen/model.ts:5`) gains
  `paperFile?: string`. A new `src/papers.ts` resolves a PDF digest to
  `<cache>/<digest>.pdf`, and a `npm run papers:fetch` step downloads
  missing digests from ghcr anonymously (the blob endpoint the capture
  consumers already use) into that cache. CI caches the directory across
  builds so a publish does not re-download the corpus.
- **Output.** `generate.ts:20` files map becomes `Map<string, string |
  Buffer>`; per submission with a paper it emits `<id>/paper.pdf` and
  `<id>/paper.html`. `SITE_MIME` (`assets.ts:9`) gains `.mjs`. The PDF URL
  on the page comes from one place (`paperUrl(id)`), so moving the bytes off
  Pages later is a one-line change.
- **Page** `src/sitegen/pages/paper.ts`: the submission sidebar
  (`shared.ts:378`, `backToSubmission`), a two-column body that stacks at
  the existing 900 px breakpoint, the marks as an inert JSON script tag (the
  `graphDataScript` pattern, `graphs.ts:130`), and pre-rendered cards — one
  per mark, in mark order — built from `proofJudgment` :49 for proofs and
  title/type badge/description/statement list (via `claimEntry` :39) for
  concepts. Cards carry the `line-proven`/`line-open` vocabulary
  from `highlight.ts:193`. Class prefix `manuscript-*` (`paper-*` is the
  submission masthead). Above the columns: a short index of what the paper
  marks, own and foreign.
- **Viewer** `assets/site/manuscript.js` + vendored pdf.js under
  `assets/site/pdfjs/` with its Apache-2.0 licence file beside it (the
  GUST font licence precedent): render pages to canvas with a text layer,
  place a highlight per mark from `getTextContent()` item transforms (never
  the text-layer DOM), position each card at its passage's y (the
  `source-proof.js` rail mechanism), expand a card on click of its
  highlight, scroll to the passage on click of a card, and keep everything
  keyboard reachable. pdf.js scripting stays disabled. The boundary rule
  the spike settled on (`spike/paper/viewer/REPORT.md`): keep items in
  content-stream order, cut them into blocks where the baseline jumps
  (new column, heading, folio), locate the block containing the point,
  and within it pick the boundary item by the mark's mode — horizontal:
  the first item whose right edge passes x, its rectangle clipped at x;
  vertical: the line at y is the *preceding* line, start after it; an
  empty line set falls through to the next block, which is what makes a
  marker at the foot of column one land in column two. Two decisions the
  spike left open, both taken here: the rail stacks cards in **mark
  order** (reading order; visual-y ordering puts a column-two card above
  an earlier column-one card), pushed down greedily to avoid overlap; and
  highlights get `pointer-events: none` with click hit-testing done on the
  page container, so text under a highlight stays selectable. Running
  heads need the same exclusion heuristic as folios.
- **CSP** (`html.ts:41`): a third variant adding `worker-src 'self'` and
  `connect-src 'self'` for the paper page only, chosen the way the
  discussion variant is (:97). `PageShell` gains `styles?` for the text-layer
  stylesheet, or its few rules go into `style.css`.
- **Cross-links.** Submission page: a "Paper" section with page count and
  the marks index. Concept and proof pages: "In the paper" listing each
  passage with its page number, linking to `paper.html#m<n>`.
- **Deploy.** Previews on the `gh-pages` branch should not carry PDFs
  (`site:build --no-papers` for previews), only production does; the
  branch already stores every deployment's full tree. Pages' 1 GB soft
  limit is the known ceiling — fine for now, and the single-URL rule above
  is what keeps the exit cheap.
- **Renderer bundle.** pdf.js adds a few MB to the page-builder tarball
  (`package-renderer.mjs`), under its 50 MB cap. `REQUIRED_RENDERER_PATHS`
  in the CLI is unchanged.

## CLI

- `lax doctor` (`src/cli/doctor.ts`): a "LaTeX" row via a `latexmkCheck`
  built like `toolCheck` :514 — present, version ≥ 4.77, engine binaries
  present; `installHint` :952 points at the distribution's TeX Live
  package. Doctor never installs TeX.
- `lax build`: the phase row, the `paper.pdf` beside `build-output.json`,
  and `hasCurrentLocalBuild` :308 also comparing the PDF digest.
- `lax serve` (`src/cli/website.ts`): `loadLocalSubmission` :468 passes the
  local `paper.pdf`; database submissions resolve `registryBlob` through a
  `~/.lax/papers/<digest>.pdf` cache filled on demand with the same
  anonymous blob download the sandbox tools use (`download-capture.mjs`),
  offline falling back to the page without a viewer; the local watcher :180
  also watches `paper.pdf`. The rhythm stays build-then-serve, as for Lean.
- `lax init`: no new flag; `instructions.md` shows the manifest block.

## Stages

Each stage ends with its tests green and, for stages 3 and 5, a rehearsal.
Stage 0 is a spike and gates the rest.

0. **Spike (one day).** A fixture paper with the three marker shapes
   (block, inline, nested, foreign id), compiled with pdflatex, lualatex,
   and xelatex through the rewrite + pretex path; pdf.js extraction of the
   destinations; a throwaway browser page that highlights the ranges in a
   two-column layout. Also: two compiles with `SOURCE_DATE_EPOCH` set,
   comparing digests; and a wall-clock measurement of pulling the TeX image
   on an Actions runner. Record the verdicts in this file. Open questions
   the spike answers: text-layer quality with the full image versus a
   partial local TeX, the exact destination behaviour of the XeTeX special,
   and whether the trailer id makes the digest a reproducibility claim or
   only a content address.
1. **Contract.** Manifest key everywhere it is threaded (the `supersedes`
   commit 84f6c77 is the checklist: `validators/manifest.ts`,
   `contracts.ts`, `artifact-schema.ts`, scaffold, docs, the three tests),
   the `paper` payload parsers, the marker rewriter with unit tests
   (grammar, escaping, nesting, CRLF, count table), the static-gate checks.
2. **Host path.** Paper phase on the host pipeline, extraction, emit,
   local `paper.pdf`, build rows, doctor check, host e2e fixture in
   `test/support/host.ts:54` and a case in `test/e2e/host-pipeline.test.ts`
   (CI installs a small TeX Live via apt for it). `lax serve` shows the
   local paper once stage 4 ships; until then it ignores the key.
3. **Trusted path.** Second pin, runner image override, phase in
   `pipeline.ts`, PDF layer in the capture store and publisher,
   revalidation, workflow artifact and timeout, docker smoke fixture
   (`test/smoke/submission-validation.ts`), fake-ghcr test for the second
   layer. Then the scratch-repo rehearsal per `history/live-rehearsal.md`
   before anything Actions-side ships — the standing rule.
4. **Website.** Types, loader, papers fetch, generator, page, viewer, CSP,
   cross-links, tests (`test/sitegen.test.ts` fixture with a paper;
   `database.test.ts` for the key; a `node:vm` test for the viewer's pure
   mark-placement functions; determinism and MIME cases), previews policy,
   renderer release.
5. **CLI serve + round trip.** Serve wiring and the papers cache, `lax
   update` picks up the renderer, then a production round trip with a real
   paper (the flagship drafts in `~/git/lax-submissions` are the natural
   candidates) recorded in `history/`.
6. **Docs.** spec-notes entry (proposed amendment: manifest key, marker
   grammar, `paper` shape, the second image under Archive Environment,
   the capture layer), `instructions.md` author section, README (doctor
   row, validation infrastructure naming the second image, `lax serve`
   paragraph), TODO reconciliation-queue bullet, and retiring this plan
   into `history/`.

## Risks and accepted trade-offs

- **Image pull per run.** A full TeX Live image is several GB and is not
  cached by the workflow today. Only paper-bearing submissions pay it. If
  the spike measures more than a few minutes, add a layer cache or pick a
  smaller scheme image and accept fewer packages.
- **Local/archive drift.** Host TeX versions differ from the pinned image;
  a paper can pass locally and fail in the archive. Accepted: local is a
  preview, and `lax submit` reports the archive's findings. A lax-owned
  frozen TeX Live was considered and deferred.
- **Text-layer quality.** Highlight placement needs real fonts with Unicode
  maps; Type3 bitmap fallbacks from a partial TeX give a poor layer. The
  full image avoids it; local previews may not.
- **Markers in moving arguments** break tables of contents; robustness
  limits but does not remove the problem. Documented as unsupported.
- **PDF content.** TeX can emit JavaScript and launch actions. pdf.js
  ignores scripting; the raw download hands the file to native viewers.
  Accepted, low, and the archive compiled the file itself.
- **Hosting scale.** Pages' 1 GB soft limit bounds the corpus at a few
  dozen papers at the proposed cap. The exit is a store with CORS and one
  `connect-src` line, prepared for by the single-URL rule.
- **Nondeterministic PDFs.** Resolved by the spike: pdfTeX and XeTeX are
  byte-identical under `SOURCE_DATE_EPOCH` + `FORCE_SOURCE_DATE`; LuaTeX
  additionally needs a non-empty `\pdfvariable trailerid{lax}` (an empty
  one does not help). The digest is therefore a reproducibility claim for
  the pinned image.

## Spike results (2026-09-02)

Throwaway material lives in `spike/paper/` (not for commit).

- **Image pull on an Actions runner.** `texlive/texlive:TL2025-historic`
  (`sha256:f25ee2dcd00f58198f918064f4a1c8562410b33e84155bd55b02b419d73d9391`)
  pulled in 93 s on `ubuntu-latest`, 5.49 GB on disk of the runner's 87 GB
  free; latexmk 4.87 inside; a trivial compile ran in under a second. Run:
  jan3er/lax-scratch-control, workflow `tex-pull-timing`, branch of the same
  name (delete with the scratch repos). Verdict: pull on demand, no layer
  cache needed for now.
- **Marker pipeline** (`spike/paper/pipeline/REPORT.md`). pdflatex and
  lualatex (host, TL2023) and xelatex (docker, TL2025) all compile the
  rewritten fixture with bibtex, hyperref loaded by the author, nested,
  inline, page-spanning and `\input`-ed markers: 12/12 destinations
  extracted, text positions identical to the author's unrewritten build
  per text item, two runs byte-identical. Findings folded into the plan:
  `-jobname` is mandatory with pretex; the vertical-mode glue lift in the
  package; non-recursive `TEXINPUTS`; `HOME=/tmp`; LuaTeX's trailer id;
  pdf.js returns a `Map`. The verbatim trap is rewritten textually, shows
  as literal text in the PDF, and is caught by the count check as one
  finding naming the id. Untested there: overlapping non-nested markers,
  moving arguments, listings, biber, `\include`, the size caps.
- **Viewer** (`spike/paper/viewer/REPORT.md`, screenshots in `shots/`).
  A two-column, three-page fixture with six ranges (block, inline,
  page-spanning, column-spanning, nested, ambiguous line-start) highlights
  correctly under the site's CSP with vendored pdf.js 6.3 and no inline
  script; cards click both ways. Findings folded in: the `v`/`h` mode tag
  on destinations, `\relax` after the dest, the boundary rule, rail
  ordering and pointer-events decisions. Numbers: ~375 ms to load, read
  destinations and render three pages headless; `pdf.mjs` 860 KB and the
  worker 2.2 MB unminified (128 KB + 367 KB gzipped, minified). Pitfalls:
  pdf.js 6.3 calls `Math.sumPrecise`, missing in older Chromium, and
  silently drops glyphs without a three-line polyfill; the text layer
  needs both `--scale-factor` and `--total-scale-factor`.
