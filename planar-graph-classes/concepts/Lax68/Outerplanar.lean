import Lax68.Planar

/-!
---
title: Outerplanar graphs
type: definition
---
A finite graph is outerplanar when it has a crossing-free plane drawing in
which every vertex lies on the boundary of the outer face. We use the
equivalent certificate of a straight-line drawing with every vertex on one
circle.
-/

set_option autoImplicit false

namespace Lax68.Outerplanar

structure OuterplaneDrawing {V : Type*} (G : SimpleGraph V)
    extends Planar.StraightLineDrawing G where
  radius : ℝ
  radius_pos : 0 < radius
  onBoundary :
    ∀ v : V,
      let p := toStraightLineDrawing.point v
      p.1 ^ 2 + p.2 ^ 2 = radius ^ 2

def IsOuterplanar {V : Type*} [Fintype V] (G : SimpleGraph V) : Prop :=
  Nonempty (OuterplaneDrawing G)

end Lax68.Outerplanar
