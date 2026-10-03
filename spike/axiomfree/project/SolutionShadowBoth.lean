module


public import Concepts
public import ConceptsShadow

/-! Negative test (c'): importing both the real and the shadowing concepts. -/

public section

theorem Cert.pa : Concepts.ExistsPrimeDivisor := trivial

theorem Cert.pf (h : Concepts.ExistsPrimeDivisor) : Concepts.InfinitelyManyPrimes := trivial

end
