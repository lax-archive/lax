import Lax68.ExcludedMinorsKuratowskiFree
import Lax68.KuratowskiFreeExcludedMinors
import Lax68.WagnerObstructionBridge

set_option autoImplicit false

namespace Lax68Proofs

/--
---
conclusion: Lax68.WagnerObstructionBridge.kuratowskiFree_iff_excludedMinors
assumptions:
  - Lax68.ExcludedMinorsKuratowskiFree.excludedMinors_kuratowskiFree
  - Lax68.KuratowskiFreeExcludedMinors.kuratowskiFree_excludedMinors
---
The two implications combine to identify the Kuratowski and minor obstruction
formulations.
-/
theorem kuratowskiFree_iff_excludedMinors
    {V : Type*} {G : SimpleGraph V} :
  Lax68.GraphTopologicalMinors.IsKuratowskiFree G ↔
    Lax68.Planar.IsPlanarByExcludedMinors G := by
  constructor
  · exact
      Lax68.KuratowskiFreeExcludedMinors.kuratowskiFree_excludedMinors
  · exact
      Lax68.ExcludedMinorsKuratowskiFree.excludedMinors_kuratowskiFree

end Lax68Proofs
