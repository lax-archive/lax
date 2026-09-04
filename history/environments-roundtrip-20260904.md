# Archive environments: the first off-epoch round trip (2026-09-04)

Closed record of the day the archive went from one Lean/mathlib version to
several, ending with the first real submission built in an environment
other than the epoch. The plan it closes is `history/environments-plan.md`
(design, stages, admission checklist, risks); the deviations are in
spec-notes.md under 2026-09-04; what stays open is in TODO.md.

## What landed, in order

All of it on 2026-09-04, on `main` of `lax-archive/lax` and
`lax-archive/lax-website`:

- **Stage 0 spike** (`spike/environments/REPORT.md`): GO. The inspector
  compiled unchanged under v4.33.0 with byte-identical output; only the
  proof-tree composer broke (`Environment.addDeclCore` gained a
  `maxRecDepth` argument).
- **Stage 1**: the environment table (`environments.ts`), selection from
  the manifest's `leanVersion`, per-environment provisioning and inspector
  cache key, pins as functions, `lean-facts.ts`.
- **Stage 2**: the static gate writes the environment id and the
  per-environment host cache key; `setup-vm.js --env`; the publisher looks
  the report's environment up in the table before any token is minted. Jan
  waived the rehearsal drill for this release.
- **Stage 3**: the inspector's shape guards, the `inspector-golden`
  fixture, the composer's `Lean.addDecl` port, the `inspector-plan` /
  `inspector-matrix` jobs in `ci.yml`, and `environments.yml` with its
  discover / admit / matrix / install-toolchain scripts.
- **Stage 4**: `lax init --env <id> [--yes]` with the typed confirmation,
  `lax doctor`'s Environments row and `--env`, `lax port`.
- **Stage 5**: the epoch in lax-website's config, the off-epoch notice,
  the environment chip, epoch-first listings, `index.json` and
  `environments.json` at the site root; renderer `30927d2d` re-pinned.
- **The first admission**: `v4.33.0` at mathlib `db584cd6…`, merged from
  the pull request of run 33870950217 as `863afdf` and released in CLI
  0.1.39. Four runs were needed; each of the three failures found one
  thing the job could not see locally (the epoch toolchain missing from
  the job, the composer smoke needing the toolchain on PATH, a `tee`
  without `pipefail` hiding a crashed smoke behind a green step). The
  entry was merged **without `limits`**: see "The measurement" below.

## The round trip

Throwaway submission **lax-851268**, issue
<https://github.com/lax-archive/lax/issues/72>, owner jan3er, source
`https://github.com/jan3er/lax-env-roundtrip-20260904` at `b212ed6`,
folder `.`. Scaffolded with

    lax init env-roundtrip --env v4.33.0 --yes

which printed the environment notice ("v4.30.0 is the archive's epoch,
with 6 registered submissions; v4.33.0 has 0. Only submissions in v4.33.0
can cite this work"), wrote the manifest with `leanVersion: "v4.33.0"`
and the v4.33.0 mathlib commit, and prepared the local v4.33.0 workspace
(already provisioned by `lax doctor --env v4.33.0`; 7.5 GB under
`~/.lax/warm/v4.33.0-db584cd6d46c`). Content: one concept
(`Lax851268.Succ`, `axiom leSucc : ∀ n : ℕ, n ≤ n + 1`, importing
`Mathlib.Order.Basic`) and one proof (`Lax851268Proofs.leSucc` with a
`conclusion:` marker). Two lessons from writing it by hand, both already in
`instructions.md`: a proof theorem is invisible to the inspector until its
docstring carries the `conclusion:` frontmatter (the first local build
reported `1 concept · 0 proofs`), and `lax init` writes `authors: []`,
which is accepted as-is.

`lax build` under v4.33.0: 17 s cold, 4 s warm, green. The CLI ran from
source at 0.1.39 (= `main` 3008e8b); the control plane ran the same commit.

`lax submit` twice, as designed: the first call bound issue 72 into the
manifest and asked for a commit; the second ran

    ✓ Checked your source       jan3er/lax-env-roundtrip-20260904 @ b212ed6
    ✓ Built on your machine
    ✓ Rebuilt in the archive    3m07s
    ✓ Wrote the public record   26s

Run <https://github.com/lax-archive/lax/actions/runs/33875123065>:
precheck 4 s, route 17 s, Validate 3 m 05 s, publish-submit 28 s.

The validate job's own log is the proof that stage 2 selects per
environment:

    lax gate: environment v4.33.0 (leanprover/lean4:v4.33.0, mathlib db584cd6d46c)
    key: lax-validation-host-v2-Linux-v4.33.0-db584cd6d46c-7b30283bf9103d64
    Cache not found for input keys: lax-validation-host-v2-Linux-v4.33.0-…
    lax setup: provisioning environment v4.33.0
    lax setup: installing toolchain leanprover/lean4:v4.33.0

`validation-profile.json`, vm-setup stage 116.4 s: elan 0.7 s, toolchain
9.0 s, warm workspace 102.9 s (peak 7.43 GiB — the cold `lake exe cache
get` plus the LaxWarm build), inspector build 3.8 s (peak 1.70 GiB).
Validate stage 17.7 s: node image pull 2.9 s, compile concepts 3.6 s
(0.41 GiB), compile proofs 2.9 s, replay concepts 2.9 s (0.40 GiB), replay
proofs 3.0 s, inspect 0.6 s each, seal 0.1 s. So a v4.33.0 submission of
this size costs about two minutes of provisioning plus twenty seconds of
validation on a hosted runner.

**Database** (`lax-archive/lax-database` commit `e1d98a8`):
`record.json` a draft with the source above; `build-output.json` with
`leanVersion v4.33.0`, `mathlibVersion db584cd6…`, the concept and the
proof, and `capture.leanToolchain = leanprover/lean4:v4.33.0`,
`capture.mathlibCommit = db584cd6…`, registry blob
`ghcr.io/lax-archive/lax-captures@sha256:9752c554…` — the capture carries
the pins the website and `lax` resolve back to the table row.

**Website** (rebuild 33875482954, live within about four minutes):
`https://laxarchive.org/lax-851268/` showed the notice "Environment
v4.33.0. The archive's epoch is v4.30.0; only submissions in v4.33.0 can
cite this work" and "Lean v4.33.0 · mathlib db584cd6d46c" in the
masthead; the listing grew the `v4.33.0` chip ("v4.33.0, 1 submission");
and `environments.json` went from one row to

    {"epoch":"v4.30.0","environments":[
      {"id":"v4.30.0","registered":6,"drafts":18},
      {"id":"v4.33.0","registered":0,"drafts":1}]}

`lax delete --yes` then retired the id (run 33875978478, 10 s; "No known
live dependents were found"), and the site dropped the row again on the
next rebuild.

## The measurement

The admission run writes the container smoke's heaviest-span peak into the
pull request. Until this day `admit.mjs` also wrote it into the entry's
`limits.memoryBytes`, which `limitsFor` turns into the container's
`--memory` cap — and the smoke's fixtures import a sliver of mathlib, so
the figure (1.15 GiB for v4.33.0) would have refused every real submission
(~5.6 GiB per replay thread at the epoch). The plan's "a human reads the
number before merging" was the only thing that stopped it, and it did:
the entry was merged without `limits`.

Decided the same day: the peak is a **note**, recorded in the pull request
body and never in the table; an entry inherits `DEFAULT_LIMITS`; a
per-environment `limits` is written by hand only after a full-mathlib
replay has been measured in that environment (the way the epoch's defaults
were), typically `leanThreads: 1` once an import no longer fits twice in
16 GB. A workflow-definition test pins that the admit step passes no
limits flag. The plan's checklist bullet was rewritten to say so.

## What the round trip found

- **The validate job cannot save caches, and never could.** Every
  `submission.yml` run since the 2026-08-07 rollout carries the annotation
  `Cache reservation failed: cache write denied: token has no writable
  scopes` on its cache-save steps — the route job's `dist` cache and the
  validate job's lean host cache alike — because an `issue_comment`-run
  job whose only permission is `contents: read` gets a token the cache
  service refuses to write with. It never showed, because `ci.yml` (push
  events, same permissions on paper, but a token the service accepts)
  saves the epoch's host cache on every push to `main` and the validate
  job restores it. The Actions cache API confirms it: the only
  `lax-validation-host-v2` entry is the epoch's, saved from
  `refs/heads/main` at 11:17 Z, 3.28 GB. **Consequence for environments:**
  nothing ever saves an off-epoch cache, so every v4.33.0 submission
  provisions cold — about two minutes today, ten or more once mathlib's
  cache get is slow — rather than the plan's "a lonely environment costs a
  cold ten minutes" once. The fix belongs in `ci.yml`, whose saves work:
  provision and save every admitted environment (the `inspector-matrix`
  job already runs per environment on table changes and weekly). Two
  facts to weigh first: each environment's cache is ~3.3 GB against the
  repository's 10 GB ceiling (three environments fill it, and the
  eviction is LRU), and the alternative — a writable scope on the validate
  job — hands a job that runs submission code a token that can write
  caches other jobs restore.
- **`lax submit` says nothing about the environment.** A clean submit
  collapses to the four rows above; the only place the environment is
  visible is the validate log and the site. That is consistent with the
  paper round trip's finding (findings surface on failure only) and is
  not a defect, just a thing to know when verifying.
- **Provisioning cost at v4.33.0**: the cold warm-workspace step was
  102.9 s on a hosted runner and peaked at 7.43 GiB; the admission run's
  smoke measured about 2 min for the same cold `lake exe cache get`.
  Locally, `lax doctor --env v4.33.0` needed 7.5 GB of disk.

## What stays open

In TODO.md, archive environments: the organization setting that lets the
admission job open its pull request (Jan), the cache-save finding above,
and the epoch-bump runbook's first real use, due in 2027.
