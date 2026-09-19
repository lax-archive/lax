# Spec amendment notes

Proposed amendments to [spec.md](spec.md), written while implementing — one
entry per change, with the implemented behavior and the reason it diverges
from or refines the current text. To be folded into the spec manually; this
file is not normative. (Entries of earlier milestones were folded into
spec.md on 2026-07-22, 2026-08-07, 2026-09-14, and 2026-09-15 and removed
here; the folded text survives in git history.)

## Local sibling path requires and the strict default (implemented, 2026-09-19)

Two deviations in `lax build`, both local-only and both opt-in through one
flag, `--nonstrict`; the trusted pipeline, the gate step, `lax submit`, and
every other caller are unchanged and refuse exactly what spec.md says they
refuse.

- **spec.md "lax build"** says build alone admits a require on a draft record
  with a warning. Implemented: only `lax build --nonstrict` does; the default
  refuses it in the archive's words, so a default local build passes exactly
  when the archive would. Reason: a second local-only relaxation (below)
  needed a flag, and one flag governing both edges the archive refuses is the
  coherent shape.
- **spec.md "Packages"** says cross-submission path requirements are not
  supported. That stays true for the archive. Locally, `lax build --nonstrict`
  admits a `path` require on a *sibling*: another local submission's package,
  by its Lax package name, relative to the requiring package directory. The
  sibling's own lakefile is validated by the same rules (name, mathlib pin —
  which is the environment check — well-formed requires); its git requires
  join Resolution as further direct requires, its path requires are siblings
  in turn, and the whole closure is seeded flat into the dependent's generated
  manifest, since lake reads no path dependency's own manifest. Lake builds a
  sibling in place, as it does the proof package's `../concepts`, so
  artifacts are shared both ways; the sibling's lib dir joins the Replay and
  Inspect search path; imports from it are declared, and its axioms are
  admissible statements by package prefix (its own build judges it). A
  registered sibling is refused with the git require to write. The output
  records the siblings and `lax submit` never reuses it. Reason: parallel
  work on an unregistered chain (spec.md "Packages": "committed, submitted,
  and registered bottom-up") otherwise has no local build until the
  dependency has a commit, and no shared artifacts at all.

## `lax serve` opens on a local front page and renders siblings (implemented, 2026-09-19)

spec.md "lax serve" says the preview prints the folder's own page,
``/<id>/``, and that ``--database-only`` opens on the index. Implemented:
the printed link is ``http://localhost:8123/``, the preview's own front
page — a local page, never one of the renderer's, that says it is a local
preview, lists the folder and every sibling its lakefiles' ``path`` requires
reach (id, title, environment, "local build" or "no build output yet — run
`lax build` in <folder>", a link to ``/<id>/``), carries the database
warning and the reason the last render failed, and links to the generated
archive index, which keeps its place at ``/index.html`` because the
generated pages link to it relatively. The folder's page, the ``/local/``
placeholder, and the redirect a mid-preview build triggers are unchanged;
``--database-only`` opens on the same front page with no local list.
Sibling folders that have a ``build-output.json`` are rendered as further
local submissions (siblings first, the folder last, deduplicated by id with
the folder winning), and are watched like the folder; a sibling without one
is listed and not rendered. Reason: a nonstrict output whose proofs
conclude a sibling's statements cannot be rendered without the sibling
loaded (the page builder refuses a statement with no home concept), and the
loading page said nothing about why; a front page that lists what is served
and what is missing is the place for both, and makes the preview
self-explanatory in the strict case too.

## Concept dialect: second draft, advisory model (proposed, 2026-07-29)

[spec_conceptdialect_draft.md](spec_conceptdialect_draft.md) is a proposed
replacement for spec_conceptdialect.md, written after the first real corpus
existed (nine submissions, ~4,800 lines of concept source) and revised
twice the same day after two rounds of review. Until Jan reconciles it,
spec_conceptdialect.md stands — **with the security hole of the next
bullet still open in it**. The deltas, in short:

- **The mention rule (list 8), closing a hole both drafts shared.** The
  second review found the safety argument false as written: it claimed
  code runs only where a *name in the source* selects a program, and
  closed each such position with a list of admissible syntax forms.
  `autoParam` breaks that. Its signature in the pin is
  `abbrev autoParam (α : Sort u) (tactic : Lean.Syntax) : Sort u`
  (Init/Tactics.lean, 4.30.0) — the tactic to run is a **data value**, so
  an author can apply the constant to a `Syntax` they assembled from
  ordinary inductive constructors, leave a structure field open, and have
  the elaborator run `run_tac` (hence arbitrary IO) while every node in
  the file's syntax tree is whitelisted. No tree-walk can see it;
  `Lean.reduceBool`, which makes the *kernel* run compiled code, is the
  same shape. The fix is a second axis: a rule over **resolved names** —
  no `autoParam`/`optParam`, and nothing in the `Lean` namespace or whose
  type mentions a type from it. Consequences: the door list gains the
  value-door entry, the term snapshot's generation-time exclusions gain
  name literals (three entries now), the gate gains an identifier-
  resolution check before elaborating each command plus an info-tree
  check afterwards for the spellings that need elaboration to resolve
  (dot-notation, field notation), and the schema file gains a generated
  excluded-name set beside the term snapshot. The after-the-fact half
  reads **source occurrences from the info tree, never the elaborated
  Exprs**: a concept extending a mathlib structure inherits `autoParam`
  and `Lean.Syntax` into its own types without mentioning them, so an
  Expr scan would mislabel legitimate mathematics. Deferring that half is
  sound because applying a constant to a fabricated `Syntax` runs
  nothing; only `autoParam` does, and it is a bare root-level name that
  cannot be dot-notated, so the pre-elaboration check always sees it.
  The invariant the rule actually protects is not "no `autoParam` in a
  concept" (inherited ones and the `(h : P := by simp)` field default are
  both fine) but: every tactic that runs was either chosen by pinned code
  or written out in a `by` block that passed the tactic list.
  Verified: **zero** mentions of any excluded name across the 264
  authored concept files in `~/git/lax-submissions`, so the rule costs
  the corpus nothing. Honest cost to the design: list 8 is a blacklist,
  the only one in the document — a whitelist over names is impossible —
  so its completeness is an audit, mechanized as a generated set whose
  diff is reviewed at each pin bump. The draft now says so in three
  places rather than claiming there are no blacklists.

- **Advisory, not blocking (Jan's call)**: "safe dialect" is a label, a
  moving target fixable later — every submit records an own-package
  verdict (pass/fail + dialectVersion, never a violation), *safe* is
  derived transitively (own pass ∧ all concept deps safe), the website
  displays it, and the CLI warns pre-Compile naming every closure member
  that is not safe (off-dialect concepts, foreign proof packages,
  unknowns) — nothing is ever refused. Replaces the first draft's
  admission gate, the `--allow-foreign-proofs` flag (gone;
  `--require-safe` reserved as strict opt-in), and the entire
  quarantine/verdict-voiding evolution ceremony (any schema change = one
  batch re-verification in dependency order). Anti-forgery rule: the gate
  loads dependency artifacts only when their own verdict is `pass`.
- **Tactics: closers only** (eleven one-step closers + termination
  annotations; no conv sub-language), enabled by restructuring the corpus
  instead of growing the dialect: the survey found the only real tactic
  proofs in Lax3's ScatterChoice witnesses (verification content — moves
  to the proof package; no concept references the witnesses, verified)
  and two off-dialect forms in Lax5 (`@[implicit_reducible]`,
  `deriving Language.IsRelational` — on-dialect substitutions). The
  restructure plan lives in
  `lax-submissions/plans/submission-polish.md`, "Dialect-driven
  restructures"; after it the corpus needs zero tactics in concepts.
- **Term layer becomes a literal whitelist**: the origin rule
  ("background-registered minus a ban list") is replaced by a generated,
  checked-in snapshot of every term-category syntax kind the pinned
  background registers, with the two capability exclusions (`include_str`,
  syntax quotations) applied at generation time and the snapshot *diff*
  reviewed on every pin bump. Same audit as before; the audited object is
  now an explicit file. Adds a dump mode to the gate executable.
- **Restructured** into an author-facing Part I (readable by a Lean
  non-expert, per the design goal) and a condensed enforcement Part II;
  gate mechanism, capture isolation/provenance, and the non-goals carry
  over unchanged.

