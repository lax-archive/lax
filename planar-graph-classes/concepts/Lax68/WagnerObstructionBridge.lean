import Lax68.GraphTopologicalMinors
import Lax68.Planar

/-!
---
title: The Kuratowski-Wagner obstruction bridge
type: theorem
---
A graph contains a subdivision of *K₅* or *K₃,₃* exactly when it contains
*K₅* or *K₃,₃* as a minor. This special equivalence does not hold for
arbitrary forbidden graphs.
-/

set_option autoImplicit false

namespace Lax68.WagnerObstructionBridge

axiom kuratowskiFree_iff_excludedMinors
    {V : Type*} {G : SimpleGraph V} :
  Lax68.GraphTopologicalMinors.IsKuratowskiFree G ↔
    Lax68.Planar.IsPlanarByExcludedMinors G

end Lax68.WagnerObstructionBridge
