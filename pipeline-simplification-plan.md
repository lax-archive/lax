# Build reporting & job pipeline simplification plan

Status: stages 1–4 implemented on branch `pipeline-simplification`,
`npm run check`-green; pending the live-rehearsal drill, Jan's manual repo
and App settings, and the merge (go-live checklist in TODO.md). The plan
text below stands as the record of what was decided by Jan on 2026-08-07.

## Goals

1. **One report channel.** Today a validation report travels JSON →
   artifact → download on another runner → markdown issue comment → CLI
   comment parser → terminal. The artifact becomes the single data
   channel; issue comments shrink to short outcome records; the CLI reads
   the report artifact directly.
2. **Fail early.** spec.md orders the pipeline Static → Resolution →
   Provision → Compile, but the workflow (and `prepareValidation`)
   provision the expensive host — multi-GB cache restore, docker pull, on
   cache miss a full warm-mathlib build — before a single millisecond-level
   static check runs. Reorder so static/resolution failures skip all of it.
3. **Fewer jobs.** Collapse the 8-job DAG to a 3-hop success path without
   moving the load-bearing trust boundary (the credential-free validate
   job).

## Decisions (Jan, 2026-08-07)

- Failure comments carry a **short outcome + run link** (plus at most a
  one-line first finding). Full findings/transcripts live only in the
  artifact and expire with it. Accepted: failed-build transcripts are not
  permanent records.
- The fail-early static gate runs **on the host, before cache
  restore/provision/save**. Accepted: untrusted submission bytes are
  *fetched and parsed* (git + in-process node, never executed) on the
  runner before the lean-cache save; execution still happens only in
  containers, after the save, and the cached paths (`~/.elan`, `~/.lax`)
  are disjoint from the job dir. The poisoning-stance comment in
  submission.yml must be rewritten to state this revised invariant.
- CLI reads the artifact as a **hard requirement** — no comment-parsing
  fallback for validation detail. On 403 the CLI errors with a message
  naming the missing Actions-read permission and suggesting `lax login`.
- Job consolidations, all four approved: drop `precheck`, drop
  `validation-result`, **merge `website` into the publish jobs** (accepted
  tradeoff: the lax-database and lax-website App keys coexist in one job),
  and cache `dist/`+`node_modules` across jobs.

## A. Fail-early validate pipeline

**Pipeline reorder** (`src/submission-validation/pipeline.ts`,
`prepareValidation`): run fetch (source + archive snapshot) → static
validation → resolution **before** `runner.verifyRuntime()`. This matches
spec.md's phase order and gives local `lax build` the same early failure
for free (no docker pull for a manifest typo). The existing
collect-then-abort semantics per phase are unchanged.

**Gate entry point**: a new mode of the validation runner (e.g.
`node dist/submission-validation/run.js --gate`) that executes only
fetch → static → resolution:

- On violation: write `validation-report.json` (ok=false) to
  `LAX_VALIDATION_OUTPUT` and exit 2.
- On pass: exit 0 and write nothing that the full run wouldn't overwrite.
- The full run afterwards re-executes fetch/static/resolution from scratch
  — the fetch is by pinned commit (deterministic) and the phases are
  milliseconds, so no state is threaded between the two invocations. No
  staged-resume machinery returns.

**Validate job step order** becomes:

1. setup (see E: shared setup action)
2. **static gate** — fails the job in ~seconds on static/resolution errors,
   before any cache traffic
3. restore lean cache (`~/.elan`, `~/.lax/warm`, `~/.lax/tools`)
4. provision host (`setup-vm.js`)
5. save lean cache (cache-miss only — still strictly before any submission
   code *executes*; the gate only parsed)
6. full validation (`run.js`)
7. upload artifact — `if: always()`, stays last; a gate failure skips 3–6
   and still uploads the report

Bump artifact `retention-days` to 90 (the max): with comments no longer
carrying detail, the artifact is the only diagnosable record.

## B. Job graph consolidation

New DAG (success path: route → validate → publish-submit):

- **route** — absorbs precheck as a job-level condition:
  `if: github.event_name == 'issues' || startsWith(github.event.comment.body, '/lax')`
  (for `issues` events the comment path evaluates to empty string → false;
  this is data-only expression evaluation, no `run:` interpolation).
  Role otherwise unchanged; it is the job that saves the dist cache (E).
- **validate** — reordered steps per A; still `contents: read` only, still
  no issue write, artifact remains its only egress.
- **publish-submit** — `needs: [route, validate]`,
  `if: needs.route.outputs.operation == 'validate' && needs.validate.result == 'success'`
  (replaces the `validation-result` bridge). Absorbs the website job: after
  prepare-submit → mint database token → publish, the same job mints the
  lax-website token, dispatches the rebuild, and posts the final result
  comment (today's `website` handler logic runs in-process after
  publication instead of as a separate job). `title_sync_error` and
  `archive_commit` stop being job outputs.
- **publish** — same absorption for the non-submit branch (delete /
  register / owners / init): publish → website dispatch → final comment,
  one job.
- **report-validation-failure** — new, replaces validation-result's failure
  branch: `needs: [route, validate]`,
  `if: always() && operation == 'validate' && needs.validate.result == 'failure'`.
  Downloads the (small) report artifact with `continue-on-error` (it may
  not exist if validate died before the gate), and posts the short failure
  comment: violations wording when the report parses with ok=false
  (include the first violation's `[phase/rule]` first line), otherwise the
  existing "no trustworthy report" infra wording. Outcome marker: failure.
- **report-workflow-failure** — kept as the last-resort catcher; `needs`
  and conditions updated to the surviving jobs (route, publish,
  publish-submit, report-validation-failure). It must not double-post on a
  validate failure (that is report-validation-failure's case).

**Environments/keys**: merging website into the publish jobs requires both
App keys in one environment. Consolidate to a single publish environment
(either add the lax-website key to `lax-database-publish`, or create one
`lax-publish` environment and retire both old ones — implementer's choice,
recorded in the workflow comments; the repo-settings change itself is
Jan's manual op, see the checklist). The workflow comment documenting
credential separation must be rewritten: the surviving invariant is that
*no job holding any App key ever checks out or executes submission code*
(trust rule 1), not that the two publisher keys are isolated from each
other.

## C. Comments become short outcome records

- Validation failure (from report-validation-failure): a one-paragraph
  comment — outcome, submission id, "lax-database was not changed", first
  finding line, run link, markers. No `findingsMarkdown`, no transcripts.
- Infra failure and publication failure comments: keep today's (already
  short) wording.
- Success comments (`successComment`, previews, init): unchanged.
- Remove the comment-side rendering machinery that this orphans
  (`validationProblems`/`validationWarnings` in
  `src/workflows/submission.ts`, and whatever in
  `src/shared/comment-format.ts` loses its last caller — `safeInline`
  and the sanitizers stay for the remaining comments and for terminal
  output).
- The hidden marker protocol (`workflow-comments.ts`) is unchanged:
  result/outcome/run markers still gate CLI exit codes and dedupe, and
  released CLIs (≤0.1.20) keep working against short comments — they show
  less detail but still get the run link and the correct exit code. That
  is the accepted skew story; no flag day.

## D. CLI consumes the artifact

New module (e.g. `src/cli/run-artifacts.ts`):

- `GET /repos/lax-archive/lax/actions/runs/{run_id}/artifacts`, match name
  `submission-validation-<issue>`, then `GET .../artifacts/{id}/zip`
  (follow the redirect) with the user's `ghu_` token.
- Unzip with **fflate** (new runtime dependency — tiny, zero-dep; nothing
  in the tree reads zips today) and parse `validation-report.json`:
  bounded size, schema-checked, and every string sanitized with the
  existing terminal sanitizers before printing — the report is authored by
  the credential-free job and is display-only input, exactly the trust
  level the old comment text had.
- Retry the list/download briefly to cover upload latency after the job
  concludes.

`follow.ts` changes for the submit path only (init/delete/register/owners
keep the pure comment flow — they never had validation output):

- The loop already polls run jobs for progress. When the Validate job
  concludes: fetch the artifact, render the report's findings with the
  same formatter `lax build` uses (`formatLocalFindings` — one renderer
  for local and remote builds).
- If `ok: false`: print findings and exit with `CommandFailedError`
  immediately — the author does not wait for the record comment.
- If `ok: true`: print warnings (if any) and keep following to the final
  outcome comment (publication or website dispatch can still fail).
- Artifact unreachable (403/404 after retries): hard error naming the
  Actions-read permission and suggesting `lax login` to re-grant. No
  fallback.
- Update the `STAGES` map to the new job set; drop removed jobs.

## E. Shared setup + dist cache

- Local composite action `.github/actions/setup-lax`: checkout
  (`persist-credentials: false`), setup-node, restore cache key
  `lax-dist-${{ github.sha }}` covering `node_modules` + `dist`; on miss
  `npm ci && npm run build`; only **route** saves the key. Every job uses
  it, deleting the 5× copied boilerplate.
- **Exact keys only — no `restore-keys`.** Prefix fallback could restore an
  entry saved from the validate VM after a sandbox escape (the runner's
  cache token is reachable from an escaped process). With exact,
  per-commit keys: route saves the entry before validate starts, GitHub
  cache entries are immutable once saved, so privileged jobs can only ever
  restore route's bytes. State this in a comment on the action.
- The lean cache keeps its existing exact-key, save-before-execution
  discipline.

## Trust summary (what moved, what didn't)

- Validate stays credential-free; the artifact remains its only egress —
  unchanged, and now load-bearing for the CLI too.
- The publisher never trusted comments or artifacts without re-validation;
  that re-validation (`prepare-submit`) is untouched.
- CLI trust is unchanged in kind: it renders untrusted-but-sanitized bytes
  (previously comment text, now report JSON) and takes exit codes from
  data authored by trusted jobs (outcome markers) or from `report.ok`
  produced by the same job that authored the old comment content.
- Accepted regressions, both explicit decisions: untrusted bytes parsed on
  the host before the lean-cache save (gate), and the two publisher App
  keys coexisting in the merged publish jobs.

## Manual ops (Jan) — before/at rollout

1. GitHub App: add the **Actions: read** user-token permission. Existing
   author tokens may lack it until re-auth; the CLI's 403 message covers
   this ("run `lax login`").
2. Repo settings: consolidate the publish environments/keys per B.
3. Run the live-rehearsal drill against scratch repos before the workflow
   changes merge to main (they go live on push).
4. Release the CLI immediately after the workflow lands (stage 3 ships
   both sides together; old CLIs degrade gracefully, see C).

## Implementation stages (for the worker)

1. **Pipeline fail-early** — reorder `prepareValidation`, add the gate
   mode, reorder validate-job steps, rewrite the poisoning-stance comment,
   bump artifact retention. Tests: unit coverage for the gate mode and the
   new phase order; `test/e2e/host-pipeline.test.ts` still green. No
   protocol change visible to authors.
2. **DAG consolidation** — drop precheck (route `if:`), drop
   validation-result (direct gating + `report-validation-failure`), merge
   website into both publish jobs, add `.github/actions/setup-lax` + dist
   cache, update `report-workflow-failure` needs/conditions, update
   handler modes in `src/workflows/submission.ts`
   (`website`/`report-validation` modes fold into their new homes).
   Update the workflow unit tests.
3. **Report channel** — shrink the failure comment, add CLI artifact
   consumption (fflate, `run-artifacts.ts`, follow-loop integration,
   STAGES), grow `test/fake-github.ts` with the run-artifacts list and
   zip-download endpoints (build test zips with fflate), extend
   `test/e2e/cli-github.test.ts` to the artifact-rendering author journey.
   This stage ships workflow + CLI together.
4. **Docs & record** — README command/flow text, instructions.md (what a
   failed submit looks like now), spec-notes.md entry (short-comment
   deviation from the implied full-report comment; note that the gate
   ordering *restores* spec.md's stated phase order), TODO.md pointer,
   rehearsal + ops checklist execution.

## Open implementation notes

- Artifact upload latency: v4 artifacts are downloadable as soon as the
  upload step completes, but the CLI should tolerate a few seconds of
  list-lag after the job shows `completed`.
- `report-validation-failure` treats the downloaded report as untrusted
  data for wording only (it already runs credential-light: issues: write,
  no App keys).
- The `format('{0}{1}', …)` archive-commit join and the
  `should_publish`/`title_sync_error` output plumbing disappear with the
  merges — delete, don't port.
