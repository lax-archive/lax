module


public import Proofs

/-! Negative test (a): the conclusion is the *unfolded* statement, definitionally
but not syntactically equal to `Concepts.InfinitelyManyPrimes`. -/

public section

theorem Cert.pa : Concepts.ExistsPrimeDivisor := Proofs.pa

theorem Cert.pf (h : Concepts.ExistsPrimeDivisor) : ∀ n : ℕ, ∃ p, Nat.Prime p ∧ n < p := Proofs.pf h

end
