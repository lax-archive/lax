module

public import Mathlib.Data.Nat.Prime.Defs

namespace ModTest

/-- Not `public`: is it visible to importers at all? -/
def hiddenDef : Prop := ∀ n : ℕ, n = n

/-- Not `public`: can a solution module reference it? -/
theorem hiddenThm : hiddenDef := fun _ => rfl

public def pubDef : Prop := ∀ n : ℕ, n = n

/-- `public` theorem referencing a non-public def in its type. -/
public theorem pubThmOverPub : pubDef := fun _ => rfl

end ModTest

namespace ModTest

/-- `public` but not `@[expose]`: can an importer unfold it? -/
public def notExposed : Prop := ∀ n : ℕ, n = n

/-- `public abbrev`: exposed by default? -/
public abbrev abbrevDef : Prop := ∀ n : ℕ, n = n

/-- `@[expose] public def`: the shape `Concepts.lean` ended up needing. -/
@[expose] public def exposedDef : Prop := ∀ n : ℕ, n = n

end ModTest
