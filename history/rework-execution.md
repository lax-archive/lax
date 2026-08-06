# The rework, as executed (2026-08-05 … 2026-08-06)

Closed record of running the rewrite charter (rewrite.md, rewrite-plan.md).
Every stage below is done; this file keeps the outcomes and lessons. The
red-team addendum (2026-08-05) in rewrite-plan.md won over earlier plan text
wherever they conflicted.

## Stages

1. **Doc consolidation** — done 2026-08-05 (TODO.md recreated by triage,
   CLAUDE.md, history/, spec-notes entries, README fix, open-use notice).
2. **Runner seam + local build + test seams** — done 2026-08-05
   (`ValidationRunner` injection; host-toolchain in-place incremental
   `lax build` with streamed transcripts; warm store shared via Lake
   package overrides per the spike below, no hardlink farm; fake-mathlib
   + fake-GitHub seams with real-lake and CLI-subprocess e2e tests).
3. **Pipeline collapse** — code complete 2026-08-05 (one read-only
   validate job — no issue write, no secrets where submission code runs;
   stock digest-pinned `node:22-bookworm-slim` + VM toolchain/warm store,
   actions-cache saved *before* untrusted code runs; Compile/Replay/
   Inspect sequential through one container runner, replay/inspect at 2
   threads per the measurement; captures on ghcr as digest-addressed OCI
   artifacts — hashed tuple+pin tag, anonymous pull verified live,
   push-before-CAS-commit ordering, Releases store deleted). The live
   rehearsal on scratch repos ran 2026-08-06 together with stage 4's
   publish rehearsal (record: live-rehearsal.md); it caught and fixed a
   production-blocking container bug (`installOwnConceptCapture` shipped
   lib without the ir companions; commit ca6db0f).
4. **Write path** — code complete 2026-08-05 (CAS + credential-free
   preflight unchanged; all `concurrency:` blocks removed per addendum
   point 4, CAS is the correctness mechanism; inline-JS failure reporter
   replaced by a typed `report-failure` mode with byte-compatible
   markers; YAML logic assertions converted to behavioral TS tests incl.
   an env-poisoning canary proving prepare-submit never touches the
   database token; YAML keeps only wiring/permission/pin lints).
5. **Test port** — done 2026-08-05 (triage executed: ~17 real-lake and
   unit ports incl. the compiler-realized-reserved-name and scoped-build
   regressions; cross-submission dependency e2e over a fake ghcr — which
   exposed and fixed captures shipping only oleans while lake v4.30
   needs the trace/hash/ilean/ir companions, a production-blocking bug;
   CLI delete-refusal e2e; opt-in real-mathlib e2e restored under
   LAX_E2E=1, run once, 24.7 s against the warm store; sibling and wave
   ports skipped as moot, sitegen/DAG tests belong to lax-website).
6. **Independent follow-ups** — done 2026-08-06, one commit each:
   sibling paths forbidden (siblings.ts + arms deleted, chain-workflow
   guidance in static/resolution errors and instructions.md; note: the
   repo-wide H5 duplicate-id/nesting scan died with siblings.ts — no
   longer correctness-relevant, revive only as hygiene if missed; the
   `lax submit A B C` macro is still future CLI work); multiple
   statements per concept allowed (inspect gate + the trusted artifact
   parser's cardinality bound removed; presentation is lax-website
   work); CLI polish (`lax submit --resume` re-deriving the run from
   issue comments, source-triple submit replaces `lax update`,
   progressive doctor, no-silent-waits sweep incl. login heartbeat and
   per-dependency capture progress).

## The three load-bearing unknowns, resolved

- **Replay memory on a 16 GB swapless hosted runner** — measured
  2026-08-05, **go** at ≤2 threads: 10.78 GiB peak on word-ram at t=2;
  ~5.6 GiB per concurrent mathlib environment import, so t=4 never fits;
  compile peaked at 3.84 GiB at 4 threads. Caps carry the measured
  rationale in config.ts. (Full numbers: rewrite-plan addendum point 1.)
- **`queue: max` concurrency semantics** — never verified; all
  `concurrency:` blocks were removed instead and CAS remains the only
  correctness mechanism (addendum point 4).
- **Whether Lake package-overrides reuse built oleans** — yes; spike below.

## Package-overrides spike (2026-08-05, verdict: yes)

At the pinned v4.30.0, `.lake/package-overrides.json` is applied on every
`lake build`, fully reuses the override target's built oleans in place,
performs zero writes against a fully read-only store (safety + tripwire),
and is concurrency-safe; the generated `lake-manifest.json` keeps the warm
git pins verbatim so no drift warning fires. Landed in stage 2:
`seedOverrides` replaces the hardlink farm, Static rejects a *tracked*
package-overrides file, `LAKE_ARTIFACT_CACHE` stays off everywhere. The one
landmine: a dependency lakefile enabling the artifact cache would beat the
env var — re-check on any pin bump. Two drafts in parallel share the store
with no extra machinery.

## Fixes found by the 2026-08-05 rewrite review (closed)

- **Shallow-fetch gap carried over verbatim** — closed 2026-08-06:
  `source/fetch.ts` progressively deepens (geometric `--deepen`,
  8192-commit cap, shared fetch deadline) after a refused
  unadvertised-SHA fetch, with fixture-remote tests pinning the found /
  capped / absent cases.
- **Local compile errors flattened to one line** — fixed in stage 2 (host
  local mode streams the full transcript; guarded by e2e).
- **Lost rationale re-homed** in stages 2–3: symlink-blind leanchecker
  realpath comment lives in `host/leanenv.ts`, the no-`lake update`/
  `post_update` rationale in `host/warmstore.ts`, the `--clearenv`
  fail-closed lesson at run-check.mjs's LEAN_NUM_THREADS gate (asserted
  by test).
- **`lax build` cleanup bug** — fixed 2026-08-06: the original trigger
  (read-only materialized dependency dirs) disappeared with local
  source-built dependencies, and the CLI's finally now runs
  `removeValidationWorkspace` (chmod +w before rm) so any read-only
  content in the temp job dir is removed regardless (e2e-asserted via a
  private TMPDIR).
- **Docker smoke gated in CI** — done 2026-08-06: ci.yml gained a `smoke`
  job running `npm run smoke:submission-validation` on every push, with
  the validate job's cache pattern and workflow-lint coverage.
- **Rehearsal scripted for collaborators** — done 2026-08-06:
  `scripts/rehearsal/` (setup/drive/teardown + README); the workflow
  patch is derived from the current submission.yml at run time by
  patch-workflow.mjs, whose drift assertions run against the real
  workflow on every `npm test`.
