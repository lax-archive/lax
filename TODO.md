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
   an env-poisoning canary proving prepare-update never touches the
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

- **Gate the docker smoke.** The rehearsal's container bug was invisible
  to `npm run check` (the host build never runs `installOwnConceptCapture`)
  and the smoke that catches it is not part of any gate. Decide: a CI job
  with docker for `npm run smoke:submission-validation`, or a release
  checklist that requires the smoke before any pin/capture/pipeline change
  ships.
- **Script the rehearsal for collaborators.** Keep the scratch repos
  disposable but turn the procedure into `scripts/rehearsal/`: a setup
  script parameterized by owner/prefix that creates the repos, derives the
  token/env patch mechanically from the *current* submission.yml (never a
  stale fork), sets vars + environments, scaffolds and pushes the
  submission; plus a short doc naming the manual credential step and the
  three round trips with expected evidence. A pre-release drill, not CI.
- **Confirm org ghcr visibility at go-live.** The capture package was
  auto-created publicly because the personal source repo is public;
  anonymous pull-by-digest verified. If the lax-archive org forces new
  packages private, the first cross-submission capture download fails.
- **Tear down the scratch repos** (`jan3er/lax-scratch-{control,database,
  submission}`, ghcr package `lax-scratch-captures`) and rotate the
  personal token that stood in for the App mints (Jan).

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

- **Shallow-fetch gap carried over verbatim** (still open; the fetch now
  lives host-side in `source/fetch.ts` since stage 3): when a host
  refuses the unadvertised-SHA fetch, the `git fetch --depth 1 origin`
  fallback retrieves only ref tips and misses valid historical commits.
  Restore a fallback that can fetch any commit reachable from a remote
  branch while bounding resource use.
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
- **Stale `.lake/packages/<LaxN>` clones** linger in author trees after a
  repo switches from git pins to path edges (~170 MB each); nothing collects
  them. Candidate: `lax build` collects packages absent from the manifest it
  just wrote, or `lax doctor` gains a fix. (Interacts with the
  package-overrides spike.)
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

## Old deployment (the box) — owed until decommission

The live box (laxarchive.org) still runs the old-repo server and is retired
only when this tree goes live. Until then, still owed (from the old TODO):
revoke the old Hetzner API token in the console (pasted into a chat
transcript 2026-07-26; deleting the file did not kill the credential),
rotate the S3 credentials for the same reason, and confirm bucket versioning
+ a lifecycle rule on `lax-ops-backup` (the nightly backup writes one stable
key — without versioning every night overwrites the only copy). Plan the
decommission itself (DNS, redirects, data export) as part of go-live.

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
