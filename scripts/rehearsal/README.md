# The live rehearsal drill

A scripted rerun of the rehearsal recorded in `history/live-rehearsal.md`: a
real issue → validation → publish → website-dispatch round trip on three
disposable GitHub repositories, driven by the actual `submission.yml`.

**This is a pre-release drill, not CI.** It creates public repositories, burns
hosted-runner minutes, pushes an OCI artifact to ghcr, and needs a real
personal token. Run it by hand before trusting a change to the Actions side —
`npm run check` cannot see any of what it covers. The 2026-08-06 rehearsal's
first real validation found a production-blocking bug that every unit test
had passed.

## Running it

```sh
npm run build                                     # setup.sh needs dist/
OWNER=jan3er PREFIX=lax-scratch scripts/rehearsal/setup.sh
#   ... place the token as printed ...
OWNER=jan3er PREFIX=lax-scratch scripts/rehearsal/drive.sh
OWNER=jan3er PREFIX=lax-scratch scripts/rehearsal/teardown.sh --yes
```

`setup.sh` refuses to run if any of the three repositories already exists; a
rehearsal must start from nothing, or it inherits database state and issue
numbers from the previous one.

## The three repositories

| repository            | stands in for            | contents                                                                |
| --------------------- | ------------------------ | ----------------------------------------------------------------------- |
| `<prefix>-control`    | `lax-archive/lax`        | this tree, with the patched `submission.yml` (below)                     |
| `<prefix>-database`   | `lax-database` *and* `lax-website` | a README plus a `repository_dispatch` receiver for `lax-db-updated` |
| `<prefix>-submission` | an author's repository   | a scaffolded `lax-1` even-squares submission                             |

Captures land in `ghcr.io/<owner>/<prefix>-captures`, created by the first
push from the workflow's own `GITHUB_TOKEN`.

The receiver workflow in the database repo is the one deliberate departure
from production, which keeps `lax-database` free of workflow files entirely.
Keep the receiver triggered by `repository_dispatch` only: pushes of the
`lax-publish/<sha>` staging refs are processed by the database repo too, and
in the first rehearsal an *invalid* receiver turned every one of them into a
phantom failed run. Plain YAML scalars there must not contain `: ` — that
exact mistake is what made it invalid.

## The patch is derived at run time

There is no checked-in fork of `submission.yml`. `setup.sh` calls
`patch-workflow.mjs`, which reads the live
`.github/workflows/submission.yml` and applies three deviations:

- **(a)** a workflow-level `env:` block pointing `LAX_CONTROL_REPOSITORY`,
  `LAX_DATABASE_REPOSITORY`, `LAX_WEBSITE_REPOSITORY`, and
  `LAX_CAPTURES_REPOSITORY` at the scratch repositories;
- **(b)** every `actions/create-github-app-token` mint step deleted, and each
  consuming token env switched to `${{ secrets.LAX_SCRATCH_TOKEN }}` (the
  merged publishing jobs read two of them each);
- **(c)** `ci.yml` and `release.yml` dropped from the pushed tree.

Everything else is byte-identical, and the generated file carries a header
saying so. The script asserts every structure it depends on — the number of
mint steps, their step ids, a consumer for each, the parsed `env:` block, the
absence of the App-key references afterwards, and that no job reads the token
outside a protected environment. If `submission.yml` drifts, the script fails
loudly instead of shipping a stale patch. `test/workflows/rehearsal-patch.test.ts`
runs it against the real workflow on every `npm test`, so drift breaks the
build rather than the drill.

## The credential step

`setup.sh` never places a token. It prints the command and stops:

```sh
gh secret set LAX_SCRATCH_TOKEN --repo <owner>/<prefix>-control --env lax-database-publish
```

Use a short-lived personal token that can write contents to, and dispatch to,
the scratch database repository — nothing more. It belongs in that environment
scope and nowhere else: that placement is what mirrors the production posture,
where both App keys exist only inside `lax-database-publish`. Rotate it at
teardown; a deleted environment does not revoke a token.

## Expected evidence

`drive.sh` asserts the per-job conclusions below and exits nonzero on any
miss. The narrative evidence — comment markers, database contents, wall times
— is in `history/live-rehearsal.md` "What ran"; check it by eye on the run
pages the script prints.

1. **Issue opened → stub publication.** `route` and `publish` succeed. Three
   stub files appear in the database repo by compare-and-swap, the staging ref
   is cleaned up, the preview and result comments carry their correlation
   markers, and the dispatch — sent by the `publish` job itself — reaches the
   receiver. ≈ 1 min.
2. **`/lax submit` → validation and publication.** `route`, `Validate`, and
   `publish-submit` succeed. The trusted publisher re-validates the artifacts
   credential-free, pushes the capture to ghcr, advances the database,
   synchronizes the issue title, and dispatches the rebuild. ≈ 5 min
   author-visible; the cold run also provisions elan, the toolchain, and
   mathlib, and saves the Actions cache before untrusted code runs.
   The script also reads the job logs for the per-environment plumbing
   (history/environments-plan.md stage 2), with the environment taken from the
   submitted manifest's `leanVersion`: the static gate's `lax gate:
   environment <id>` line, the cache restore step naming a
   `lax-validation-host-v2-Linux-<id>-…` key (hit or miss), setup-vm's
   `lax setup: provisioning environment <id>` and `… ensuring the warm
   mathlib workspace for <id>` lines, and the publisher's `lax publish:
   environment <id>` line in `publish-submit`.
3. **`/lax register`.** `route` and `publish` succeed; the record flips to
   `registered`.
4. **Negative probe.** A second `/lax submit` after registration must be
   rejected: the `route` job fails, no `Validate`/`publish`/`publish-submit`
   job succeeds, no database commit is made, and a comment saying
   `lax-1 is registered and cannot be changed` appears on the issue.

Two things worth confirming by eye at go-live, from the rehearsal's lessons:
that the first ghcr package is born publicly pullable (an org that forces new
packages private breaks anonymous capture download), and that the docker smoke
(`npm run smoke:submission-validation`) has been run — it is the only thing
that covers the container-only seam, and it is not part of any gate.
