import Lax68.Planar

/-!
---
title: Triangulations
type: definition
---
A planar triangulation is represented by its equivalent maximal-planar
characterization: it is planar, and no edge can be added between existing
vertices while preserving planarity.  For finite simple graphs with at least
three vertices this is equivalent to every face being a triangle.
-/

set_option autoImplicit false

namespace Lax68.Triangulations

def IsTriangulation {V : Type*} (G : SimpleGraph V) : Prop :=
  Planar.IsPlanar G ∧
    ∀ H : SimpleGraph V,
      G < H →
      ¬ Planar.IsPlanar H

end Lax68.Triangulations
