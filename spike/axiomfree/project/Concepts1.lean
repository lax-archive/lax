module


public import Mathlib.Data.Nat.Prime.Defs

/-! Spec-1 style concept: the claim is an axiom. -/

namespace Concepts1

public axiom AxStmt : ∀ n : ℕ, ∃ p, Nat.Prime p ∧ n < p

end Concepts1
