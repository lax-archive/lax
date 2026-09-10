import Mathlib.Combinatorics.SimpleGraph.Acyclic
import Lax68.ThreeFans

/-!
---
title: Three vertices in a connected graph have a three-fan
type: theorem
---
For any three vertices of a connected graph, there is a center with three
paths to the vertices that meet pairwise only at the center.
-/

set_option autoImplicit false

namespace Lax68.ConnectedThreeFan

universe u

axiom exists_threeFan
    {V : Type u} {G : SimpleGraph V} :
  G.Connected →
    ∀ a b c : V, Lax68.ThreeFans.HasThreeFan G a b c

end Lax68.ConnectedThreeFan
