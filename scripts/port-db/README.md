# The database port driver

Re-validate every existing `lax-database` record through the issue control
plane, bottom-up in dependency order.

**This is a one-shot maintainer migration, not CI.** It comments on real
issues, burns hosted-runner minutes for a full validation per record, and
pushes a capture to ghcr for each one. Run `--dry-run` first, then `--only` one
record as a canary, and only then the full run.

## Why a port is needed at all

The 16 records in production were validated by the pre-rework pipeline. Their
`build-output.json` carries a Releases-based capture (a `downloadUrl` field and
no `registryBlob`); the reworked pipeline publishes captures as
digest-addressed OCI artifacts on ghcr, and `archive/snapshot.ts` refuses to
read the old shape at all — `capture()` returns `undefined` unless
`registryBlob` is present. So every record that depends on an unported record
fails Resolution with "no immutable published artifact capture".

Hence: **dependencies before dependents, always.**

Porting is not a data migration. It is one `/lax update` comment carrying the
record's *own* recorded source triple, posted on its own issue. The workflow
re-fetches the source, re-runs the whole pipeline, pushes a fresh capture, and
commits the new `build-output.json` through the trusted publisher. The driver
never writes to `lax-database`, never holds an App key, and never mints a
token: it posts comments and reads runs with the maintainer's own `gh` login.

## Running it

```sh
node scripts/port-db/port.mjs --dry-run          # print the plan; touches nothing
node scripts/port-db/port.mjs --only lax-13      # the canary: one leaf record
node scripts/port-db/port.mjs                    # the full run, in order
node scripts/port-db/port.mjs --start-after lax-12   # resume a partial run
```

| flag                    | effect                                                        |
| ----------------------- | ------------------------------------------------------------- |
| `--dry-run`             | print the plan (order, id, state, source triple, skips) and exit |
| `--only lax-N`          | port exactly one record                                        |
| `--start-after lax-N`   | resume the plan after this record                              |
| `--continue-on-failure` | keep going past a failure (default: abort)                     |
| `--ignore-ownership`    | post even where the viewer is not a record owner               |
| `--timeout-minutes N`   | per-record timeout (default 20)                                |
| `--poll-seconds N`      | polling interval (default 20)                                  |
| `--reports-dir DIR`     | where the report lands (default `./reports`, gitignored)        |

The default is to **abort on the first failure**: a failed record leaves its
dependents with no ghcr capture, so continuing would just manufacture a second
kind of failure on top of the first. `--continue-on-failure` is for the case
where the failures are known to be independent.

Repositories come from `LAX_DATABASE_REPOSITORY` and `LAX_CONTROL_REPOSITORY` —
the same env names `src/shared/constants.ts` reads, with the same production
defaults — so the driver can be pointed at a rehearsal's scratch repositories
(`scripts/rehearsal/`) without a code change.

## The order

`planOrder` in `plan.mjs` reads the forward edges out of each record's
`build-output.json`. Despite their names, `requiredByConcepts` and
`requiredByProofs` are the packages *that record* requires —
`phases/resolution.ts` recurses into them exactly that way — and
`submissionIdForPackage` maps `Lax13Proofs` to `lax-13`. Records are then
sorted by `(depth, numeric id)`, where depth is the longest path to a record
with no in-scope dependency. That is a valid topological order, it is identical
on every run, and it groups the plan so that everything at depth 0 can go
first. A cycle is a hard error: the archive cannot contain one, so finding one
means the data is corrupt.

Skipped, never ported:

- **`init`** records are stubs with no source triple — there is nothing to
  re-validate.
- **`registered`** records are immutable; `/lax update` on one is rejected by
  the route job. They are printed with a `!!` so they cannot be missed.
- **`deleted`** ids are retired.

A dependency that is itself unportable is reported against its dependents
rather than silently dropped — that dependent will never resolve.

## Ownership

Only an owner of a record may post `/lax update` on it (`ControlPlane.route`
checks the record's `owner-list.json`). The driver refuses to start when the
authenticated user does not own something in scope, naming the records, rather
than posting comments that the route job will reject. `--ignore-ownership`
overrides that.

As of 2026-08-06, `jan3er` is not an owner of `lax-9`, `lax-10`, `lax-16`,
`lax-17`, `lax-18`, or `lax-41`; those six need either an owner to run the
driver or an owner-list change first.

## Correlation and the verdict

Per record the driver posts the `/lax update` comment, then polls. It
correlates on the hidden markers of `src/shared/workflow-comments.ts`, exactly
as the CLI's follow logic does: the route job annotates our own comment with
`<!-- lax-workflow-run-id:… -->`, and the terminal comment carries
`<!-- lax-result-comment-id:<our comment id> -->`. A marker only counts when
the Actions bot wrote it or when it is on our own comment — anyone who can
comment on the issue can paste a marker.

The **verdict** is the correlated run's own conclusion, plus a direct check
that the committed `build-output.json` now carries a `registryBlob`: a green
run that somehow left the record without a ghcr capture has not ported it. A
heartbeat line prints on every poll (elapsed time, run status, current job and
step) so a 20-minute validation is never a silent wait.

## The report

After each success the driver downloads the run's `submission-validation-<n>`
artifact and reads `validation-profile.json` (the span tree of
`src/shared/profile.ts`, one entry per stage: `vm-setup`, then `validate`) for
the per-phase times, and any peak-memory field either that or
`validation-report.json` happens to carry. That field is optional and its
absence is normal, never an error.

The summary — id, prior state, result, wall clock, heaviest phase, peak memory,
new capture digest — is printed and written as both JSON and markdown into
`reports/port-db-<timestamp>.{json,md}` (the path is printed; `reports/` is
gitignored, since this is operational output and not archive data).

## Tests

`test/unit/port-db-plan.test.ts` covers `plan.mjs` with no network: the
topological order and its determinism, cycle detection, the skip rules, the
report formatting, and — as drift guards against the real implementations, not
copies of them — that the emitted `/lax update` body parses back through
`parseCommand` into exactly the recorded triple, and that the markers and the
bot identity match `src/shared`.
