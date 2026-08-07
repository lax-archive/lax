# TODO

Open work items, roughly in order. History lives in `history/` and git —
the rework execution record is `history/rework-execution.md`, the go-live
record (database port, cutover, HTTPS, first releases, round trip) is
`history/go-live.md`. Current state lives in README.md; proposed spec
amendments in spec-notes.md; the rework charter in rewrite.md +
rewrite-plan.md (fully executed).

## Pipeline simplification: rolled out 2026-08-07, two things left

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
permission the report download needs. Left:

- **Delete the superseded `Lax Website Dispatcher` private key** in the App
  settings (UI only). It was replaced, not revoked, and the environment that
  held it is gone.
- **Merge or keep `roundtrip-20260807` in lax-submissions** — see the
  round-trip-sources item below. Seven records now name commits that exist
  only on that branch.

## Go-live leftovers (context: history/go-live.md)

- **Keep round-trip sources reachable in lax-submissions**: branch
  `roundtrip-20260807` now carries the recorded source of all seven
  chain submissions — lax-13/lax-14 at `d35ba57`, lax-11/lax-12 at
  `becb578`, lax-3/lax-5/lax-15 at `4af91ea` — after the 2026-08-07
  production sweep re-pinned the chain bottom-up. It supersedes
  `roundtrip-20260806` (lax-14's old `42a14ff9`) and `port/chain-requires`,
  whose commits no record names any more. Merge `roundtrip-20260807` into
  `main` or keep the branch; deleting it strands every recorded source.
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

## spec.md reconciliation queue (Jan, manually)

- The "Continuous preview while authoring" subsection an agent inserted into
  this repo's spec.md (see spec-notes, 2026-08-05): bless or strip.
- Auth model: GitHub App user tokens replaced the OAuth device flow the spec
  era assumed (spec-notes, 2026-08-05).
- Submission deletion (carried from old repo): Lifecycle still lists three
  states / five transitions; `lax spec` contradicts the implemented
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
