-- Stage 0, decision 7: a header-less concept file (spec-1 style imports,
-- no `module`, no `public`, no `@[expose]`). Statements are plain `def X : Prop`.
import Mathlib.Data.Nat.Prime.Defs

namespace ConceptsPlain

/-- Every natural number above one has a prime divisor. -/
def ExistsPrimeDivisor : Prop := ∀ n : ℕ, 1 < n → ∃ p, Nat.Prime p ∧ p ∣ n

/-- There are infinitely many primes. -/
def InfinitelyManyPrimes : Prop := ∀ n : ℕ, ∃ p, Nat.Prime p ∧ n < p

end ConceptsPlain
