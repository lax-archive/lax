# TODO

Open work items, roughly in order. History lives in `history/` and git —
the rework execution record is `history/rework-execution.md`, the go-live
record (database port, cutover, HTTPS, first releases, round trip) is
`history/go-live.md`. Current state lives in README.md; proposed spec
amendments in spec-notes.md; the rework charter in rewrite.md +
rewrite-plan.md (fully executed).

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
  not; and a cancelled validate job leaves no comment and a stuck progress
  reaction — 7 of the last 200 control-plane runs were cancelled, so an
  author has probably seen an issue that simply stopped answering.
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
- **Flaky `--resume` e2e under parallel load**: `test/e2e/cli-github.test.ts`
  "reattaches an interrupted submit" intermittently sees
  `waiting for workflow` instead of `validate · Compile` when the full
  suite runs concurrently; passes in isolation. A timing race in the
  fake-Actions poller — fix the test (or the poller's readiness signal),
  found 2026-08-06 by the CI-gate worker.
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
is in instructions.md, the proposed spec amendment in spec-notes.md
(2026-09-02). The fork `lax-archive/reflowtex` exists (`lax` branch, one
commit per changed file) and the pin points at it. The paper-web docker
smoke first ran 2026-09-03 on Jan's machine and found the pinned image's
dvisvgm cannot read PDF (Ghostscript 10.07, no mutool) — fixed with the
Ghostscript EPS detour in `web-container.ts`; the web compile of the
tikz fixture takes ~16 s in the image. Jan waived the scratch-repo
rehearsal for this merge (2026-09-03, "finish all the way"); the standing
rule itself stands for the next Actions-side change. The first real paper
(lax-65, LIPIcs, 2026-09-03) then found three trusted-path gaps the tikz
fixture could not: the fork's opt-in list for unsourced pictures shadowed
a local (UnboundLocalError; renamed, fork 74215bf); every text face of an
lmodern/lipics paper is a re-encoded legacy Type1 (`ec-lmr10` is
`lmr10.pfb` through `lm-ec.enc`, no `ec-lmr10.pfb` exists) that stock
lookup never finds — and on the TeX-less Validate host the fallback
`kpsewhich` call crashed the encode; and the oracle read those faces'
slots through a Computer-Modern-keyed table ("deøned", vanished accents,
"1γ"), subtracted trial typesettings (`\caption`'s measuring box, a
paragraph's opening letters) from the PDF side, and landed at 0.9799
against the 0.98 floor. Now: the fork resolves legacy faces through
`pdftex.map` with their encoding vectors (exported in-image as
`<name>.pfb` + `<name>.enc`, `find_outline`), f-ligatures address their
presentation forms, `provision` survives a missing kpsewhich, the oracle
text is taken after the legacy re-addressing, and a capture whose text
the stream carries is no omission (`web.ts`); the smoke fixture typesets
in T1 Latin Modern so the map route runs in the pinned image. What remains:

- **Renderer release: done.** The bundled fallback and the download share
  one surface again: the pin names lax-website `30927d2d` (2026-09-04,
  the paper viewers, the multi-statement presentation, and the machine
  index), `https://laxarchive.org/_renderer/latest.json` serves it, and
  `release.yml` packages it on the `v*` tag. (The picture converter's
  wheel is *not* part of this: only the trusted container derivation uses
  it, and `npm run reflowtex:fetch` already brings it — `lax serve` and
  `lax build` derive no web view at all.)
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
- **Virtual fonts in the web view** (done 2026-09-03, kept as the record):
  `\mathcal` in a lipics paper is `BOONDOX-r-cal`, a *virtual* font —
  pdftex.map names no outline for it, so every calligraphic letter was a
  red metric box (lax-65 throughout its statements). The export now
  follows a nameless face to the font its program draws from (`vftovp`,
  MAPFONT 0 → `zxxrw7z` → `zxxrw8a.pfb`) and exports that outline under
  the virtual name; the host keeps only the slots the two share
  (`sharedSlots`), naming them from the base's own vector — its map
  `.enc`, else `8a.enc` where the outline says StandardEncoding, else the
  outline's own `dup … put` lines — so a slot the virtual font borrows
  elsewhere (BOONDOX takes its digits from cmr10) stays a metric box
  instead of becoming the base's glyph for that code. A face whose
  program or vector cannot be read loses its outline entirely. Still
  open: a virtual font that *composes* (accents built from two glyphs)
  keeps metric boxes for those slots, and BOONDOX bold/fraktur/
  doublestruck are untested.
- **Re-validate lax-48**, the only paper record derived before
  2026-09-03 (checked 2026-09-04; lax-65 was re-validated that day and
  lax-61 is deleted). Until that day the in-image picture conversion went
  through Ghostscript, which rasterized every page carrying transparency
  into a JPEG the sanitizer then dropped, and every plain
  `\includegraphics` was dropped to a kern; both are fixed in the
  derivation, not the site, so lax-48 keeps its blank figures and missing
  icons. It is *registered*, so `/lax submit` refuses it: run
  `npm run admin -- revalidate lax-48` (the admin `revalidate` verb landed
  2026-09-04; this is its first production use — see the admin section).
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
- The serializer's `has_ink` gate fix (standalone figures vanished from
  the web view; upstream has the same silent drop) is an upstreaming
  candidate from `lax-archive/reflowtex` to `radek-p/reflowtex`.
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
- **Nothing saves an off-epoch host cache, so every off-epoch submission
  provisions cold.** Every `submission.yml` run since 2026-08-07 carries
  `Cache reservation failed: cache write denied: token has no writable
  scopes` on its save steps (route's `dist` cache, validate's lean host
  cache): an `issue_comment`-run job with only `contents: read` gets a
  token the cache service refuses to write with. It was invisible because
  `ci.yml` saves the epoch's host cache on every push to `main` and
  validate restores it; the cache API shows the epoch's `v2` entry alone
  (3.28 GB, saved from `refs/heads/main`). v4.33.0 provisions cold on
  every run (~2 min today: warm workspace 102.9 s, peak 7.43 GiB). Fix
  in `ci.yml`, whose saves work — provision and save every admitted
  environment, e.g. in `inspector-matrix`, which already runs per
  environment on table changes and weekly — after weighing the 10 GB
  repository cache ceiling (~3.3 GB per environment, LRU eviction). Do
  not fix it by giving the validate job a writable scope: that job runs
  submission code. The dead save steps in `submission.yml` could then go.
- **The admission's measurement is a note, not a cap** (decided
  2026-09-04, after the first run nearly merged the smoke's 1.15 GiB
  fixture peak as the container cap). The admit job records the peak in
  the pull request body and passes no limits flag; the entry inherits
  `DEFAULT_LIMITS`, and `limits` is written by hand only after a
  full-mathlib replay has been measured in the environment (typically
  `leanThreads: 1` once an import no longer fits twice). A
  workflow-definition test pins it. Nothing to do unless an environment's
  real import outgrows the defaults.
- **Epoch bump**: the runbook in the plan ("Islands, porting, and the
  epoch bump") has not run yet; first due when the 2027 epoch is chosen.
  Re-measure `DEFAULT_LIMITS` on the new epoch's mathlib then.

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
