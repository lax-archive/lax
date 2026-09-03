import Mathlib.Combinatorics.SimpleGraph.Hasse
import Lax0.Trees

/-!
---
title: Paths
type: definition
---
A path graph is a graph isomorphic to the graph on a finite linear order whose
edges join consecutive elements.  Its tree certificate is recorded explicitly.
-/

set_option autoImplicit false

namespace Lax0.Paths

def IsPath {V : Type*} (G : SimpleGraph V) : Prop :=
  (∃ n : ℕ,
      Nonempty (G ≃g SimpleGraph.pathGraph n)) ∧
    Trees.IsTree G

end Lax0.Paths
