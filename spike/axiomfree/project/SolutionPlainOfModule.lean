-- A header-less Solution importing the `module`-style proof package `Proofs`.
import Proofs

theorem CertMixed.pa : Concepts.ExistsPrimeDivisor := Proofs.pa

theorem CertMixed.pf (h : Concepts.ExistsPrimeDivisor) : Concepts.InfinitelyManyPrimes := Proofs.pf h
