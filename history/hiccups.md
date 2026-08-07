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
- **Login failure surfaced only after the build** (2026-08-07, a real
  `lax submit` of finite-ramsey/lax-14): the CLI touched the login in its very
  last step, so a stored login GitHub would not renew was reported after two
  full `lake build`s — and reported three ways wrong: as
  `GitHub App authorization failed with HTTP 500` (a bare status, no mention of
  the stored login being refreshed, and no `lax login`), preceded by
  `lost contact with GitHub; the workflow run may still be going` and a
  `--resume` hint for a run that had never been dispatched. Fixed: `lax submit`
  resolves *and* verifies the login (`GET /user`, which is what catches a token
  revoked on github.com) before the build and prints
  `authenticated as <handle>`; authentication failures are a typed
  `AuthenticationError` that `withResumeHint` treats as final, since they always
  precede the command comment; the token endpoint distinguishes GitHub's 5xx
  from a refused login. Deliberately *not* extended to `--resume` (a run may
  really be going there, so the resume hint must win) nor ahead of
  delete/register's offline database preflight, which is the more useful
  refusal and is pinned by a test.
- **A submit that said everything except what happened** (2026-08-07, the
  same real `lax submit` of lax-14): the run printed its workflow-run URL
  three times, echoed the control plane's markdown back at the terminal
  (`Submit preview for **lax-14**:` — the triple the CLI had just printed),
  and spun on GitHub Actions job and step names. What it could *not* print
  was a compile error: the pipeline flattened every violation message to one
  line, and the comment builder then cut each to 600 characters, so a failed
  `lake build` reached the author as a sentence-long fragment of its own
  transcript. The old server had sent a `transcriptTail`. Fixed by carrying
  multi-line findings through the report into fenced blocks in the result
  comment (`src/shared/comment-format.ts`), rendering comments as terminal
  text instead of echoing markdown (`src/cli/render.ts`), and naming stages
  ("validating: compile, kernel replay, inspection") rather than CI steps.
  Same round trip also revealed that a *failed* command exited 0: result
  comments now carry `<!-- lax-outcome:... -->` and the CLI exits on it.
