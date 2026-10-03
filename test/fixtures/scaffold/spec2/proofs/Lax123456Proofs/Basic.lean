import Lax123456.Basic

/-
A proof is a theorem whose type is a chain of statements: the hypotheses,
then the conclusion. Without hypotheses it proves its statement outright;
with them it is the edge {hypotheses} → conclusion of the proof network.
Any other theorem is a helper. Nothing here declares an axiom.
-/

namespace Lax123456Proofs

/-- `AddZero`, outright. -/
theorem addZero : Lax123456.Basic.AddZero := fun n => Nat.add_zero n

/-- `ZeroAddZero`, assuming `AddZero`. -/
theorem zeroAddZero (h : Lax123456.Basic.AddZero) : Lax123456.Basic.ZeroAddZero := h 0

/-
Several proofs sharing hypotheses: declare them once with `variable` and
`include` them where they are used, so each theorem's type stays a chain of
statements in the order the variables were declared.

  variable (hAddZero : Lax123456.Basic.AddZero)

  include hAddZero in
  theorem zeroAddZero' : Lax123456.Basic.ZeroAddZero := hAddZero 0
-/

end Lax123456Proofs
