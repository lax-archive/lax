# The maintainer driver

`npm run admin -- <command> …` is how a maintainer operates the archive
from their own machine. It is the per-record successor of
`scripts/port-db/` and works the same way: it **holds no power of its
own**. Every change it asks for is a `/lax admin <verb>` comment on the
submission's own issue, which the trusted workflow
(`.github/workflows/submission.yml`) routes, gates against
`ADMIN_GITHUB_IDS` (`src/shared/constants.ts`), validates, and publishes
exactly as it does an author's command. So:

- this machine holds no App key and never writes `lax-database`;
- every mutation passes the schema checks, the compare-and-swap ref
  update, and the Website dispatch, like any other;
- the issue thread is the public audit log, and the database commit says
  `admin <verb> <id> by <handle> (<numeric id>)`.

The token is the maintainer's own `gh auth token` (or `LAX_ADMIN_TOKEN`).
A non-maintainer's comments are refused by the route job before anything
runs; the driver says so up front rather than after a round trip.

## Commands

```sh
npm run admin -- status                      # every record: state, capture, paper, edges
npm run admin -- status lax-48 lax-65        # just these
npm run admin -- revalidate lax-48           # rebuild from the recorded source, republish
npm run admin -- revalidate --all --papers   # every paper-bearing record, dependencies first
npm run admin -- delete lax-50               # tombstone in any state (typed confirmation)
npm run admin -- reset-draft lax-50          # registered -> draft (typed confirmation)
npm run admin -- owners lax-50 alice bob     # replace the owner list outright
npm run admin -- rebuild-website             # repository_dispatch to lax-website, no db change
```

Options: `--dry-run` prints the comment bodies and posts nothing; `--yes`
skips the typed confirmation; `--continue` keeps a multi-record
revalidation going past a failure; `--verbose` shows the run URL and the
archive's own comments. `LAX_CONTROL_REPOSITORY` and
`LAX_DATABASE_REPOSITORY` point it at scratch repositories for a rehearsal
(`scripts/rehearsal/`).

## What each verb does in the archive

**revalidate** — the whole validation pipeline runs again against the
record's *recorded* source (the comment carries no source; the route job
reads it from `record.json`), the capture and paper layers are pushed to
ghcr afresh, and `build-output.json` is rewritten. The state does not
change: a registered record stays registered. This is how a registered
record picks up a pipeline fix — a paper whose web view was derived before
a ReflowTeX change, say — without a superseding submission. The
supersedes claim must come out identical (same commit, same manifest).
The driver follows the run like `lax submit` does and prints the findings
if validation fails; the record is untouched in that case.

**delete** — the ordinary tombstone, admitted in any state. On a
registered record this is the takedown power and it strands every
dependent, which the preview lists. Put the rationale in a comment on the
issue, not in the record.

**reset-draft** — the inverse of registration; the record keeps its source
and build output. Refused while a *registered* successor claims the record
(the supersedes chain would lose its ordering proof).

**owners** — replaces the list; the commenter need not be on it. Handles
are resolved to numeric ids here, and again by the route job.

**rebuild-website** — the one action that is not a comment: a
`repository_dispatch` of `lax-db-updated` sent with the maintainer's own
token, which already has write access to lax-website. Nothing in the
publish environment runs.

Not built (TODO.md): `undelete`, `verify`, `gc-captures`.

## Ordering several revalidations

`revalidate` with several ids, or `--all`, runs them one at a time,
dependencies before dependents (`plan.ts`, `revalidationOrder`), for the
reason `scripts/port-db/README.md` records: a dependent must see its
dependency's fresh capture. A dependency outside the scope keeps whatever
capture it has. The driver stops at the first failure unless `--continue`
is given, and prints a per-record table at the end.

## Tests

`test/unit/admin-plan.test.ts` covers the pure half (`plan.ts`: record
reading, ordering, command bodies). The control-plane grammar and gates
are in `test/unit/commands.test.ts` and `test/workflows/control-plane.test.ts`;
the publishers' credential-free re-checks in
`test/workflows/publisher.test.ts` and `test/workflows/submit-publisher.test.ts`.
