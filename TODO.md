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
2. Runner seam in `pipeline.ts` (host/container/fake) + restore old-lax
   local build (no docker, incremental, streamed output) + fake-mathlib and
   fake-GitHub test seams.
3. Pipeline collapse: one read-only validation job; plain pinned stock
   image instead of the custom Containerfile; toolchain + `lake exe cache
   get` on the VM; Replay/Inspect on the VM (hand-built realpath'd
   LEAN_PATH, never `lake env`); ghcr olean cache keyed
   (repo, folder, commit, proof|concept).
4. Write path: keep CAS + credential-free preflight; one global concurrency
   group; thin YAML (logic in TS, delete the inline-JS failure reporter).
5. Port the old test suite area by area onto the new seams.
6. Independent follow-ups: forbid sibling paths (delete `phases/siblings.ts`
   + arms; add the chain-submit guidance to error messages; later the
   `lax submit A B C` macro), allow multiple statements per concept (drop
   the cardinality violation; website work in lax-website), package-overrides
   spike (below), CLI polish (`--resume` reattach via issue→run derivation,
   resolve the `lax update` name collision with old lax's self-upgrade,
   progressive doctor, no silent waits — stream compile output, message
   before every long operation).

Verify early (cheap, load-bearing): the `queue: max` concurrency semantics
in submission.yml — classic Actions concurrency cancels older *pending* runs,
which would silently drop queued submissions; our tests only string-match the
YAML. The CAS loop is the correctness backstop either way.

**Package-overrides spike** (replaces the hardlink farm; also the
recommended two-drafts-in-parallel workflow): `lax init` writes a gitignored
Lake package-overrides file pointing mathlib at one shared local checkout;
`lax build` rejects a checked-in overrides file. Confirm first that Lake
reuses the override's built `.lake` artifacts (oleans), not just sources,
and how overrides interact with the always-lax-generated `lake-manifest.json`.

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

- **Shallow-fetch gap carried over verbatim**: when a host refuses the
  unadvertised-SHA fetch, `runtime/fetch-source.mjs`'s `git fetch --depth 1
  origin` fallback retrieves only ref tips and misses valid historical
  commits. Restore a fallback that can fetch any commit reachable from a
  remote branch while bounding resource use.
- **Memory numbers are unmeasured**: Compile hardcodes `LEAN_NUM_THREADS=4`
  (`phases/compile.ts`), Replay/Inspect use 2, inside a hard 16 GiB
  container cap with **no swap** (the old box's 32 GiB swap once absorbed a
  17.3 GiB replay overflow — history/oom.md). Measure a big submission
  before trusting the caps; the failure mode at the ceiling is a kill, not
  degradation, so confirm rather than assume.
- **Author frictions, unchanged since hiccups.md and re-filed here**:
  - Apache-2.0-only license gate — salvaged MIT/BSD source has no path;
    decide allowlist vs. loud documentation.
  - `Batteries.*` imports rejected (`IMPORT_PREFIXES` in
    `phases/inspect.ts`); authors must hunt a Mathlib module that
    transitively imports it. Also: the violation message no longer lists
    what *is* importable — restore that.
  - Flat concepts + per-module namespace ownership makes faithful
    multi-module ports impossible (28 modules → one 762 KB module).
- Local compile errors are flattened to one truncated line
  (`pipeline.ts` `safeError`) — fixed for free by the host-runner local
  mode (stage 2), but don't lose it.
- Lost rationale to re-home as comments when the affected code is rewritten
  in stage 3: leanchecker's module scan is symlink-blind (realpath every
  LEAN_PATH entry — old `src/pipeline/leanenv.ts`); why `lake update` never
  runs / mathlib's `post_update` hook must never fire; the `--clearenv`
  lesson (an env var can be set, visible, and still not arrive — keep
  fail-closed consumers).

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
