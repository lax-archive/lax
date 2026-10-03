-- Header-less solution: imports the proof package, discharges the certificate.
import ProofsPlain

theorem CertPlain.pa : ConceptsPlain.ExistsPrimeDivisor := ProofsPlain.pa

theorem CertPlain.pf (h : ConceptsPlain.ExistsPrimeDivisor) : ConceptsPlain.InfinitelyManyPrimes := ProofsPlain.pf h
