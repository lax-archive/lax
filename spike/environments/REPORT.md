# Spike: the pipeline under Lean/mathlib v4.33.0

Stage 0 of `environments-plan.md`, run 2026-09-04 on Jan's box (Opus
agent, reviewed). Question: does the current inspector source and the
pipeline's "verified at v4.30.0" assumptions survive three Lean minor
releases forward, so the first admission can build the inspector from
the one shared source, or does it need a snapshot?

## Verdict

**GO for stage 3's shape.** The inspector compiles unchanged under
`leanprover/lean4:v4.33.0` and, on a fixture exercising module docs,
frontmatter dash-stripping, matchers, reserved names, and the axiom
closure, its JSON is byte-identical to the v4.30.0 build's
(`inspector-v4.33.0.json`). The whole test suite passes with the pins and
the fake mathlib moved to v4.33.0. The only breakage is in the proof-tree
composer's Lean source, and it has a fix that compiles under both
releases.

Two things this did not prove: the `unsafeCast` extension readers are
only known to agree because the hand-built fixture diff agreed, so the
plan's `run_cmd` shape guards and golden fixture are still needed; and
nothing about the docker path or memory was measured.

## Measurements

| item | result |
|---|---|
| toolchain install (`elan toolchain install`) | about 1 min, 2.9 GB on disk |
| inspector build under v4.33.0 (`LAKE_ARTIFACT_CACHE=false lake build`) | clean, 4 jobs, ~15 s; manifest `"1.2.0"` accepted and not rewritten |
| inspector JSON v4.30.0 vs v4.33.0 on the same fixture | identical (3922 bytes) |
| `npx vitest run` with all pins at v4.33.0 | 66 files / 663 tests passed, 12 skipped (the usual opt-ins) |
| cold `lake exe cache get` at mathlib v4.33.0 | **skipped**: 23 GB free, under the 25 GB gate |
| mathlib tag `v4.33.0` | commit `db584cd6d46c92f209a44c0f1c829460d327499d`; its `lean-toolchain` is exactly `leanprover/lean4:v4.33.0`; `lean_exe cache` still declared |
| mathlib tag `v4.30.0` | `c5ea00351c28e24afc9f0f84379aa41082b1188f`, equal to the current pin |

## The one break: `Environment.addDeclCore`

`assets/prooftree/Main.lean` fails under v4.33.0 at its three
`Environment.addDeclCore` call sites (lines 150, 252, 335): the function
gained a positional `maxRecDepth : USize` with no default, so neither
positional nor named calls compile under both releases. `Verify.lean`
is fine. Fix (`prooftree-addDecl.patch`, elaborates under both v4.30.0
and v4.33.0): route the three sites through `Lean.addDecl` in `CoreM`,
whose signature is unchanged, with the same `toIO coreCtx { env }`
pattern the inspector's `runCoreIO` already uses.

Caveats before landing it (stage 3, with the shape guards): compilation
was proved, not semantics, so run `npm run smoke:prooftree` under both
toolchains; and the patch takes `maxRecDepth` from Core's default where
the old code passed only `maxHeartbeats` explicitly, so set an explicit
unlimited `maxRecDepth` in the Core context rather than risk a deep
generated proof term hitting the recursion limit.

## Admission checklist at v4.33.0

| fact | status |
|---|---|
| package-overrides read after manifest validation | holds (warm build + host pipeline green) |
| git materialisation on `lake build` alone | holds (cross-submission e2e green) |
| manifest entry shapes (`inputRev`, `inherited: false`) | holds |
| lake manifest schema `"1.2.0"` | unchanged; mathlib's own manifest at the tag is `"1.2.0"` |
| symlink-blind leanchecker (hardlinks) | holds (replay green) |
| `lake query -J +<mod>:olean` shape | holds |
| elan directory mangling | unchanged (`leanprover--lean4---v4.33.0`) |
| lake output paths | unchanged (`.lake/build/{bin,lib/lean,ir}`) |
| capture companion set | unchanged for lake lib output (the new `.ir.sig` files appear only in the toolchain's own core libs) |
| core import roots `Init/Std/Lean/Mathlib` | hold (4.33 drops the `Leanc`, `LeanChecker`, `LeanIR` olean dirs, never referenced) |
| leanchecker error regexes | not exercised (no test forces a failure); still (M) |
| `LAKE_ARTIFACT_CACHE=false` not overridden in the closure | not exercised (fake mathlib has no closure); still (M) |
| replay/inspect peak memory | not measured (docker path) |

## Lessons

- The prooftree smoke and the inspector golden test are the two things
  admission must run; unit and fake-mathlib e2e alone would have passed
  and missed the composer break.
- Running the suite with `LAX_TEST_CACHE` set still created a warm store
  under the real `~/.lax/warm` (a fake-mathlib key, `v4.33.0-14cafbe8…`;
  a stale `v4.30.0-9c129b77…` from 2026-09-03 sat beside it). Both were
  removed. Per-environment warm dirs make such leaks multiply; the test
  seam should route every warm store through the test cache.
