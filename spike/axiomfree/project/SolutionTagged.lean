import ProofsTagged

theorem CertTagged.pa : ConceptsTagged.ExistsPrimeDivisor := ProofsTagged.pa

theorem CertTagged.pf (h : ConceptsTagged.ExistsPrimeDivisor) : ConceptsTagged.InfinitelyManyPrimes := ProofsTagged.pf h
