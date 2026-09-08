import Mathlib.Combinatorics.SimpleGraph.UniversalVerts

/-!
---
title: Stars
type: definition
---
A star has a centre adjacent to every other vertex and has no edges between
two non-central vertices.
-/

set_option autoImplicit false

namespace Lax68.Stars

def HasStarShape {V : Type*} (G : SimpleGraph V) : Prop :=
  ∃ centre : V,
    centre ∈ G.universalVerts ∧
    ∀ ⦃u v⦄, G.Adj u v → u = centre ∨ v = centre

def IsStar {V : Type*} (G : SimpleGraph V) : Prop :=
  HasStarShape G

end Lax68.Stars
