# Pipeline-simplification rollout, 2026-08-07

The closed record of taking the collapsed submission DAG live: the repo
settings, the merge, the 0.1.21 release, and the production sweep that stood
in for the rehearsal drill. What shipped is described in README.md and the
2026-08-07 spec-notes entry; this file is what the rollout cost and taught.

## The settings, and the order they had to happen in

Both publisher App keys now live in one environment, so the Website App's id
and key had to reach `lax-database-publish` before the merged workflow could
mint a dispatch token.

- **A secret cannot be moved between environments.** GitHub shows a private
  key exactly once, at generation. `LAX_WEBSITE_APP_PRIVATE_KEY` existed only
  inside `lax-website-dispatch` and could not be read back, so the rollout
  generated a *new* key on the `lax-website-dispatcher` App and placed that.
  The superseded key stays valid until deleted in the App UI — replacement is
  not revocation.
- **The "protected branches" deployment policy was vacuous.** Both
  environments were set to deploy only from protected branches, and
  `lax-archive/lax` has neither a branch protection rule nor a ruleset. With
  no branch protected, GitHub permits every branch — so the environment
  holding both App keys was reachable from any ref. Replaced with a custom
  policy naming `main`, which is the only ref issue-triggered runs use
  anyway.
- The merge was pushed before the Website credentials were in place. Nothing
  broke, because no submission arrived in that window — but the window was
  real, and the ordering (settings first, merge second) is not optional.
- `lax-website-dispatch` was deleted after the release, and `Actions: read`
  added to `lax-cli-publisher`, which the CLI needs to download the report
  artifact. All three App registrations were confirmed org-owned.

## The drill was skipped, so production was the drill

`scripts/rehearsal/` never ran: workflows go live on push, and the merge
landed first, which left nothing for the drill to gate. Instead the whole
flagship chain in `~/git/lax-submissions` was resubmitted through the live
system on branch `roundtrip-20260807`, bottom-up.

**Every resubmission invalidates its dependents' pins.** Resolution requires
a cross-submission require's `rev` to equal the dependency record's *current*
source commit (`phases/resolution.ts`), so moving lax-14 immediately made
lax-12 and lax-5 unsubmittable until re-pinned. The sweep therefore ran as
three waves, each wave's re-pin commit becoming the next wave's pinned rev:

| wave | records | source commit | wall |
| --- | --- | --- | --- |
| 1 | lax-14 (full local path), lax-13 | `d35ba57` | 2 min, 11 min |
| 2 | lax-11, lax-12 (parallel) | `becb578` | 4 min, 5 min |
| 3 | lax-15, lax-3, lax-5 (parallel) | `4af91ea` | 5 min, 21 min, 4 min |

All seven published, each with its Website dispatch accepted, and
laxarchive.org served lax-14's new commit. What the sweep exercised that no
test does:

- **Concurrent publishes are fine.** Two and then three publish jobs raced
  for the same `lax-database` ref; every compare-and-swap landed, no retry
  surfaced to the author.
- **`--force` works as documented** — six of the seven skipped every local
  check and the workflow was the only verdict.
- **`--resume` earned its place.** lax-11's CLI lost its connection during
  publish (`fetch failed`) while the run continued and published normally;
  `lax submit --resume` re-derived the run from the issue and reported the
  true outcome. The failure mode the flag exists for happened on its first
  production day.
- **The fail-early static gate is fast.** lax-2, which still carries the
  forbidden sibling `path` require, was refused locally in seconds with the
  chain-workflow instructions inline — no provisioning, no container.
- The report artifact carried findings to the author on every run
  (`proof-dependency`, `draft-dependency` warnings).

## The failure path, on purpose

The sweep produced no failing validation, so one was staged: lax-14's
headline proof `Lax14Proofs.Ramsey.exists_clique_or_indepSet` with its body
replaced by `sorry`, submitted from a throwaway branch. A `sorry` compiles
and replays, so the break had to travel the whole pipeline to be judged,
which is exactly the path worth testing. Inspect produced two findings —
`[axiom-hygiene] depends on inadmissible axiom sorryAx` and `[proof]
declared assumptions do not match the inspected assumption set` (the sorry
also dropped the recorded assumption edge) — and everything downstream did
what it should:

- `Validate` failed; `publish-submit` and `publish` were skipped.
- `report-validation-failure` posted the short comment: the *first* finding,
  the correlation markers, the outcome marker, and a pointer to the run's
  artifacts. That is the whole comment — the complete findings live in the
  artifact, which is the change 0.1.21 shipped.
- `lax submit` rendered both findings in full from the artifact and exited
  nonzero with `validation failed; lax-database was not changed`.
- **lax-14's record never moved** — still `d35ba57`, its content untouched.

The probe branch was deleted afterwards; no record ever named its commit.
