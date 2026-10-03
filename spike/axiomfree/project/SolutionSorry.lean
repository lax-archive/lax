module


public import Proofs

/-! Negative test (b): a solution resting on `sorry`. -/

public section

theorem Cert.pa : Concepts.ExistsPrimeDivisor := sorry

theorem Cert.pf (h : Concepts.ExistsPrimeDivisor) : Concepts.InfinitelyManyPrimes := Proofs.pf h

end
