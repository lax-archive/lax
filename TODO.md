# TODO

Open work items, roughly in order. This file was recreated on 2026-08-05 by
triaging the old repo's TODO.md against the rewrite: items the rewrite
resolved are dropped (resource quotas → container caps; SSRF and local-mount
fetch holes → canonical-GitHub-URL narrowing; torn local db writes → no local
db writes, temp+rename everywhere; in-memory job store → Actions runs;
stale-inspector-binary caching → digest-pinned runtime), items that died with
the box or moved to lax-website are marked so, and everything else carries
over. Current state lives in README.md; proposed spec amendments in
spec-notes.md; the rework charter in rewrite.md + rewrite-plan.md.

## The rework (charter: rewrite.md, plan: rewrite-plan.md)

Suggested order of attack (details in rewrite-plan.md):

1. ~~Doc consolidation~~ — done 2026-08-05 (this file, CLAUDE.md, history/,
   spec-notes entries, README fix, open-use notice).
2. ~~Runner seam + local build + test seams~~ — done 2026-08-05
   (`ValidationRunner` injection; host-toolchain in-place incremental
   `lax build` with streamed transcripts; warm store shared via Lake
   package overrides per the spike below, no hardlink farm; fake-mathlib
   + fake-GitHub seams with real-lake and CLI-subprocess e2e tests).
3. ~~Pipeline collapse~~ — code complete 2026-08-05 (one read-only
   validate job — no issue write, no secrets where submission code runs;
   stock digest-pinned `node:22-bookworm-slim` + VM toolchain/warm store,
   actions-cache saved *before* untrusted code runs; Compile/Replay/
   Inspect sequential through one container runner, replay/inspect at 2
   threads per the measurement; captures on ghcr as digest-addressed OCI
   artifacts — hashed tuple+pin tag, anonymous pull verified live,
   push-before-CAS-commit ordering, Releases store deleted). ~~Live
   rehearsal on scratch repos~~ — run 2026-08-06 together with stage 4's
   publish rehearsal (record: history/live-rehearsal.md); it caught and
   fixed a production-blocking container bug (`installOwnConceptCapture`
   shipped lib without the ir companions; commit ca6db0f).
4. ~~Write path~~ — code complete 2026-08-05 (CAS + credential-free
   preflight unchanged; all `concurrency:` blocks removed per addendum
   point 4, CAS is the correctness mechanism; inline-JS failure reporter
   replaced by a typed `report-failure` mode with byte-compatible
   markers; YAML logic assertions converted to behavioral TS tests incl.
   an env-poisoning canary proving prepare-submit never touches the
   database token; YAML keeps only wiring/permission/pin lints). The
   stages-3+4 live rehearsal ran 2026-08-06 — see item 3.
5. ~~Test port~~ — done 2026-08-05 (triage executed: ~17 real-lake and
   unit ports incl. the compiler-realized-reserved-name and scoped-build
   regressions; cross-submission dependency e2e over a fake ghcr — which
   exposed and fixed captures shipping only oleans while lake v4.30
   needs the trace/hash/ilean/ir companions, a production-blocking bug;
   CLI delete-refusal e2e; opt-in real-mathlib e2e restored under
   LAX_E2E=1, run once, 24.7 s against the warm store; sibling and wave
   ports skipped as moot, sitegen/DAG tests belong to lax-website).
6. ~~Independent follow-ups~~ — done 2026-08-06, one commit each:
   sibling paths forbidden (siblings.ts + arms deleted, chain-workflow
   guidance in static/resolution errors and instructions.md; note: the
   repo-wide H5 duplicate-id/nesting scan died with siblings.ts — no
   longer correctness-relevant, revive only as hygiene if missed; the
   `lax submit A B C` macro is still future CLI work); multiple
   statements per concept allowed (inspect gate + the trusted artifact
   parser's cardinality bound removed; presentation is lax-website
   work); CLI polish (`lax submit --resume` re-deriving the run from
   issue comments, source-triple submit replaces `lax update`,
   progressive doctor, no-silent-waits sweep incl. login heartbeat and
   per-dependency capture progress).

Verify early — see rewrite-plan.md's red-team addendum (2026-08-05), which
wins over earlier plan text where they conflict. The three load-bearing
unknowns: ~~replay memory on a 16 GB swapless hosted runner~~ — measured
2026-08-05, **go** at ≤2 threads (10.78 GiB peak on word-ram at t=2;
~5.6 GiB per concurrent mathlib environment import, so t=4 never fits;
numbers in the plan addendum point 1), the `queue: max`
concurrency semantics (classic Actions concurrency cancels pending runs;
until verified, CAS-only), and ~~whether Lake package-overrides reuse built
oleans~~ — resolved 2026-08-05, they do (see the spike verdict below).

**Package-overrides spike** — ~~run 2026-08-05, verdict: yes~~. At the
pinned v4.30.0, `.lake/package-overrides.json` is applied on every
`lake build`, fully reuses the override target's built oleans in place,
performs zero writes against a fully read-only store (safety + tripwire),
and is concurrency-safe; the generated `lake-manifest.json` keeps the warm
git pins verbatim so no drift warning fires. Landed in stage 2:
`seedOverrides` replaces the hardlink farm, Static rejects a *tracked*
package-overrides file, `LAKE_ARTIFACT_CACHE` stays off everywhere (the
one landmine: a dependency lakefile enabling it would beat the env var —
re-check on any pin bump). Two drafts in parallel now share the store with
no extra machinery.

## From the 2026-08-06 live rehearsal (history/live-rehearsal.md)

- ~~Gate the docker smoke~~ — done 2026-08-06: ci.yml gained a `smoke`
  job running `npm run smoke:submission-validation` on every push, with
  the validate job's cache pattern (shared pins-hashed key, save before
  any container runs) and workflow-lint coverage.
- **Flaky `--resume` e2e under parallel load**: `test/e2e/cli-github.test.ts`
  "reattaches an interrupted submit" intermittently sees
  `waiting for workflow` instead of `validate · Compile` when the full
  suite runs concurrently; passes in isolation. A timing race in the
  fake-Actions poller — fix the test (or the poller's readiness signal),
  found 2026-08-06 by the CI-gate worker.
- ~~Script the rehearsal for collaborators~~ — done 2026-08-06:
  `scripts/rehearsal/` (setup/drive/teardown + README); the workflow
  patch is derived from the current submission.yml at run time by
  patch-workflow.mjs, whose drift assertions run against the real
  workflow on every `npm test`.
- **Confirm org ghcr visibility at go-live.** The capture package was
  auto-created publicly because the personal source repo is public;
  anonymous pull-by-digest verified. If the lax-archive org forces new
  packages private, the first cross-submission capture download fails.
- **Tear down the scratch repos** (`jan3er/lax-scratch-{control,database,
  submission}`, ghcr package `lax-scratch-captures`) and rotate the
  personal token that stood in for the App mints (Jan).

## Port the production database (go-live) — ~~done 2026-08-06~~

All 13 drafts republished with ghcr captures via `scripts/port-db/`; the 3
`init` stubs need nothing. Notes from the run, and its leftovers:

- **Keep `port/chain-requires` in lax-submissions reachable.** lax-11/12
  (commit `7567bb4e`) and lax-3/5/15 (commit `8c4d271`) record source
  commits that exist only on that branch (the sibling-path→git-require
  chain conversion). Deleting the branch strands their sources; merge or
  keep it.
- The six unowned records (lax-9/10/16/17/18/41) were ported via a
  temporary maintainer exception: repo-admin ruleset bypass on
  lax-database + `jan3er` inserted into `owner-list.json` (numeric-id
  sorted!), then both restored. Scripts in the 2026-08-06 session
  scratchpad; owner lists verified restored.
- ghcr org policy initially forced `lax-captures` private (the go-live
  risk above, confirmed) — fixed by allowing public packages org-wide,
  flipping the package, then re-restricting. Anonymous pull verified.
- Driver robustness follow-ups: retry transient `gh` failures during
  polling instead of failing the record (three i/o-timeout casualties
  had to be re-driven); check for our command marker before re-posting
  after a timed-out POST (a duplicate comment raced — CAS rejected it
  correctly, but the driver should not create the race). Also lax-17's
  validate runs ~28 min: the 20-min default timeout is too tight.
- ~~`lax build` cleanup bug~~ — fixed 2026-08-06: the original trigger
  (read-only materialized dependency dirs) disappeared with local
  source-built dependencies, and the CLI's finally now runs
  `removeValidationWorkspace` (chmod +w before rm) so any read-only
  content in the temp job dir is removed regardless (e2e-asserted via a
  private TMPDIR).
- The old `lax-capture-*` GitHub Releases on lax-database are now dead
  store; delete them at leisure. The stale `LAX_VALIDATION_IMAGE` Actions
  variable on lax-archive/lax can be deleted too.

## spec.md reconciliation queue (Jan, manually)

- The "Continuous preview while authoring" subsection an agent inserted into
  this repo's spec.md (see spec-notes, 2026-08-05): bless or strip.
- Auth model: GitHub App user tokens replaced the OAuth device flow the spec
  era assumed (spec-notes, 2026-08-05).
- Submission deletion (carried from old repo): Lifecycle still lists three
  states / five transitions; `lax spec` contradicts the implemented
  tombstone flow.
- Upcoming, once implemented: sibling path requires *removed* (spec still
  needs the old feature folded in or the prohibition recorded instead), and
  multiple statements per concept restored.

## Found by the 2026-08-05 rewrite review

- ~~Shallow-fetch gap carried over verbatim~~ — closed 2026-08-06:
  `source/fetch.ts` now progressively deepens (geometric `--deepen`,
  8192-commit cap, shared fetch deadline) after a refused
  unadvertised-SHA fetch, with fixture-remote tests pinning the found /
  capped / absent cases.
- ~~Memory numbers are unmeasured~~ — measured 2026-08-05 (plan addendum
  point 1): replay is ~5.6 GiB per concurrent mathlib environment
  import; 2 threads (10.78 GiB peak on word-ram) fits a 16 GB swapless
  runner, 4 never does; compile peaked at 3.84 GiB at 4 threads. Caps
  now carry the measured rationale in config.ts.
- **Author frictions, unchanged since hiccups.md and re-filed here**:
  - Apache-2.0-only license gate — salvaged MIT/BSD source has no path;
    decide allowlist vs. loud documentation.
  - `Batteries.*` imports rejected (`IMPORT_PREFIXES` in
    `phases/inspect.ts`); authors must hunt a Mathlib module that
    transitively imports it. Also: the violation message no longer lists
    what *is* importable — restore that.
  - Flat concepts + per-module namespace ownership makes faithful
    multi-module ports impossible (28 modules → one 762 KB module).
- ~~Local compile errors flattened to one line~~ — fixed in stage 2
  (host local mode streams the full transcript; guarded by e2e).
- ~~Lost rationale to re-home~~ — done in stages 2–3: symlink-blind
  leanchecker realpath comment lives in `host/leanenv.ts`, the
  no-`lake update`/`post_update` rationale in `host/warmstore.ts`, the
  `--clearenv` fail-closed lesson at run-check.mjs's LEAN_NUM_THREADS
  gate (asserted by test).

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
  and a README pointing at `lax spec` and the site.
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
  cut it. Re-profile once stage 3 lands (`--profile` exists and works).
- Website-side items now live in `lax-archive/lax-website`: tombstone page
  vs. 404, contributing page wiring, site publication atomicity, search
  index at ~100 submissions, endorsement attestations (v0.3), multi-atom
  source cards (v0.4), and the multiple-statements presentation
  (anonymous per-statement indices) from rewrite.md.

## Old deployment (the box) — stopped 2026-08-06, decommission owed

The box was fully stopped and powered off 2026-08-06: all units disabled
(`lax-deploy.timer`, `lax-ops-backup.timer`, `lax-server.service`, `caddy`)
and the irreplaceable state (db.git + ops.sqlite) exported to
`~/lax-box-final-20260806-153311.tar.gz` on Jan's machine — move that
somewhere durable. Still owed:

- **Delete the server** (`lax-server`, id 154491090) in the Hetzner console —
  a powered-off server still bills.
- Revoke the old Hetzner API token in the console (pasted into a chat
  transcript 2026-07-26; deleting the file did not kill the credential) and
  rotate/retire the S3 credentials for the same reason. The `lax-ops-backup`
  bucket still holds the last `ops.sql`; decide keep-or-delete when the
  final export has a durable home.
- **DNS cutover in progress** (2026-08-06): laxarchive.org set as the
  lax-website Pages custom domain; Cloudflare A/CNAME records to repoint at
  GitHub Pages, then re-enable Enforce HTTPS. Consider verifying the domain
  for the lax-archive org (Settings → Pages → verified domains) against
  domain takeover.

## First npm release from this tree (before tagging v0.1.18)

- ~~Stop the box's auto-deploy first~~ — done 2026-08-06: the box is fully
  stopped and powered off (see the old-deployment section), so its
  latest-following `lax-deploy` timer can no longer install a
  `lax-server`-less package onto the live server.
- **Confirm the npm trusted-publisher registration** for `lax-archive`
  (account `jan3er`) names repository `lax-archive/lax` and workflow
  `release.yml`. The workflow was renamed from `release-cli.yml` back to
  `release.yml` (2026-08-06) so the old repo's registration keeps working —
  if it was ever re-registered against `release-cli.yml`, re-point it.

## Second maintainer onboarding

Carried and adapted: invite the second maintainer to the `lax-archive` org
(decide role, consider org 2FA requirement); npm maintainer access (2FA —
publish rights are the deploy gate); the secrets doctrine is now: App
private keys live only in the two protected Actions environments
(`lax-database-publish`, `lax-website-dispatch`), a maintainer's laptop
holds nothing. Confirm all three GitHub App registrations (CLI, Database
Publisher, Website Dispatcher) are org-owned, not personal. Sweep docs for
"maintainer call" spots that assume one person.

## ORCID-authed comments (design pending)

Comment section on record pages, authed via ORCID OAuth. The old design
homed the data in the server's ops.sqlite — that home no longer exists;
needs a new one (the database repo is public and append-only, so probably
not there). Needs the moderation stance above first.
