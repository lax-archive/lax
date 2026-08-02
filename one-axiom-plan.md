# One statement per concept: the rule and its implementation

Status: proposed, 2026-07-27. Companion documents:
`~/git/lax-submissions/submission-polish.md` (restructuring the flagship
drafts around the same findings) and
`lax-website/old-logic/website-plan.md` (the claim-page rewrite this rule
enables). Spec touchpoint recorded in spec-notes.md.

## The rule

A concept module declares **at most one axiom**. A concept is thereby
either a **definition-concept** (zero statements: it contributes
vocabulary) or a **claim-concept** (one statement: the concept *is* the
claim, and the module's other declarations are the vocabulary needed to
state it).

Consistency with the `type` frontmatter key:

- `type` ∈ {theorem, lemma, proposition, corollary} ⇒ exactly one axiom;
- `type` = definition ⇒ zero axioms;
- other or absent `type` ⇒ only the ≤ 1 bound applies.

Jan feedback: we do not enforce this type consistency!

## Why

A survey of every submission in `~/git/lax-submissions` (2026-07-27; all
28 concept modules) found the rule is already universal, unforced
practice — the natural grain of the format. Codifying it buys:

- **One ontology.** The unit of citation, navigation, and dependency
  (the concept) becomes the unit of the proof network (the statement).
  Proof `conclusion`/`assumptions` ids, concept pages, and graph nodes
  all name the same things.
- **A 1:1 NL↔formal binding.** One annotation, one axiom: the reader
  auditing "does the Lean say what the English says" — the archive's
  core value — checks one pair, not one description against *n* axioms.
- **Unambiguous status.** "Proven"/"open" is a property of the concept;
  partial states ("3 of 4 statements proven") cease to exist, which
  collapses most of the website's status-display complexity.
- **Crisp bounties.** "This concept is an open problem" only works with
  one obligation per concept; the flagship drafts already advertise
  open obligations this way.

The known cost is granularity pressure (authors must place shared
definitions in definition-concepts and split independently provable
conjunctions); that is a norms problem, handled in the submissions
repo's styleguide (submission-polish.md), not enforceable here beyond
the cardinality check.

## Enforcement

One new check in the Inspect phase, where `ConceptEntry.statements` is
assembled from the inspector report (`src/pipeline/inspect.ts`, the
declarations loop around line 143):

- After the loop, for each concept entry: `statements.length > 1` ⇒
  violation (kind `one-statement`), naming the module and every axiom it
  declares, citing the spec section.
- Type consistency per the table above, same violation kind, phrased as
  "type says theorem but the module declares no axiom" / "type says
  definition but the module declares an axiom".

Notes:

- The check is pure build-output shape — no inspector (Lean-side)
  change, no new phase, no sandbox implications. It runs identically in
  `lax build` and the server pipeline, like every Collector violation.
- Proof-side is already conformant by construction: proofs conclude
  exactly one statement (spec), so nothing changes there.
- The claim-word list lives beside the existing type-badge vocabulary
  (`lax-website/src/sitegen/html.ts` `TYPE_BADGES`) — hoist one shared constant into
  `src/constants.ts` rather than duplicating it.

## Rollout

- **No migration.** Verify with a scan over the cloned db's build-outputs
  that every existing record satisfies the rule (the corpus survey says
  yes: Lax1, Lax2 and the unsubmitted drafts all conform; confirm against
  the live db in case of strays). The record schema is unchanged
  (`statements` stays an array, now length ≤ 1), so no `specVersion`
  bump and no re-verdict machinery — unlike the dialect gate, this rule
  never needs to be checked on *foreign* content at resolution time,
  because the server enforced it at submit.
- **Spec:** amendment drafted in spec-notes.md ("One statement per
  concept"); spec.md's "The statements of a concept are the axioms whose
  module of origin it is" (§Concept packages) gains the cardinality and
  the type table when Jan folds it in.
- **Sequencing with the drafts:** land the check after the
  submission-polish restructuring is re-submitted (it only *moves* defs,
  never adds axioms, so there is no hard ordering — but polishing first
  means the rule never fires on our own flagship content).

## Tests

- Fast-suite fixture: a concept package whose module declares two
  axioms ⇒ `one-statement` violation; the same module with one axiom
  passes unchanged.
- Type-consistency cases: `type: theorem` with zero axioms, `type:
  definition` with one axiom, absent type with one axiom (passes).
- Existing e2e and fixtures are already single-axiom; no updates
  expected — a failure there is a real regression.

## Explicitly out of scope

- **Renaming axioms to a canonical `statement` name.** Mathlib-style
  axiom names are informative and proofs reference them; the website can
  present concept-level identity without touching Lean names
  (`lax-website/old-logic/website-plan.md`).
- **Prohibiting conjunctions.** `∃ … ∧ …` describing one witness is one
  claim; a top-level `∧` of independently provable claims is a
  styleguide matter no mechanical check can distinguish.
- **Retroactive constraints on definition-concepts** (how much
  vocabulary one may carry) — norms, not rules.
