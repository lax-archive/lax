module


public import ConceptsShadow

/-! Negative test (c): discharges the certificate against the shadowed concepts. -/

public section

theorem Cert.pa : Concepts.ExistsPrimeDivisor := trivial

theorem Cert.pf (h : Concepts.ExistsPrimeDivisor) : Concepts.InfinitelyManyPrimes := trivial

end
