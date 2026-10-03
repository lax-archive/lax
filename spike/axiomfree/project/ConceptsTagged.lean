-- Header-less concept file with the decision-4 marker: two statements tagged,
-- one `Prop` definition left untagged (an auxiliary).
import LaxCore
import Mathlib.Data.Nat.Prime.Defs

namespace ConceptsTagged

/-- Every natural number above one has a prime divisor. -/
@[lax_statement] def ExistsPrimeDivisor : Prop := ∀ n : ℕ, 1 < n → ∃ p, Nat.Prime p ∧ p ∣ n

/-- There are infinitely many primes. -/
@[lax_statement] def InfinitelyManyPrimes : Prop := ∀ n : ℕ, ∃ p, Nat.Prime p ∧ n < p

/-- Untagged: an auxiliary `Prop`, never an edge endpoint. -/
def Auxiliary : Prop := ∀ n : ℕ, n = n

end ConceptsTagged
