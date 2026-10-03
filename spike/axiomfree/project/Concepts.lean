module


public import Mathlib.Data.Nat.Prime.Defs

/-! Spec-2 style concepts: a claim is a `Prop`-valued definition. -/

namespace Concepts

/-- Every natural number above one has a prime divisor. -/
@[expose] public def ExistsPrimeDivisor : Prop := ∀ n : ℕ, 1 < n → ∃ p, Nat.Prime p ∧ p ∣ n

/-- There are infinitely many primes. -/
@[expose] public def InfinitelyManyPrimes : Prop := ∀ n : ℕ, ∃ p, Nat.Prime p ∧ n < p

end Concepts
