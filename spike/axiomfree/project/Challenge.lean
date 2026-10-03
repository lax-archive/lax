module


public import Concepts

/-! The certificate: imports only the concepts, states what the proof package claims. -/

public section

theorem Cert.pa : Concepts.ExistsPrimeDivisor := sorry

theorem Cert.pf (h : Concepts.ExistsPrimeDivisor) : Concepts.InfinitelyManyPrimes := sorry

end
