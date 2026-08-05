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

**This tree is mid-rework.** It was produced by an outside AI rewrite of the
old repository (`../lax`) and is now being reshaped to our design. The
charter is `rewrite.md` (Jan's change list, written in the old repo — "this
folder" there means `../lax`) and `rewrite-plan.md` (the reviewed plan and
order of attack). Read both before structural work; prefer them over
inferring intent from the current code. When Jan says **"continue the
rework"**, follow rewrite-plan.md's "Running the plan" protocol: run the
next unfinished stage from TODO.md via a worktree-isolated worker, review
and test it, commit, and stop for Jan's go.

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
- **one-axiom-plan.md** — the implemented one-statement-per-concept design;
  scheduled to be relaxed (multiple statements) per rewrite.md.
- **README.md** — user-facing status, trust model, and command table.
- **instructions.md** — the author-facing guide to creating a submission.
- **history/** — closed records, kept for their lessons and never a plan:
  `front-worker-split.md` (the reverted 2026-07 split), `oom.md` (the
  server OOM postmortem — source of the LEAN_NUM_THREADS and env-delivery
  lessons), `hiccups.md` (friction log from porting real submissions),
  `sibling-paths-plan.md` (the old sibling-requires design; the feature is
  being removed per rewrite.md).

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

## Architecture (current state; rewrite-plan.md governs upcoming changes)

`.github/workflows/submission.yml` is the only issue-event entry point: it
routes issue/comment events, runs validation (Compile → Replay/Inspect as
separate jobs today; planned: one job), and publishes through trusted jobs.
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
them). Database writes go through the GitHub API with a non-forced ref
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
flow, `/user`, `/credentials/revoke`, and a seedable issues list; tokens are
`ghu_tok-<handle>` from a `"alice:1,bob:2"` registry. `test/e2e/cli-github.test.ts`
drives the real CLI against it (spawn asynchronously — a blocked event loop
starves the fake); stage 5 grows it to issues/Actions/Releases for the full
author journey. The container pipeline is tested via runners injected through
`ValidationOptions.runner`; real-Lean coverage comes from
`test/e2e/host-pipeline.test.ts`, which runs the host pipeline (and the CLI)
against the fake mathlib (`LAX_MATHLIB_URL`/`LAX_MATHLIB_REV`, wired up in
`test/global-setup.ts`/`test/setup-env.ts` over the shared `~/.cache/lax-test`
cache), plus the docker smoke script for the container path.
Never set test seams in production, and never import test/ files from src/.
