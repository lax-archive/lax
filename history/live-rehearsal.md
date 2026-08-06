# The stages-3+4 live rehearsal (2026-08-06)

Closed record of the live rehearsal owed by rewrite-plan.md's red-team
addendum point 3: a real issue → validation → publish → website-dispatch
round trip on scratch repositories, run before trusting the Actions side.
The addendum's warning — "everything written but never run was broken"
(history/front-worker-split.md) — held: the very first real validation
found a production-blocking bug.

## Setup

Three disposable public repos under the maintainer's personal account:

- `jan3er/lax-scratch-control` — this tree plus one rehearsal commit whose
  exact deviations are documented in its workflow header: workflow-level
  env pointing the repository constants at the scratch repos, the three
  `create-github-app-token` steps replaced by an environment-scoped
  personal-token secret (`LAX_SCRATCH_TOKEN`, present only in the two
  protected environments, mirroring the production posture), and
  ci.yml/release-cli.yml dropped. Everything else byte-identical.
- `jan3er/lax-scratch-database` — root commit plus a small
  `repository_dispatch` receiver workflow standing in for lax-website, so
  the `lax-db-updated` dispatch is visibly received.
- `jan3er/lax-scratch-submission` — a real `lax-1` even-squares
  submission created with the production scaffolder; it passed the local
  host build before submission.

## What ran

1. **Issue open → stub publication**: route validated the event, the
   publish job created the three stub files in the database repo
   (compare-and-swap advance, staging ref cleaned up), the preview and
   result comments carried their correlation markers, and the website
   dispatch was accepted. Wall time ≈ 1 min.
2. **`/lax update` #1 → validation failure (the find)**: the container
   pipeline failed in compile-proofs — every concept module "permission
   denied" on its read-only trace. `installOwnConceptCapture` installed
   only the capture's `lib` tree into the freshly provisioned proofs
   workspace; lake v4.30 judges a path dependency's freshness from the
   full recorded output set including the C artifacts under `build/ir`
   (the rationale already written in captures/seal.ts, and exactly what
   captures/materialize.ts does for cross-submission captures), so the
   missing `ir` marked everything stale and the rebuild died against the
   deliberately read-only capture files. The failure path itself behaved:
   validation-result posted the structured violation, nothing was
   published. Fixed with a unit test in commit `ca6db0f`; the docker
   smoke reproduced the failure before the fix and passed after it.
3. **`/lax update` #2 → full success**: validate green on the hosted
   runner (197 s with the actions-cache warm store restored; the cold run
   before it provisioned elan + toolchain + mathlib and saved the cache
   before untrusted code ran, in ≈ 170 s of job time), publish-update
   re-validated the artifacts credential-free, pushed the capture to
   `ghcr.io/jan3er/lax-scratch-captures` with the job's own GITHUB_TOKEN,
   advanced the database by CAS, synchronized the issue title, and the
   website dispatch reached the receiver. Author-visible round trip
   ≈ 5 min.
4. **`/lax register`**: publish flipped the record to `registered`,
   website dispatch received.
5. **Negative probe**: a post-registration `/lax update` was rejected —
   "lax-1 is registered and cannot be changed", no database commit, and
   the fallback failure reporter correctly stayed silent behind the
   route job's marker-carrying rejection comment.

## Lessons

- **The docker smoke catches the container-only seam, but only when it
  runs.** The `ir` bug was invisible to `npm run check` (the host build
  compiles in place and never runs `installOwnConceptCapture`) and would
  have been caught by `npm run smoke:submission-validation` at any time
  after the capture-companions change landed — but the smoke is not part
  of any gate. Follow-up filed in TODO.md.
- **First ghcr push with GITHUB_TOKEN worked end to end**: the package
  was auto-created, linked to the workflow repository, and — because the
  source repo is public — born publicly pullable; the anonymous
  pull-by-digest a consumer performs was verified against the recorded
  digest. At go-live confirm the lax-archive org does not force new
  packages private, or the first cross-submission dependency will fail
  its anonymous capture download.
- **Keep lax-database free of workflow files.** Pushes of the
  `lax-publish/<sha>` staging refs trigger workflow processing in the
  database repo; while the receiver workflow file was briefly invalid,
  every such push produced a phantom failed run. Production lax-database
  carries no workflows, which is the right call — nothing there should
  ever run CI.
- Actions-cache timing on hosted runners was a non-issue: cold provision
  fit comfortably in one job and the save-before-untrusted-code ordering
  behaved as designed.

The scratch repos were left standing for inspection and should be deleted
(and the personal token rotated) once reviewed; the rehearsal commit on
the scratch control repo is not meant to merge anywhere.
