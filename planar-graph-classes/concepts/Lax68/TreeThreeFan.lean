import Mathlib.Combinatorics.SimpleGraph.Acyclic
import Lax68.ThreeFans

/-!
---
title: Three vertices in a tree have a three-fan
type: theorem
---
For any three vertices of a tree, their three connecting branches meet at a
single center.
-/

set_option autoImplicit false

namespace Lax68.TreeThreeFan

universe u

axiom exists_threeFan
    {V : Type u} {G : SimpleGraph V} :
  G.IsTree →
    ∀ a b c : V, Lax68.ThreeFans.HasThreeFan G a b c

end Lax68.TreeThreeFan
