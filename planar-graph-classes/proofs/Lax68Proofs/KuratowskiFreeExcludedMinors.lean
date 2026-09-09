import Lax68.K33MinorTopologicalObstruction
import Lax68.K5MinorTopologicalObstruction
import Lax68.KuratowskiFreeExcludedMinors

set_option autoImplicit false

namespace Lax68Proofs

/--
---
conclusion: Lax68.KuratowskiFreeExcludedMinors.kuratowskiFree_excludedMinors
assumptions:
  - Lax68.K5MinorTopologicalObstruction.k5Minor_topologicalObstruction
  - Lax68.K33MinorTopologicalObstruction.k33Minor_topologicalMinor
---
A forbidden minor would produce one of the two forbidden subdivisions,
contradicting Kuratowski-freeness.
-/
theorem kuratowskiFree_excludedMinors
    {V : Type*} {G : SimpleGraph V} :
  Lax68.GraphTopologicalMinors.IsKuratowskiFree G →
    Lax68.Planar.IsPlanarByExcludedMinors G := by
  intro hfree
  constructor
  · intro hk5
    rcases
      Lax68.K5MinorTopologicalObstruction.k5Minor_topologicalObstruction hk5
        with htk5 | htk33
    · exact hfree.1 htk5
    · exact hfree.2 htk33
  · intro hk33
    exact hfree.2
      (Lax68.K33MinorTopologicalObstruction.k33Minor_topologicalMinor hk33)

end Lax68Proofs
