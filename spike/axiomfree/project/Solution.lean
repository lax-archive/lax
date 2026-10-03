module


public import Proofs

/-! The solution: imports the proof package and discharges the certificate. -/

public section

theorem Cert.pa : Concepts.ExistsPrimeDivisor := Proofs.pa

theorem Cert.pf (h : Concepts.ExistsPrimeDivisor) : Concepts.InfinitelyManyPrimes := Proofs.pf h

end
