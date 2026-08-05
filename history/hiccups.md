# CLI/pipeline hiccups from porting real submissions

Log of unexpected or unergonomic lax behavior encountered while porting the
twin-width submissions (2026-07-21). Raw notes for later fixing; newest at the
bottom.

- **License friction**: Static hard-requires the Apache-2.0 canonical text,
  but the source material being salvaged ships MIT. Porting someone else's
  MIT-licensed proof means relicensing their code as Apache-2.0 inside the
  submission. Worth deciding: accept a small allowlist (MIT/BSD) or document
  the Apache-only policy loudly in `lax init` output / spec.
- **Namespace rule trips over compiler-generated names**: the first real proof
  package failed Inspect with `[namespace] proof declaration
  Lax1.Treewidth.treewidth.congr_simp does not carry the namespace prefix
  Lax1Proofs`. simp persists auto-derived congruence lemmas as
  `<fn>.congr_simp` under the *rewritten function's* namespace, so any proof
  that simps with a concept-package definition violates the namespace rule
  through no fault of the author. Fixed in `inspector/Main.lean`
  (`userLevelName?` now filters `.congr_simp`); watch for siblings of the same
  breed (`eq_def`? `congr_thm`?) and consider a test that triggers one.
- **Inspector cache ignores source changes**: the built inspector is cached at
  `~/.lax/tools/<cli-version>/` keyed only by CLI version, so editing
  `inspector/Main.lean` during development silently keeps running the stale
  binary. Had to `rm -rf ~/.lax/tools` by hand. Consider hashing the inspector
  sources into the cache key. *(Fixed 2026-07-21: the cache key now includes a
  hash of the shipped sources, and the build stages into a process-private dir
  renamed atomically into place so concurrent builders cannot race.)*
- **Flat concepts + per-module namespace ownership vs multi-module
  developments**: the mixed-minor source is 28 modules sharing one `TwinWidth`
  namespace with cross-module dot-notation. The spec's rules (concepts cannot
  nest in subfolders; each concept module owns its module-name namespace) make
  a faithful per-module port practically impossible — splitting the namespace
  breaks dot-notation resolution for helper lemmas declared about another
  module's structures. Workaround: concatenate the entire development into a
  single 762 KB concept module `Lax2.Source`. Works, but the statement-surface
  story ("read the concepts to trust the statement") and the website rendering
  both suffer. Worth a think: either bless a "vendored source" concept
  convention, or support nested concept folders with a per-tree namespace
  root.
- **Import rule vs mathlib deps in practice**: real-world Lean developments
  casually `import Batteries.*` (found `Batteries.Data.Fin.OfBits` in the
  twin-width sources). lax rejects non-Mathlib prefixes, so authors must hunt
  for a Mathlib module that transitively imports the Batteries module they
  used. Unergonomic; consider allowing mathlib's own dependency closure, or at
  least a violation message that suggests the transitive-import workaround.
- **Path-edges end-to-end shakedown** (2026-07-28, a real rename through the
  lax-submissions RAM stack Lax13 → Lax11 → Lax15): the mechanism held up —
  downstream `lake build` compiles straight against the sibling's
  `.lake/build`, and rule (b) caught a lone dependent submit. Six frictions
  logged; four fixed same day in the CLI (see the commit adding
  `src/client/waveCheck.ts`): (1) rule (b) violations only surfaced after
  minutes of server build although the records sit in `~/.lax/db` — now a
  submit pre-flight refuses before upload; (2) a wave that moves an upstream
  silently strands dependent drafts outside the wave (Lax15 was left dangling
  when Lax13+Lax11 moved) — now a pre-flight warning names the stranded
  drafts and their folders; (5) `~/.lax/db` was three submits stale and
  `lax doctor` blessed it — doctor now compares the clone against the remote,
  and the submit pre-flight fast-forwards it quietly; (6) the unpushed-HEAD
  refusal named no remote and no command — it now prints both. Still open:
  (3) `lax spec` predates sibling path requires (says the only path require
  is the proof package's own `../concepts`) — spec.md is Jan's to reconcile;
  (4) pre-migration `.lake/packages/<LaxN>` full-repo clones (~170 MB in that
  repo) linger after a switch to path edges; nothing collects them.
