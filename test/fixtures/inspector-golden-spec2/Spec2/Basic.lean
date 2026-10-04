import LaxCore

/-!
---
title: Spec-2 golden fixture
type: definition
---
The spec-2 facts of the inspector's report in one module: tagged definitions
of every shape the validator has to tell apart (closed `Prop`, universe
polymorphic, binders, `Type`-valued, a theorem, `private`), an untagged
auxiliary, and theorems whose stored types walk — or fail to walk — as a chain
of constants: every binder kind, duplicates, a self-edge, universe parameters,
a concrete level, a repeated level, a `max` level, a non-chain, an applied
constant, a definition of proof shape, a private theorem, a spec-1 frontmatter,
a declared axiom, and a `sorry`. The tag comes from the hook-less twin in
`LaxCore.lean`, so the shapes the real hook refuses are here as facts.
-/

namespace Spec2.Basic

/-- A closed proposition. -/
@[lax_statement] def Closed : Prop := ∀ n : Nat, n = n

/-- Universe-polymorphic. -/
@[lax_statement] def Poly.{u} : Prop := ∀ (α : Sort u) (a : α), a = a

/-- Two universe parameters, for the repeated-level case. -/
@[lax_statement] def Poly2.{u, v} : Prop := ∀ (_ : Sort u) (_ : Sort v), True

/-- Untagged: an auxiliary, never an edge endpoint. -/
def Auxiliary : Prop := True

/-- An implication between statements is a statement like any other. -/
@[lax_statement] def AimpC : Prop := Closed → Auxiliary

/-- Tagged with binders (the real hook refuses this). -/
@[lax_statement] def WithBinder (n : Nat) : Prop := n = n

/-- Tagged, `Type`-valued (refused by the real hook). -/
@[lax_statement] def TypeValued : Type := Nat

/-- Tagged theorem (refused by the real hook). -/
@[lax_statement] theorem TaggedTheorem : True := trivial

/-- Tagged and private (refused by the real hook; the olean still carries the tag). -/
@[lax_statement] private def Hidden : Prop := True

/-- A name Lean cannot read unquoted, with a universe parameter it cannot either:
the report writes both as Lean's escaped `Name.toString` prints them, which
reads back (`String.toName`), so neither is flagged; the validator refuses both
as an endpoint, being no archive name (contracts.ts LEAN_NAME_PATTERN). -/
@[lax_statement] def «定理».{«λ»} : Prop := ∀ (α : Sort «λ») (a : α), a = a

-- ## theorems

theorem unconditional : Closed := fun _ => rfl

theorem explicitHyp (_h : Closed) : AimpC := fun _ => trivial

theorem implicitHyp {h : Closed} : Closed := h

theorem strictHyp ⦃h : Closed⦄ : Closed := h

-- an instance binder over a statement needs the annotation check off
set_option checkBinderAnnotations false in
theorem instHyp [h : Closed] : Closed := h

theorem duplicateHyps (_h₁ : Closed) (_h₂ : Closed) : AimpC := fun _ => trivial

theorem selfEdge (h : Closed) : Closed := h

theorem polyProof.{w} (h : Poly.{w}) : Poly.{w} := h

theorem concreteLevel (_h : Poly.{0}) : Closed := fun _ => rfl

theorem repeatedLevels.{w} : Poly2.{w, w} := fun _ _ => trivial

theorem maxLevel.{a, b} : Poly.{max a b} := fun _ _ => rfl

theorem succLevel.{a} : Poly.{a + 1} := fun _ _ => rfl

theorem «证明».{«λ»} (_h : Closed) : «定理».{«λ»} := fun _ _ => rfl

theorem notAChain (n : Nat) : n = n := rfl

theorem appliedConst (h : id Closed) : Closed := h

def defOfProofShape (h : Closed) : Closed := h

private theorem privateProof (h : Closed) : Closed := h

/--
---
conclusion: Spec2.Basic.Closed
---
The spec-1 habit: a conclusion in the docstring.
-/
theorem spec1Habit : Closed := fun _ => rfl

axiom declaredAxiom : Closed

theorem usesSorry : Closed := sorry

/-- A name Lean prints unescaped (a trailing `_inaccessible`), so the printed
`Spec2.Basic.A.B._inaccessible` does not read back: flagged `nonCanonical`. -/
theorem «A.B»._inaccessible : True := trivial

/-- A `Prop` constant printed the same way, `Spec2.Basic.C.D._inaccessible`. -/
def «C.D»._inaccessible : Prop := True

/-- A theorem over it: the telescope's conclusion is flagged `nonCanonical`, so
the validator never reads its text as the name of a statement. -/
theorem overLookalike : «C.D»._inaccessible := trivial

end Spec2.Basic
