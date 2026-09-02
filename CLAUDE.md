# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

Lax is the social and archival layer for automated Lean formalization. This
repository owns the author CLI (`lax`), the GitHub-issue control plane,
authorization and input validation, trusted `lax-database` mutation, Website
rebuild dispatch, and CLI release packaging. There is no archive server any
more: GitHub issues allocate submission ids, `/lax` issue comments request
state changes, and trusted GitHub Actions jobs publish to the public
`lax-archive/lax-database` repository and dispatch rebuilds of
`lax-archive/lax-website`.

**The rework is executed and live.** This tree was produced by an outside
AI rewrite of the old repository (`../lax`, now `lax-legacy` on GitHub) and
then reshaped to our design per `rewrite.md` (Jan's change list, written in
the old repo — "this folder" there means `../lax`) and `rewrite-plan.md`
(the reviewed plan). All stages ran 2026-08-05/06 and the system went live
2026-08-06 (`history/rework-execution.md`, `history/go-live.md`). The
charter documents remain the intent record for structural questions —
prefer them over inferring intent from the current code.

## The documents and their roles

- **spec.md** — the normative starting point. Do **not** edit it unless
  explicitly asked; Jan reconciles it manually. (One unreconciled agent
  edit exists — see the 2026-08-05 spec-notes entry.)
- **spec_conceptdialect.md** — normative companion specifying the concept
  dialect and its gate; same rule. **spec_conceptdialect_draft.md** is the
  proposed successor, awaiting Jan's reconciliation.
- **lax.md** — the high-level vision. Do not edit unless asked.
- **spec-notes.md** — the living document: deliberate deviations and
  proposed amendments to spec.md. Record spec-relevant design changes here.
- **TODO.md** — the canonical list of next steps, and *only* next steps:
  history belongs in `history/` or git, not here. Keep it updated.
- **rewrite.md / rewrite-plan.md** — the rework charter (see above).
- **paper-plan.md** — the paper layer (LaTeX documents with comment
  markers, compiled by the archive, shown beside concept/proof cards):
  planned and spiked 2026-09-02; stages 1 (contract), 2 (host path), and
  3 (trusted path: `pins.ts` TeX image, `paper/container.ts`, the phase in
  `pipeline.ts`, the PDF layer in `capture-store.ts`, `paper.pdf` in the
  validate artifact) implemented the same day
  (`src/submission-validation/paper/`, `host/paper.ts`,
  `assets/tex/laxmark.sty`); the stage-3 rehearsal and stages 4–6 are
  open — see TODO.md. Throwaway spike material in `spike/paper/` (its
  `REPORT.md` files hold the measured verdicts).
- **one-axiom-plan.md** — the old one-statement-per-concept design. The
  bound was lifted on 2026-08-06 (a concept declares any number of
  statements; see the spec-notes entry), and the plan document was deleted
  in `edf2e70`; it survives only in git history.
- **README.md** — user-facing status, trust model, and command table.
- **instructions.md** — the author-facing guide to creating a submission.
- **history/** — closed records, kept for their lessons and never a plan:
  `front-worker-split.md` (the reverted 2026-07 split), `oom.md` (the
  server OOM postmortem — source of the LEAN_NUM_THREADS and env-delivery
  lessons), `hiccups.md` (friction log from porting real submissions),
  `sibling-paths-plan.md` (the old cross-submission path-require design;
  the feature was removed in stage 6a per rewrite.md — cross-submission
  edges are rev-pinned git requires only, landed by the chain workflow
  documented in instructions.md), `live-rehearsal.md` (the 2026-08-06
  stages-3+4 scratch-repo rehearsal — its setup recipe, the ir-companions
  bug it caught, and the smoke-gating lesson), `rework-execution.md` (the
  executed rewrite stages, measurements, and spike verdicts), `go-live.md`
  (the database port, box stop, DNS/HTTPS cutover, first npm releases —
  with the trusted-publisher rebinding and tarball-packaging lessons —
  and the production round trip), `pipeline-simplification-rollout.md`
  (the 2026-08-07 rollout: why a secret cannot be moved between
  environments, the vacuous protected-branches policy, and the
  seven-record production sweep that replaced the skipped drill).

## Commands

```sh
npm run build            # compile to dist/
npm test                 # vitest (unit + workflows)
npm run check            # build + test
npm run lax -- --help    # run the CLI from source
npm run smoke:submission-validation   # real-container smoke (needs docker; shares ~/.lax + ~/.elan)
```

The pinned page-builder consumed by `lax serve` is assembled for release with
`page-builder:fetch`, `page-builder:package`, and `page-builder:verify`.
The live-rehearsal drill (scratch-repo round trips before any Actions-side
change ships) is scripted in `scripts/rehearsal/` — see its README. The
one-shot go-live migration that re-validates every existing `lax-database`
record through the control plane, bottom-up in dependency order, is
`scripts/port-db/` — start with `node scripts/port-db/port.mjs --dry-run`.

## Architecture (current state; rewrite-plan.md governs upcoming changes)

`.github/workflows/submission.yml` is the only issue-event entry point. Its
success path is three jobs — route → validate → publish-submit — beside
`publish` (the non-submit branch), `report-validation-failure`, and
`report-workflow-failure`; every job shares `.github/actions/setup-lax`
(checkout, node, exact-key `dist`+`node_modules` cache that only route
saves). The read-only Validate job runs a fetch → static → resolution gate
first, before the lean cache restore and host provisioning, then Compile →
Replay → Inspect sequential through one container runner. Both publish jobs
dispatch the Website rebuild themselves, so both App keys live in the
`lax-database-publish` environment (trust rule 1 is the surviving invariant;
see the 2026-08-07 spec-notes entry). The author's channel for validation
detail is the report artifact, which `lax submit` downloads and renders
(`src/cli/run-artifacts.ts`); issue comments are short outcome records with
the hidden markers.
The validation phases live in `src/submission-validation/` and are shared
between the trusted workflow and local `lax build`; local mode may omit only
server-only fetching, mandatory replay, and publishable artifact creation.
`src/workflows/` holds the workflow TS entry points, `src/shared/` the
publisher/control-plane/archive code, `src/cli/` the CLI. Untrusted code
runs in docker containers (`src/submission-validation/sandbox/`) with
allowlist-only mounts, env allowlist, resource caps, and a workspace
watchdog; the container is a stock digest-pinned image
(`src/submission-validation/pins.ts` — the single home of all pins) with
the VM-installed toolchain and warm mathlib workspace bind-mounted
read-only (`host/setup.ts` provisions them, `sandbox/layout.ts` resolves
them). A declared paper compiles in a second digest-pinned image (a full
TeX Live, `PAPER_IMAGE` in the same pins module) through the same runner,
with none of the Lean mounts, concurrently with the Lean chain. Database writes go through the GitHub API with a non-forced ref
update (compare-and-swap) plus re-validation on retry; dependency captures
are pushed as digest-addressed OCI artifacts to ghcr
(`ghcr.io/<owner>/lax-captures`, `src/shared/capture-store.ts`) before the
database commit that references them — tags are mutable and only for
discoverability/GC; consumers pull anonymously by the digest recorded in
the dependency's `build-output.json` and verify the bytes.

## Trust rules

1. Never give a job that checks out or executes submission code a GitHub App
   private key, installation token, or Archive write permission.
2. Treat every event value, comment, owner pair, URL, SHA, and path as
   untrusted. Parse event JSON as data and repeat schema, issue-binding,
   numeric-owner, state, and stale-write checks in the trusted publisher,
   credential-free, before any token is minted.
3. `lax-database` is the database repository. Do not reintroduce `lax-db` in
   active code, workflow configuration, or user documentation. (`history/`
   predates the rename and keeps the old name; that is fine there.)
4. The CLI authenticates through a GitHub App user access token (`ghu_`),
   not an OAuth App token or PAT. App private keys and installation tokens
   exist only in trusted workflow jobs.
5. Trusted Replay/Inspect never use `lake env` and never take a search path
   through anything Compile wrote.

## Test seams

GitHub is faked two ways: in-process (`vi.stubGlobal("fetch")`, injected
clients) for unit tests, and via `test/fake-github.ts` — a local HTTP server
that CLI subprocesses reach through `LAX_GITHUB_API_URL`/`LAX_GITHUB_OAUTH_URL`
(late-bound in `src/shared/constants.ts`). It serves the GitHub App device
flow, `/user`, `/credentials/revoke`, a seedable issues list, workflow
runs/jobs, and that run's artifacts — list plus a real zip download behind
the redirect GitHub answers with (`artifactZip()`, and `artifactListStatus`
to force the 403 the CLI must hard-error on); tokens are
`ghu_tok-<handle>` from a `"alice:1,bob:2"` registry. `test/e2e/cli-github.test.ts`
drives the real CLI against it (spawn asynchronously — a blocked event loop
starves the fake); stage 5 grows it to issues/Releases for the full
author journey. The container pipeline is tested via runners injected through
`ValidationOptions.runner`; real-Lean coverage comes from
`test/e2e/host-pipeline.test.ts`, which runs the host pipeline (and the CLI)
against the fake mathlib (`LAX_MATHLIB_URL`/`LAX_MATHLIB_REV`, wired up in
`test/global-setup.ts`/`test/setup-env.ts` over the shared `~/.cache/lax-test`
cache), plus the docker smoke script for the container path. The capture
registry is faked by `test/fake-ghcr.ts` behind `LAX_CAPTURE_REGISTRY_URL`
(read per call by `src/shared/capture-store.ts`).
`test/e2e/cross-submission.test.ts` proves the host cross-submission path —
dependencies build **from source** locally, via lake's pinned-git
materialization over local fixture repos reached through `GIT_CONFIG_*`
url rewrites — and pushes captures through the real store against the fake
registry; the container-side capture materialization keeps its verification
coverage in `test/unit/submission-validation-captures.test.ts` (fake
runner) plus the docker smoke. `LAX_E2E=1 npx vitest run test/e2e/real-mathlib.test.ts`
opts into the real-pins mathlib e2e, which reuses the user's own
`~/.lax/warm` store.
Never set test seams in production, and never import test/ files from src/.
