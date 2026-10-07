# Spec amendment notes

Proposed amendments to [spec.md](spec.md), written while implementing — one
entry per change, with the implemented behavior and the reason it diverges
from or refines the current text. To be folded into the spec manually; this
file is not normative. (Entries of earlier milestones were folded into
spec.md on 2026-07-22, 2026-08-07, 2026-09-14, 2026-09-15, and 2026-09-19
and removed here; the folded text survives in git history.)

## `lax serve` renders the folder's pages, not the archive's (2026-10-07)

**Spec text:** "lax serve [folder] runs the site generator and serves the
result locally", with the generated archive index at `/index.html` and
the folder's own page at `/<id>/`.

**Implemented:** the generator still runs over the complete local database
copy — the index, the submissions listing, the proof network, the sidebars
and `index.json` are a function of the whole archive and stay so — but by
default it writes the per-record pages (`<id>/index.html`, the concept,
proof and paper pages) only for the folder and its rendered siblings
(`--render this`). A request for a page of a record left unwritten is
answered with a redirect to the same path on the public site, where the
relative links of the generated pages land it. `--render dependencies`
adds the folder's transitive dependencies, as the generator resolves the
requires; `--render all` writes every record's pages, and `--database-only`
always does, having no folder to scope to.

**Why:** the render's time is almost entirely the other records' pages —
140 records make 3,579 pages, about half a second each, against about two
seconds for everything the whole archive contributes. A preview that took
over a minute per `lax build` now takes a few seconds, and what the author
is iterating on is the folder; the other records' pages are the public
site's, which is also where the authoritative copy lives (the local
database copy can be behind it until `lax sync`). The cost accepted is
that browsing other records from the preview needs the network.

**Proposed spec change:** in "lax serve", after the sentence on the
generated archive index, add: "By default only the folder's and its
siblings' pages are generated; the listings and graphs still cover the
whole database, and a link to another submission's page opens it on the
public site. `--render dependencies` also generates the pages of the
folder's transitive dependencies, `--render all` every submission's;
`--database-only` generates every submission's."

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

