import Mathlib.Combinatorics.SimpleGraph.UniversalVerts
import Lax68.Trees

/-!
---
title: Stars
type: definition
---
A star has a centre adjacent to every other vertex and no other edges.  Its
tree certificate is recorded explicitly.
-/

set_option autoImplicit false

namespace Lax68.Stars

def HasStarShape {V : Type*} (G : SimpleGraph V) : Prop :=
  ∃ centre : V,
    centre ∈ G.universalVerts ∧
    ∀ ⦃u v⦄, G.Adj u v → u = centre ∨ v = centre

def IsStar {V : Type*} (G : SimpleGraph V) : Prop :=
  HasStarShape G ∧
    Trees.IsTree G

end Lax68.Stars
