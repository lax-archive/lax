import Lax68.Planar

/-!
---
title: Wagner's theorem
type: theorem
---
For every finite simple graph, admitting a crossing-free drawing is equivalent
to containing neither *K₅* nor *K₃,₃* as a minor.
-/

set_option autoImplicit false

namespace Lax68.PlanarExcludedMinors

axiom planar_iff_excludedMinors
    {V : Type*} {G : SimpleGraph V} :
  Finite V →
  (Lax68.Planar.IsPlanar G ↔
    Lax68.Planar.IsPlanarByExcludedMinors G)

end Lax68.PlanarExcludedMinors
