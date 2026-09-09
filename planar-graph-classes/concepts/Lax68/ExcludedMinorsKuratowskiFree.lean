import Lax68.GraphTopologicalMinors
import Lax68.Planar
import Lax68.TopologicalMinorIsMinor

/-!
---
title: Excluding the two minors excludes their subdivisions
type: theorem
---
If a graph has neither *K₅* nor *K₃,₃* as a minor, then it has neither as a
topological minor.
-/

set_option autoImplicit false

namespace Lax68.ExcludedMinorsKuratowskiFree

axiom excludedMinors_kuratowskiFree
    {V : Type*} {G : SimpleGraph V} :
  Lax68.Planar.IsPlanarByExcludedMinors G →
    Lax68.GraphTopologicalMinors.IsKuratowskiFree G

end Lax68.ExcludedMinorsKuratowskiFree
