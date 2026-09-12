# TODO

Open work items, roughly in order. History lives in `history/` and git —
the rework execution record is `history/rework-execution.md`, the go-live
record (database port, cutover, HTTPS, first releases, round trip) is
`history/go-live.md`. Current state lives in README.md; proposed spec
amendments in spec-notes.md; the rework charter in rewrite.md +
rewrite-plan.md (fully executed).

## Stability pass 2026-09-07: what it owes

Landed on `claude/lax-repo-improvements-qruciz` (compile thread budget
named and per-environment, `--memory-swap` pinned to the cap, credentialed
jobs building from their own checkout, cancelled runs reported, publish
job timeouts, the record gates placed once in `record-gates.ts`, delete
re-listing dependents at the snapshot, the unknown-verb reply naming the
verbs, the instructions' two-run first submit). Still owed before it ships:

- **Scratch-repo rehearsal** (`scripts/rehearsal/`) for the
  `submission.yml`/`setup-lax` change — the standing rule for any
  Actions-side change. What to watch: the publish jobs building their own
  tree (about 13 s more each), a deliberately cancelled validate job
  producing a failure comment and clearing the reaction, and a delete
  raced by a submit refusing with the fresh dependents list.
- The failure comment a cancelled validate job now gets is the
  infrastructure wording ("no trustworthy report was produced"), accurate
  for a timeout and slightly misleading for a manual cancel; the reporter
  cannot tell the two apart from the report alone. Reword if it confuses
  an author.
- `scripts/environments/admit.mjs`/`table.mjs` render only `leanThreads`
  and `memoryBytes`; a `compileLeanThreads` override is written by hand.

## Submission presentation flags (core implemented 2026-09-09; Website pending)

The `lax` validator and trusted artifact parser now accept and retain the
optional manifest booleans `unlisted` and `anonymous`; see `spec-notes.md`.
The remaining work belongs to `lax-website`:

- Add both fields to the Website manifest type. Exclude `unlisted: true`
  submissions from the landing-page submission list and all search/tag index
  inputs, while continuing to generate directly addressable submission,
  concept, proof, and paper pages.
- For `anonymous: true`, suppress author names and identity links, generated
  citations, and every source-repository link across submission, concept,
  proof, paper-card, graph, and metadata surfaces. Cover every supported
  repository provider, not only GitHub. Public database and source data stay
  unchanged; this is presentation anonymity, not confidentiality.
- Add Website fixtures and assertions for each flag independently and
  together. Once deployed, update `assets/instructions.md`, advance the
  renderer pin used by `lax serve`, and include the new fallback renderer in
  the next CLI release.

## Audit leftovers (audit 2026-09-03, fixes landed 2026-09-04)

The record is `history/audit-20260903.md`. All three fix-now findings and
all eleven fix-soon findings are fixed, each with the test that would have
caught it; the spec-relevant behaviour changes are in spec-notes.md
(2026-09-04). What the audit deliberately left, and what the fixes left
behind:

- **Production checked 2026-09-04.** lax-3's stale-dependency failure
  (2026-09-03 19:29, racing the chain sweep) was retried the same evening
  and published at 20:10 (`0d5dc53`), so nothing is owed there. The
  stranded-dependents sweep found none: the three deleted records
  (lax-15, lax-55, lax-61) are required by no live record. The one
  pre-2026-09-03 paper record is lax-48 (below).
- **Recorded and not fixed** (the audit's "record and move on"): `lax
  register`'s preflight prints the permanence note and demands a typed
  confirmation for a supersession the archive will refuse, and
  `instructions.md` plus a docstring at `resolution.ts:251` state only the
  weaker of the two ownership rules; the count-check diagnosis never offers
  "that file is not part of your main document"; the oracle prints
  `floor − 2/total` as a measurement when Myers' search exceeds its budget,
  so a true 0.0 reads as a hairline 0.9799; a duplicate `\input` collapses
  destinations silently (pdfTeX warns, latexmk does not fail — scan the
  transcript for "duplicate ignored"); proof-tree housekeeping (a failed
  re-run leaves a stale `.olean` beside no report, concurrent capture
  promotion crashes with `ENOTEMPTY`, the runtime cache key omits the
  toolchain `warmDir()` includes); `submit-publisher.ts:256` claims
  `parseArchiveFiles` re-validates a published `paper` block, which it does
  not. (The cancelled-validate silence — 7 of 200 runs — was fixed
  2026-09-07: both reporters accept `cancelled`.)
- **The same defect class, one step out.** Findings pushed straight into
  `violations` by `pipeline.ts` and `host/pipeline.ts` bypass
  `FindingCollector` and so its sanitizer; they reach only `ok:false`
  reports, which the publisher never parses, so nothing is at risk today.
  Route them through the collector. Likewise nine separate spellings of
  "normalize line endings" (the formatter's own is inline in
  `safeTranscript`) want one exported helper in `comment-format.ts`, and
  `"pics"` is a literal in four places across `web.ts` and the generated
  converter.
- **Coverage the fixes could not reach.** `checkGeneratedFilesIgnored` is
  wired in the `scope === "both"` success block, which only a full Lean
  build reaches, so no unit test crosses it — the cheapest real coverage is
  `test/e2e/host-paper.test.ts` with `paper.pdf` dropped from
  `test/support/host.ts:90`'s fixture ignore list. Those hand-written
  ignore lists (also `test/smoke/submission-validation.ts:432`) are the
  sixth copy of the generated-file names and should read
  `generatedFilesGitignore()`.
- **What the new typecheck does not cover.** `scripts/**` is checked for
  `.ts` only; the `.mjs` drivers (`port-db`, `rehearsal`, `reflowtex/fetch`)
  need `allowJs`+`checkJs`, which will surface its own list. And tsc accepts
  the temporal-dead-zone read that started all this — an ESLint
  `no-use-before-define` would catch that class, at the price of a linter.
- **`proof-tree.json`'s `selection` value** changed from `"random"` to
  `"fallback"`. Nothing in this repo or lax-website reads it; out-of-tree
  tooling would break.
- **`lax rekey` leaves a stale `paper.pdf`/`paper-web.tar`** in the folder
  after renumbering (it removes `build-output.json` only).

## Pipeline simplification: rolled out and closed, 2026-08-07

Nothing left here — the record is `history/pipeline-simplification-rollout.md`,
including the production sweep (seven records resubmitted bottom-up) and the
deliberate failure probe that closed the last untested path. The superseded
Website App private key was deleted and `roundtrip-20260807` was merged into
lax-submissions `main`, so every recorded source is reachable from the
default branch.

Merged and released as 0.1.21: the fail-early static gate, the
route → validate → publish-submit DAG with the Website dispatch folded into
the publish jobs, and the report artifact as the author's channel. The
rollout that went with it: both App keys now live in `lax-database-publish`
(a freshly generated Website key — GitHub never shows an existing one
again), that environment's deployment policy is a custom one naming `main`
instead of the "protected branches" policy that constrained nothing (the
repo has no branch protection rule and no ruleset), the
`lax-website-dispatch` environment is deleted, and the CLI App
(`lax-cli-publisher`, org-owned like the other two) has the `Actions: read`
permission the report download needs.

## Go-live leftovers (context: history/go-live.md)

- **Round-trip sources: settled.** lax-submissions `main` is now `4af91ea`,
  which carries the recorded source of all seven chain submissions —
  lax-13/lax-14 at `d35ba57`, lax-11/lax-12 at `becb578`, lax-3/lax-5/lax-15
  at `4af91ea`. The old `roundtrip-20260806` and `port/chain-requires`
  branches name commits no record points at any more, so they are free to
  delete.
- **Scratch-repo teardown**: delete `jan3er/lax-scratch-{control,database,
  submission}` and ghcr package `lax-scratch-captures`, and rotate the
  personal token that stood in for the App mints (Jan).
- **port-db driver robustness** (matters only if the driver runs again):
  retry transient `gh` failures during polling instead of failing the
  record; check for our command marker before re-posting after a timed-out
  POST; raise the 20-min default timeout (lax-17 validates in ~28 min).
- Delete the dead `lax-capture-*` GitHub Releases on lax-database and the
  stale `LAX_VALIDATION_IMAGE` Actions variable on lax-archive/lax.
- **Org domain verification** for laxarchive.org (lax-archive Settings →
  Pages → verified domains) against domain takeover.

## CLI

- **The CLI cannot renew a login, so `lax login` is due every 8 hours**
  (Jan, GitHub App settings). The App issues expiring user tokens, and
  GitHub renews one only for a client that presents the App's *client
  secret* — which a published CLI has nowhere to keep. The renewal request
  therefore always comes back `incorrect_client_credentials` (verified
  against github.com, 2026-08-09), and re-logging in is the only path.
  The messages no longer blame a GitHub outage for it, but the fix is a
  setting, not code: turn **Expire user authorization tokens** off in the
  `lax-cli-publisher` App. New logins then store no `expiresAt`, the
  renewal path is never entered, and the login lasts until it is revoked.
  Decide against the security trade-off (a leaked `ghu_` stops expiring on
  its own; `lax logout` and GitHub's revocation page still kill it).

## Paper layer (paper-plan.md + paper-web-plan.md — code stages landed 2026-09-02; Jan-owned gates remain)

A submission may carry a LaTeX paper the archive compiles itself (`paper:`
in `manifest.yaml`, `% lax begin <id>` / `% lax end` markers); beside the
PDF the archive derives a reflowable web view (ReflowTeX, non-blocking,
`web: false` opts out), and the site's paper page shows both surfaces with
a card per marked passage. All code stages of both plans are merged
(lax-website 2026-09-03 morning, lax the same day); the author contract
is in instructions.md, the proposed spec amendments in spec-notes.md
(2026-09-02, 2026-09-08). The fork `lax-archive/reflowtex` exists (`lax`
branch, one commit per changed file) and the pin points at it. Jan waived
the scratch-repo rehearsal for the 2026-09-03 merge ("finish all the
way"); the standing rule itself stands for the next Actions-side change.
The first real papers (lax-65, then the 2026-09-08 corpus pass over 44
papers — `history/reflow-maturation-20260908.md`, which holds the defect
classes, the per-round numbers and the lessons) closed the trusted-path
and rendering defects that one fixture could not reach. What remains:

- **Deploy the 2026-09-08 reflow pass.** In order, all of it uncommitted
  to any remote today:
  1. push the fork checkout's `lab` branch onto `lax-archive/reflowtex`'s
     `lax` branch (8 commits over the pinned `61dc460`; noreply author —
     GitHub rejects the gmail address, so Jan may have to push), then bump
     `REFLOWTEX_REV` in `pins.ts`. `reflowtex/fetch.mjs` already asserts
     the new schema surface (`fnref`, `footnote_ref`, `Paragraph.width`,
     `Paragraph.footnote`), so a stale pin fails the fetch loudly.
  2. merge the `lax-website-reflow` worktree's `reflow-lab` branch (viewer
     + schema gate + the uncommitted sidenote work, below) into
     lax-website `main`.
  3. `npm run check` and `LAX_SMOKE_CASE=paper-web npm run
     smoke:submission-validation`, then recut the bundle fixture
     (`npm run paper-web:fixture`, `test/fixtures/paper-web/paper-web.tar`)
     — the old one carries the pre-footnote schema.
  4. re-pin and release the renderer for `lax serve` (the mechanism is
     done: `https://laxarchive.org/_renderer/latest.json`, packaged by
     `release.yml` on the `v*` tag; only the lax-website rev needs
     moving). The picture converter's wheel is *not* part of this — only
     the trusted container derivation uses it.
  5. `npm run admin -- revalidate` the three paper records:
     **lax-157538** (no `paper.web` at all today), **lax-48** (registered;
     blank figures and missing icons from the pre-2026-09-03 Ghostscript
     conversion — this is the admin verb's first production use), and
     **lax-242665**.

  The lax-side changes (`assets/tex/laxreflow.sty`,
  `reflowtex/encode_web.py`, `reflowtex/fetch.mjs`, `paper/web*.ts`,
  `paper/extract*.ts`, `config.ts`, their tests) and the lab harness
  itself (`scripts/reflow-lab/`, still untracked) commit with step 1.
- **Six web-compile classes still failing or shimmed** (round 3, 6 of 45
  entries skipped on `web-compile`; the lualatex + `-shell-escape` +
  injected-package combination breaks documents whose own pdflatex build
  is fine):
  - **acmart + unicode-math**: `\widehat\CC` (a `\mathcal` alias under
    `\widehat`) aborts with `Missing { inserted` at
    `\__um_group_begin:` — `decomposition-trees`,
    `model-checking-interpretations`. A source-side limit as far as we
    know; the paper keeps a PDF-only page. Worth one more look at whether
    the injection order can avoid it.
  - **AAAI `\boundary`**: `aaai24.sty` papers that
    `\newcommand{\boundary}` collide with LuaTeX's `\boundary` primitive
    (`preprocmso`). `luatex85` does not cover it; a shim would have to
    `\let\boundary\undefined` before the class, which is a real decision
    (the primitive is otherwise reachable).
  - **remember-picture / overlay under externalization**: the sub-run
    exporting one picture cannot see a node another picture defined
    (`No shape named 'inText' is known`, `monadic-stability`).
  - **lmcs shipout**: the class takes `\shipout` in a way that leaves
    pgf's `\pgfexternal@originalshipout` undefined in the sub-run
    (`struc-bound-exp`).
  - **Externalization cost on long figure-rich papers**: externalization
    re-runs the whole document once per picture, so `grid-wideness` (124
    pages, 190 files) took 623 s and blew the then-10-minute limit. The
    limit is now 30 min (`paperWebCompileTimeoutMs`); re-measure it.
  - **`bbm` Metafont fonts**: `bbm` ships Metafont sources only, so
    `bbm10`/`bbm7` are requested by the export and no Type1 outline
    exists (`lax-web-pfbs.txt` lists them, `lax-fonts/` has no
    `bbm*.pfb`) — `\mathbbm` glyphs stay metric boxes in lax-157538.
- **The oracle residual for papers still under 0.98.** All 20 `web-oracle`
  skips were decomposed (`diff --minimal` hunks; the hunk decomposition
  *is* the Myers metric, and a Python re-implementation of `web-oracle.ts`
  reproduces every job's similarity to 6 decimals). 27 481 divergence
  tokens, and **not one of them is a real text loss** — no hunk anywhere
  shows the view dropping a sentence the PDF sets. The classes:
  token-boundary skew in math **33 %**, moved text (floats and captions)
  **22 %**, math-font glyph asymmetry **21 %**, token-boundary skew in
  words **10 %**, text inside included figures **6 %**.
  - **Oracle-side, being implemented now** — measured to take **12 of 20**
    over the floor, from 0 today: **(A)** merge-tolerant `compareTokens`
    (a hunk whose two sides concatenate to the same characters is not a
    divergence) — alone 10 of 20; **(B)** character-level `removeTokenRun`,
    which also drives `relocatedUnmatched` to 0 everywhere; **(C)** fold
    U+2206 to U+0394 in `oracleTokens` — one line, and `arxiv-0902-0732`
    0.9715 → 0.9902. Not "drop single-character tokens": measured, it
    *lowers* similarity on 14 of 18 jobs by shrinking the denominator.
  - **Stream side, what is left after A+B+C** (8 papers): non-CM 8-bit
    faces (Euler, Palatino) mis-decoded in `encode_web.py`'s
    `decode_glyph` — 1 398 tokens, `daniel-thesis` alone; cmex/cmsy
    lowercase slot letters, where the fix is to mirror pdf.js's
    slot-letter fallback rather than delete evidence; a clipped
    `\includegraphics` that attribute 902 never stamps, so two papers lose
    their figures *and* their figure text (being fixed now); and floats,
    which the walk emits out of page order — 6 050 tokens, 4 papers —
    wanting either emission at the shipped position or an extension of
    `relocated` to any content the serializer moved.
- **Sidenotes**: the viewer and `manuscript-reflow.js` lift each footnote
  segment into the margin rail where the page has one (the schema carries
  `fnref` / `footnote_ref` / `Paragraph.footnote` and the block states
  `data-latex-footnote-width`), with endnotes as the fallback. Working in
  the `lax-website-reflow` worktree but **uncommitted** — commit it before
  the merge above, or the merged viewer sets endnotes only.
- **tcolorbox callout frames are not drawn.** `shield externalize` (armed
  globally when the package loads) makes the boxes typeset inline, so
  their *text* reaches the stream while the frame, a pgf literal, does
  not. A callout therefore reads as plain body text. Carrying the frame
  would mean giving the walk a box-decoration concept.
- **Nothing in the reflow surface is a link.** `pdf_dest` / `pdf_annot`
  whatsits are dropped by `strip_unsupported_nodes`, so `\ref`, `\cite`
  and bibliography URLs render as dead text — often still in hyperref
  blue, which advertises a link that is not there. (The pdf.js surface
  renders no annotation layer either, so the regression is against the
  downloadable PDF.)
- **[Jan] The fixed-measure column at wide viewports** — a site CSS
  decision, not a defect: the reflow band is ~576 px at an 1100 px
  viewport and ~544 px at 700 px, so nearly half a wide window is empty.
  The gutter is deliberate (margin notes, marked passages, sidenotes). Decide
  whether the measure should grow with the viewport, and by how much.
- **[Jan] Production round trips** closing both plans — a real paper (the
  flagship drafts in `~/git/lax-submissions`) through validate → publish →
  site page with both surfaces — recorded in `history/`; measure the TeX
  image pull there (84 s on lax-61, where it *was* the critical path — a
  layer cache is worth deciding once real papers arrive). Afterwards
  retire paper-plan.md and paper-web-plan.md into `history/`.
- **[Jan] Delete the throwaway repository**
  `jan3er/lax-paper-roundtrip-20260902` from the lax-61 stage-3 round trip
  (`history/paper-roundtrip-20260902.md`): `gh auth refresh -h github.com
  -s delete_repo`, then `gh repo delete … --yes`.
- **Virtual fonts that compose** keep metric boxes: the export follows a
  nameless virtual face to the outline its program draws from and keeps
  only the slots the two share (landed 2026-09-03 for `BOONDOX-r-cal`,
  lipics `\mathcal`), but a slot built from two glyphs (an accent) has no
  single source and stays a box. BOONDOX bold / fraktur / doublestruck
  are untested.
- **Cache the PyMuPDF wheel in the Validate job** (optional): `npm run
  reflowtex:fetch` now downloads 25 MB per paper-bearing run. The existing
  `actions/cache` pair covers `reflowtex/venv`, keyed on
  `requirements.lock`; the wheel would want its own pair over
  `reflowtex/pymupdf`, keyed on the `PYMUPDF_*` pins rather than on all of
  `pins.ts` (which every unrelated pin bump would invalidate). The step
  already tolerates failure — a missed download degrades to a
  `web-toolchain` skip — so this is throughput, not correctness.
- xelatex is untested for the end-marker relocation
  (`test/e2e/paper-neutrality.test.ts` measures pdflatex and lualatex):
  add `texlive-xetex` to the CI TeX set, or verify at the first
  xelatex-engine paper.
- **Upstreaming candidates** from `lax-archive/reflowtex` to
  `radek-p/reflowtex` — all of them fixes to silent drops upstream shares,
  none of them archive-specific: the `has_ink` gate (standalone figures
  vanished from the view), the shipout walk's box/column/rule/footnote
  branches and the `lineno` frame-vs-margin-decoration split, the
  `\@startsection` skip restore at a page top, the Type1 glyph-name →
  Unicode addressing (upstream sends every math relation to the PUA), the
  ligature/small-cap `text` field, and the missing-character drop.
  Marker capture and the `page` field on a picture are ours to keep.
- Known limits, carried: pdf.js stays `pdfjs-dist` 5.6 (the last line
  that runs on Node 20.19; its optional `@napi-rs/canvas` native
  dependency is never loaded); the paper containers run under the Lean
  memory/cpu caps (a smaller per-invocation cap is a knob); the TeX image
  digest is not recorded in the report's runtime identity (the pin lives
  in `pins.ts`, so a bump is a reviewed edit).

## Archive environments (closed 2026-09-04; record in history/)

Several Lean/mathlib versions: a yearly **epoch** as the default, monthly
mathlib `vX.Y.0` release tags as admitted environments authors may stray
to after a typed confirmation. All six stages, the first admission
(`v4.33.0`, CLI 0.1.39) and the first off-epoch round trip (lax-851268,
deleted afterwards) landed 2026-09-04; the plan is
`history/environments-plan.md` and the round trip, with its measurements,
is `history/environments-roundtrip-20260904.md`. What stays open:

- **Actions may open pull requests since 2026-09-04 evening** (Jan
  turned on "Allow GitHub Actions to create and approve pull requests" in
  the organization's Actions settings). The first admission's pull
  request was opened by hand because it was off; the next scheduled run
  (Tuesdays 04:41 UTC) is the first to exercise `gh pr create` from the
  admit job — check that it lands.
## Admin tool (admin-plan.md — issue-scoped verbs and the driver landed 2026-09-04)

`/lax admin revalidate|delete|reset-draft|owners` are live in the control
plane (numeric-id allowlist `ADMIN_GITHUB_IDS`, gates repeated
credential-free in both publishers; spec-notes entry 2026-09-04), driven
from a maintainer's machine by `npm run admin -- …` (`scripts/admin/`,
the maintainer's own `gh` token, comments and reads only). Still owed:

- **Production round trip**: `npm run admin -- revalidate lax-48` is the
  first real use (see the lax-48 item above). Watch the run once: the
  Validate job on a closed issue, the `revalidate` result comment, the
  ghcr push, and the Website rebuild of a record whose state did not
  change. A scratch-repo rehearsal (`scripts/rehearsal/`) first if the
  shape of the Actions-side change feels risky.
- **Not built**: `undelete` (restore from git history; needs the
  tombstone → pre-tombstone diff and a rule for the retired id),
  `verify` (the archive-level `lax doctor`), and `gc-captures`
  (unreferenced ghcr artifacts). `sweep` is `revalidate --all`.
- **Deferred by design**: the plan's server-side two-phase confirm
  (`/lax admin confirm <preview-id>`) — the typed confirmation lives in
  the driver, as it does for `lax delete`; and an `admin.yml`
  `workflow_dispatch` — `rebuild-website` is a `repository_dispatch` the
  maintainer's own token already may send, so nothing new runs in the
  publish environment.
- Partially answers the abuse-stance item below; the takedown rationale
  goes in the issue comment, never in the record.

## spec.md reconciliation queue (Jan, manually)

- Loginless `lax init`, locally generated six-digit ids, manifest issue
  bindings, and automatic `lax-0` migration (spec-notes, 2026-09-03): the CLI
  and Actions/Init descriptions still assume issue-number-derived ids.
- Versioning via `supersedes` successor chains (spec-notes, 2026-08-23):
  the optional manifest key, what registration additionally binds and
  checks, and the site generator's derived chain views.
- The "Continuous preview while authoring" subsection an agent inserted into
  this repo's spec.md (see spec-notes, 2026-08-05): bless or strip.
- Auth model: GitHub App user tokens replaced the OAuth device flow the spec
  era assumed (spec-notes, 2026-08-05).
- Submission deletion (carried from old repo): Lifecycle still lists three
  states / five transitions; `lax print spec` contradicts the implemented
  tombstone flow.
- Sibling path requires were *removed* (spec still needs the old feature
  folded in or the prohibition recorded instead), and multiple statements
  per concept were restored.

## Author frictions (from hiccups.md, still open)

- Apache-2.0-only license gate — salvaged MIT/BSD source has no path;
  decide allowlist vs. loud documentation.
- `Batteries.*` imports rejected (`IMPORT_PREFIXES` in
  `phases/inspect.ts`); authors must hunt a Mathlib module that
  transitively imports it. Also: the violation message no longer lists
  what *is* importable — restore that.
- Flat concepts + per-module namespace ownership makes faithful
  multi-module ports impossible (28 modules → one 762 KB module).

## Concept dialect (spec_conceptdialect_draft.md — advisory model)

Still fully open; zero implementation in this tree. The draft (2026-07-29,
awaiting reconciliation) makes "safe dialect" a derived non-blocking label
and adds the mention rule (list 8) closing the `autoParam` value-door that
spec_conceptdialect.md still has open. Implementation order (re-map onto the
Actions architecture when planned): corpus restructure first (in
lax-submissions, while everything is a mutable draft); Compile split so
proof code can never write what gets captured, with capture provenance;
versioned machine-readable dialect schema (kind lists, payload rules,
generated term-kind snapshot and excluded-name set); gate executable beside
the inspector (guarded frontend, identifier resolution against the mention
rule, info-tree check for elaboration-resolved spellings, `--dump-schema`);
Dialect phase between Provision and Compile; CLI warning walk during local
Resolution (warn, never refuse; `--require-safe` reserved); website label;
initial batch verification over every record in dependency order.

## Carried over from the old repo (still applies here)

- **Abuse stance**: takedown/moderation policy, and what
  "registered is forever" means legally. (Rate limiting now largely
  inherits GitHub's issue/Actions limits — revisit whether that suffices.)
- **Scaffold-as-tutorial pass**: the `lax init` scaffold is the de-facto
  tutorial; give it a small worked example using the annotation vocabulary
  and a README pointing at `lax print spec` and the site.
- **Violation-message audit**: each violation should cite the spec section
  and show the offending line. (The rewrite's 25 distinct violation kinds
  are a good base to build on.)
- **Support channel**: point `--help` / failure output at the issue tracker.
- **Stale `.lake/packages/<LaxN>` clones** linger in author trees once a
  require is dropped or re-pinned (since 2026-08-06 local builds
  materialize dependency clones there *by design* — full repo clones, so
  potentially large). `lax doctor` now names the ones the manifest no
  longer lists, but nothing collects them: the pipeline knows the exact
  name set at `seedManifest` time, so `lax build` deleting packages absent
  from the manifest it just wrote is the better home for the sweep.
- **Registered submission depending on a deleted draft**: deletion only
  warns about stranded dependents; nothing prunes or blocks the registered
  side. Verify the rewrite's publisher has the same gap, then decide.
- **Flagship drafts restructure** (in `~/git/lax-submissions`, not here):
  submission-polish.md — one-statement and type rules fire at submit today;
  the multiple-statements relaxation changes this plan, revisit it then.
- **Workbench/public-repo split for submissions** (Jan's idea, 2026-07-29):
  private workbench repo + a public repo that only changes on submission;
  script first, CLI flag later. Simpler now that waves are gone.
- **Registered-repo mirrors** (idea): keep a mirror of each registered
  repository so archived builds survive upstream deletion.
- **Replay floor**: the remaining per-invocation floor is the one mathlib
  environment import per leanchecker/inspector run; a warm importer would
  cut it. Re-profile now that the pipeline collapse has landed (`--profile`
  exists and works).
- Website-side items now live in `lax-archive/lax-website`: tombstone page
  vs. 404, contributing page wiring, site publication atomicity, search
  index at ~100 submissions, endorsement attestations (v0.3), multi-atom
  source cards (v0.4), and the multiple-statements presentation
  (anonymous per-statement indices) from rewrite.md.

## Second maintainer onboarding

Carried and adapted: invite the second maintainer to the `lax-archive` org
(decide role, consider org 2FA requirement); npm maintainer access (2FA —
publish rights are the deploy gate); the secrets doctrine is now: both App
private keys live only in the one protected Actions environment
(`lax-database-publish`, which deploys only from `main`), a maintainer's
laptop holds nothing — and a key that leaves that environment cannot be read
back, only regenerated. All three App registrations (`lax-cli-publisher`,
`lax-database-publisher`, `lax-website-dispatcher`) were confirmed org-owned
on 2026-08-07. Sweep docs for "maintainer call" spots that assume one
person.

## ORCID-authed comments (design pending)

Comment section on record pages, authed via ORCID OAuth. The old design
homed the data in the server's ops.sqlite — that home no longer exists;
needs a new one (the database repo is public and append-only, so probably
not there). Needs the moderation stance above first.
