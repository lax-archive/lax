import Init

/-!
---
title: Golden fixture
type: definition
tags:
  - inspector
  - golden
---
The inspector's output contract in one module that imports nothing but Lean's
own `Init`, so it builds under every admitted environment with no mathlib in
sight. Between them the declarations below exercise every part of the report:
the `---` frontmatter grammar and its leading-dash stripping, a structure's
generated internal-detail names, a matcher (so `Match.Extension` entries are
read back), a private name, realized reserved names, a non-trivial axiom
closure, a pretty-printed axiom signature, and `conclusionFacts`.
-/

/-- A structure, so the module persists generated projections, `casesOn`,
`noConfusion` and `injEq` — the internal-detail names `userLevelName?` hides. -/
structure Point where
  x : Nat
  y : Nat

/-- A pattern match, so the module persists a `Match.Extension` entry
(`classify.match_1`) for `matcherNamesOf` to read back inertly. -/
def classify : Nat → String
  | 0 => "zero"
  | _ + 1 => "succ"

/-- Rewriting with the definition realizes its reserved equation names beside
it, which the reserved-name predicates must keep out of the user-level set. -/
theorem classify_zero : classify 0 = "zero" := by simp [classify]

private def hidden : Nat := 7

theorem hidden_eq : hidden = 7 := rfl

/-- Excluded middle, so this declaration's axiom closure is exactly the
archive's background triple rather than empty. -/
theorem golden_em (p : Prop) : p ∨ ¬p := Classical.em p

/-- A declared axiom, whose signature the inspector pretty-prints with core
notation only (delaborators are imported code and never run here). -/
axiom goldenAxiom : ∀ n : Nat, n + 0 = n

/--
---
conclusion: goldenAxiom
---
A frontmatter block on a declaration, so the report carries `conclusionFacts`
for a conclusion that resolves, is an axiom, sits in a reachable module, and is
definitionally equal to this statement's type.
-/
theorem golden_conclusion : ∀ n : Nat, n + 0 = n := fun _ => rfl
