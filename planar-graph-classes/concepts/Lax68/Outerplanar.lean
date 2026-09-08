import Lax68.StraightLineDrawings

/-!
---
title: Outerplanar graphs
type: definition
---
A graph is outerplanar here when it has a crossing-free straight-line drawing
with every vertex on one circle, a compact certificate for having every
vertex on the boundary of the outer face.
-/

set_option autoImplicit false

namespace Lax68.Outerplanar

structure OuterplaneDrawing {V : Type*} (G : SimpleGraph V)
    extends StraightLineDrawings.StraightLineDrawing G where
  radius : ℝ
  radius_pos : 0 < radius
  onBoundary :
    ∀ v : V,
      let p := toStraightLineDrawing.point v
      p.1 ^ 2 + p.2 ^ 2 = radius ^ 2

def IsOuterplanar {V : Type*} (G : SimpleGraph V) : Prop :=
  Nonempty (OuterplaneDrawing G)

end Lax68.Outerplanar
