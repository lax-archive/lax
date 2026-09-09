import Lax68.GraphTopologicalMinors

/-!
---
title: A K₃,₃ minor yields a K₃,₃ subdivision
type: theorem
---
Because *K₃,₃* is cubic, every minor model of it contains a subdivision model.
-/

set_option autoImplicit false

namespace Lax68.K33MinorTopologicalObstruction

axiom k33Minor_topologicalMinor
    {V : Type*} {G : SimpleGraph V} :
  Lax68.GraphMinors.IsMinor Lax68.GraphMinors.K33 G →
    Lax68.GraphTopologicalMinors.IsTopologicalMinor
      Lax68.GraphMinors.K33 G

end Lax68.K33MinorTopologicalObstruction
