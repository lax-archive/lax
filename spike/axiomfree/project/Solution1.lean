module

public import Concepts1
import Mathlib.Data.Nat.Prime.Infinite

public section

theorem Cert1.e : type_of% Concepts1.AxStmt := fun n => by
  obtain ⟨p, hle, hp⟩ := Nat.exists_infinite_primes (n + 1)
  exact ⟨p, hp, by omega⟩

end
