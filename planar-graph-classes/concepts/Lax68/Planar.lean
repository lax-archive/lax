import Lax68.StraightLineDrawings

/-!
---
title: Planar graphs
type: definition
---
A graph is planar when it can be drawn in the plane without crossings. The
formal certificate is a straight-line drawing from the separate
`Straight-line graph drawings` concept; for finite simple graphs this is
equivalent to the usual topological definition by Fáry's theorem.
-/

set_option autoImplicit false

namespace Lax68.Planar

def IsPlanar {V : Type*} (G : SimpleGraph V) : Prop :=
  StraightLineDrawings.HasStraightLineDrawing G

end Lax68.Planar
