import Mathlib.Combinatorics.SimpleGraph.UniversalVerts
import Lax0.HalinGraphs

/-!
---
title: Wheels
type: definition
---
A wheel consists of a cycle together with one hub adjacent to every vertex of
the cycle.  Its Halin certificate records the equivalent construction from a
star whose leaves are joined cyclically.
-/

set_option autoImplicit false

namespace Lax0.Wheels

def HasWheelShape {V : Type*} [Fintype V] (G : SimpleGraph V) : Prop :=
  ∃ hub : V,
    hub ∈ G.universalVerts ∧
    ∃ rim : SimpleGraph V,
      HalinGraphs.IsCycleOn rim {v | v ≠ hub} ∧
      ∀ ⦃u v⦄,
        u ≠ hub →
        v ≠ hub →
        (G.Adj u v ↔ rim.Adj u v)

def IsWheel {V : Type*} [Fintype V] (G : SimpleGraph V) : Prop :=
  HasWheelShape G ∧ HalinGraphs.IsHalin G

end Lax0.Wheels
