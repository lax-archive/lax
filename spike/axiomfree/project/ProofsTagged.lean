import ConceptsTagged
import Mathlib.Data.Nat.Prime.Basic
import Mathlib.Data.Nat.Factorial.Basic

namespace ProofsTagged

theorem one_lt_factorial_succ (n : ℕ) : 1 < n.factorial + 1 := by
  have := Nat.factorial_pos n
  omega

theorem prime_dvd_factorial_succ_gt {n p : ℕ} (hp : Nat.Prime p) (hd : p ∣ n.factorial + 1) :
    n < p := by
  by_contra hle
  push Not at hle
  have h1 : p ∣ n.factorial := Nat.dvd_factorial hp.pos hle
  have h2 : p ∣ 1 := (Nat.dvd_add_right h1).mp hd
  exact hp.one_lt.ne' (Nat.dvd_one.mp h2)

theorem pa : ConceptsTagged.ExistsPrimeDivisor := fun n hn =>
  Nat.exists_prime_and_dvd (by omega)

theorem pf (h : ConceptsTagged.ExistsPrimeDivisor) : ConceptsTagged.InfinitelyManyPrimes := fun n => by
  obtain ⟨p, hp, hd⟩ := h (n.factorial + 1) (one_lt_factorial_succ n)
  exact ⟨p, hp, prime_dvd_factorial_succ_gt hp hd⟩

end ProofsTagged
