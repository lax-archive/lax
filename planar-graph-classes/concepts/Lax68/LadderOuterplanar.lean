import Lax68.Ladders
import Lax68.Outerplanar

/-!
---
title: Ladders are outerplanar
type: theorem
---
Every ladder graph is outerplanar.
-/

set_option autoImplicit false

namespace Lax68.LadderOuterplanar

axiom ladder_outerplanar {V : Type*} {G : SimpleGraph V} :
  Lax68.Ladders.IsLadder G →
  Lax68.Outerplanar.IsOuterplanar G

end Lax68.LadderOuterplanar
