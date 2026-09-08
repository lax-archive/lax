import Mathlib.Combinatorics.SimpleGraph.Hasse

/-!
---
title: Paths
type: definition
---
A finite path graph is a graph isomorphic to the standard path graph on a
positive number of vertices.
-/

set_option autoImplicit false

namespace Lax68.Paths

def HasPathShape {V : Type*} (G : SimpleGraph V) : Prop :=
  ∃ n : ℕ,
    0 < n ∧
    Nonempty (G ≃g SimpleGraph.pathGraph n)

def IsPath {V : Type*} [Fintype V] (G : SimpleGraph V) : Prop :=
  HasPathShape G

end Lax68.Paths
