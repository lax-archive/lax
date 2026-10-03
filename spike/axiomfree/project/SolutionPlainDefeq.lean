-- Negative: the conclusion is the *unfolded* statement (defeq, not syntactically equal).
import ProofsPlain

theorem CertPlain.pa : ConceptsPlain.ExistsPrimeDivisor := ProofsPlain.pa

theorem CertPlain.pf (h : ConceptsPlain.ExistsPrimeDivisor) : ∀ n : ℕ, ∃ p, Nat.Prime p ∧ n < p := ProofsPlain.pf h
