import Lax68.GraphTopologicalMinors
import Lax68.Planar

/-!
---
title: The two minor obstructions yield a Kuratowski subdivision
type: theorem
---
If a graph contains neither a subdivision of *K₅* nor one of *K₃,₃*, then it
contains neither *K₅* nor *K₃,₃* as a minor.
-/

set_option autoImplicit false

namespace Lax68.KuratowskiFreeExcludedMinors

axiom kuratowskiFree_excludedMinors
    {V : Type*} {G : SimpleGraph V} :
  Lax68.GraphTopologicalMinors.IsKuratowskiFree G →
    Lax68.Planar.IsPlanarByExcludedMinors G

end Lax68.KuratowskiFreeExcludedMinors
