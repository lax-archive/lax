import Lax68.GraphTopologicalMinors

/-!
---
title: Every topological minor is a minor
type: theorem
---
A subdivision model can be converted into a minor model by assigning every
internal route vertex to one of the route's endpoints.
-/

set_option autoImplicit false

namespace Lax68.TopologicalMinorIsMinor

axiom isMinor_of_isTopologicalMinor
    {W V : Type*} {H : SimpleGraph W} {G : SimpleGraph V}
    [LinearOrder W] :
  Lax68.GraphTopologicalMinors.IsTopologicalMinor H G →
    Lax68.GraphMinors.IsMinor H G

end Lax68.TopologicalMinorIsMinor
