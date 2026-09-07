import Lax68.Planar

/-!
---
title: Outerplanar graphs
type: definition
---
An outerplanar graph has a plane drawing in which every vertex lies on the
boundary of the outer face.  A crossing-free straight-line drawing with all
vertices on one circle is used as an equivalent certificate.
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

def IsOuterplanar {V : Type*} (G : SimpleGraph V) : Prop :=
  Nonempty (OuterplaneDrawing G)

end Lax68.Outerplanar
