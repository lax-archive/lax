import Lax68.GraphTopologicalMinors

/-!
---
title: A K₅ minor yields a Kuratowski subdivision
type: theorem
---
A *K₅* minor model contains either a subdivision of *K₅* or a subdivision of
*K₃,₃*.
-/

set_option autoImplicit false

namespace Lax68.K5MinorTopologicalObstruction

axiom k5Minor_topologicalObstruction
    {V : Type*} {G : SimpleGraph V} :
  Lax68.GraphMinors.IsMinor Lax68.GraphMinors.K5 G →
    (Lax68.GraphTopologicalMinors.IsTopologicalMinor
        Lax68.GraphMinors.K5 G ∨
      Lax68.GraphTopologicalMinors.IsTopologicalMinor
        Lax68.GraphMinors.K33 G)

end Lax68.K5MinorTopologicalObstruction
