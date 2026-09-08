import Lax68.Planar

/-!
---
title: Triangulations
type: definition
---
A triangulation of a finite graph G is a planar supergraph T on the same vertex
set, with at least three vertices, to which no edge can be added while
preserving planarity. For a plane embedding this is equivalent to every face
of T being bounded by a triangle.
-/

set_option autoImplicit false

namespace Lax68.Triangulations

def IsTriangulationOf {V : Type*} [Fintype V]
    (G T : SimpleGraph V) : Prop :=
  3 ≤ Fintype.card V ∧
    G ≤ T ∧
    Planar.IsPlanar T ∧
    ∀ H : SimpleGraph V,
      T < H →
      ¬ Planar.IsPlanar H

end Lax68.Triangulations
