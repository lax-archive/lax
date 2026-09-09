import Lax68.GraphTopologicalMinors
import Lax68.Planar

/-!
---
title: Kuratowski's theorem in straight-line form
type: theorem
---
A finite simple graph admits a crossing-free straight-line drawing exactly
when it contains no subdivision of *K₅* or *K₃,₃*. This is Kuratowski's
theorem together with Fáry's straight-line drawing theorem.
-/

set_option autoImplicit false

namespace Lax68.KuratowskiPlanarity

axiom planar_iff_kuratowskiFree
    {V : Type*} {G : SimpleGraph V} :
  Finite V →
  (Lax68.Planar.IsPlanar G ↔
    Lax68.GraphTopologicalMinors.IsKuratowskiFree G)

end Lax68.KuratowskiPlanarity
