import Mathlib.Combinatorics.SimpleGraph.Hasse

/-!
---
title: Ladders
type: definition
---
A finite ladder is a nonempty two-row grid: two paths joined by corresponding
rungs.
-/

set_option autoImplicit false

namespace Lax68.Ladders

def HasLadderShape {V : Type*} (G : SimpleGraph V) : Prop :=
  ∃ n : ℕ,
    0 < n ∧
    Nonempty
      (G ≃g (SimpleGraph.pathGraph n □ SimpleGraph.pathGraph 2))

def IsLadder {V : Type*} [Fintype V] (G : SimpleGraph V) : Prop :=
  HasLadderShape G

end Lax68.Ladders
