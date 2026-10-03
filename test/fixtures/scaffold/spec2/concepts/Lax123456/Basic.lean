import LaxCore

/-!
---
title: Example statements
type: theorem
---
Two statements in the shape this environment reads: a `def` of type `Prop`
carrying `@[lax_statement]`, with no binders — parameters go inside with `∀`.
A `Prop` definition without the attribute is an auxiliary, never a statement.
Replace both with yours.
-/

namespace Lax123456.Basic

/-- Adding zero changes nothing. -/
@[lax_statement] def AddZero : Prop := ∀ n : Nat, n + 0 = n

/-- A special case of `AddZero`. -/
@[lax_statement] def ZeroAddZero : Prop := 0 + 0 = 0

end Lax123456.Basic
