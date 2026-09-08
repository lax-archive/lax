import Mathlib.Combinatorics.SimpleGraph.Acyclic

/-!
---
title: Trees
type: definition
---
A finite tree is a connected acyclic simple graph, using mathlib's native
`SimpleGraph.IsTree` predicate.
-/

set_option autoImplicit false

namespace Lax68.Trees

def IsTree {V : Type*} [Fintype V] (G : SimpleGraph V) : Prop :=
  G.IsTree

end Lax68.Trees
