-- A file without a `module` header, importing mathlib the legacy way.
import Mathlib.Data.Nat.Prime.Defs

def NoHeader.claim : Prop := ∀ n : ℕ, 1 < n → ∃ p, Nat.Prime p ∧ p ∣ n

theorem NoHeader.trivialThm : True := trivial
