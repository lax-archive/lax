import Lax68.Planar

/-!
---
title: Triangulations
type: definition
---
A finite triangulation is a planar graph on at least three vertices to which no
edge can be added while preserving planarity; equivalently, every face of a
plane embedding is bounded by a triangle.
-/

set_option autoImplicit false

namespace Lax68.Triangulations

def IsTriangulation {V : Type*} [Fintype V]
    (G : SimpleGraph V) : Prop :=
  3 ≤ Fintype.card V ∧
    Planar.IsPlanar G ∧
    ∀ H : SimpleGraph V,
      G < H →
      ¬ Planar.IsPlanar H

end Lax68.Triangulations
