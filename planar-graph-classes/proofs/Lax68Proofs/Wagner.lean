import Lax68.KuratowskiPlanarity
import Lax68.PlanarExcludedMinors
import Lax68.WagnerObstructionBridge

set_option autoImplicit false

namespace Lax68Proofs

/--
---
conclusion: Lax68.PlanarExcludedMinors.planar_iff_excludedMinors
assumptions:
  - Lax68.KuratowskiPlanarity.planar_iff_kuratowskiFree
  - Lax68.WagnerObstructionBridge.kuratowskiFree_iff_excludedMinors
---
Kuratowski's theorem characterizes finite planar graphs by the absence of the
two topological obstructions. The Kuratowski-Wagner bridge identifies those
topological obstructions with the corresponding minor obstructions.
-/
theorem planar_iff_excludedMinors
    {V : Type*} {G : SimpleGraph V} :
  Finite V →
  (Lax68.Planar.IsPlanar G ↔
    Lax68.Planar.IsPlanarByExcludedMinors G) := by
  intro hV
  exact
    (Lax68.KuratowskiPlanarity.planar_iff_kuratowskiFree hV).trans
      Lax68.WagnerObstructionBridge.kuratowskiFree_iff_excludedMinors

end Lax68Proofs
