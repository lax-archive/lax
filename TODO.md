# TODO

Open work items, roughly in order. History lives in `history/` and git —
the rework execution record is `history/rework-execution.md`, the go-live
record (database port, cutover, HTTPS, first releases, round trip) is
`history/go-live.md`. Current state lives in README.md; proposed spec
amendments in spec-notes.md; the rework charter in rewrite.md +
rewrite-plan.md (fully executed).

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

## Old deployment (the box) — stopped 2026-08-06, decommission owed

The box is powered off and its irreplaceable state exported to
`~/lax-box-final-20260806-153311.tar.gz` on Jan's machine (see
history/go-live.md). Still owed:

- **Move the final export somewhere durable.**
- **Delete the server** (`lax-server`, id 154491090) in the Hetzner
  console — a powered-off server still bills.
- Revoke the old Hetzner API token in the console (pasted into a chat
  transcript 2026-07-26; deleting the file did not kill the credential)
  and rotate/retire the S3 credentials for the same reason. The
  `lax-ops-backup` bucket still holds the last `ops.sql`; decide
  keep-or-delete when the final export has a durable home.

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
- **An offline scaffold cannot be renumbered.** `lax init --offline` writes
  `lax-0` into the manifest, both lakefiles, both root modules, both module
  directories — and from then on into every import and namespace the author
  writes. Nothing turns that into the `lax-N` a real init reserves, so the
  answer today is `lax init` in a fresh folder plus a manual carry-across,
  which is what the refusal message says. Candidate once the flag has seen
  some use: `lax init --adopt <folder>`, which reserves an id and rewrites
  the `Lax0` identifier throughout (a rename over `.lean` sources, so it
  wants a real test, not a `sed`).
- **`lax doctor` blames the wrong era for cross-submission clones**: the
  `.lake/packages` check intersects override *names* with materialized
  clones, so a hand-added relative override for a `LaxN` git require makes
  its correctly-pinned clone report as a "mathlib-closure clone from the
  pre-overrides era". Only the warm closure is ours to call dead weight;
  a `LaxN` clone is live the moment the overrides file is regenerated
  (`seedOverrides` rewrites it wholesale from the warm manifest, dropping
  every hand-added entry). Narrow the check to the warm-closure names, and
  say what deleting costs (a re-clone) when a `LaxN` entry is involved.

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

- **[Jan] Renderer release**: bump
  `src/cli/deployment/website-source.lock.json` to a paper-bearing
  lax-website revision, `page-builder:package` + `page-builder:verify`
  (they now write and check `THIRD-PARTY-NOTICES.txt`), npm publish,
  update `_renderer/latest.json`; then the release-step edit recorded in
  code comments — add `assets/site/pdfjs`, `assets/site/reflowtex`, and
  `assets/site/manuscript.js` to `REQUIRED_RENDERER_PATHS`
  (`src/cli/website-renderer.ts`) and to the `deployment/verify.ts` path
  list. Until the release, `lax serve` feeds the paper inputs to a pinned
  renderer that ignores them.
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
- **`\includegraphics` in the web view**: included graphics files are
  dropped (kern of their width + a `web-pictures-dropped` warning; the
  fork's `convert_pictures` tolerates unsourced image rules when the
  caller opts in) since the first real LIPIcs paper (lax-65, 2026-09-03)
  hit the stock abort over its ORCID icon. Supporting them means hooking
  `\Gin@setfile` in `laxreflow.sty` to stamp and record the resolved
  file like the tikz capture does, converting referenced PDFs in the
  export script (they live outside `pics/`), and deciding what the viewer
  does with raster formats.
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

## Admin tool (admin-plan.md — designed, not implemented)

Maintainer-only operations: `/lax admin <verb>` issue commands
(delete/reset-draft/undelete/revalidate/owners, two-phase confirm for the
destructive ones) plus an `admin.yml` workflow_dispatch for repo-wide work
(rebuild-website, sweep, verify, gc-captures). Numeric-id allowlist in
constants, checks repeated credential-free in the publisher; no standalone
tool, no direct database writes. See admin-plan.md; spec-notes entry due
when it lands. Partially answers the abuse-stance item below.

## spec.md reconciliation queue (Jan, manually)

- `lax init --offline` and the placeholder id `lax-0` (spec-notes,
  2026-08-24): init no longer always allocates an id, and the CLI section's
  init description needs the flag.
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
  potentially large); nothing collects entries the current manifest no
  longer names. Candidate: `lax build` collects packages absent from the
  manifest it just wrote, or `lax doctor` gains a fix.
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
