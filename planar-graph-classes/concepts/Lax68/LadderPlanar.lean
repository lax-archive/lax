import Lax68.Ladders
import Lax68.Planar

/-!
---
title: Ladders are planar
type: theorem
---
Every ladder graph is planar.
-/

set_option autoImplicit false

namespace Lax68.LadderPlanar

axiom ladder_planar {V : Type*} [Fintype V] {G : SimpleGraph V} :
  Lax68.Ladders.IsLadder G →
  Lax68.Planar.IsPlanar G

end Lax68.LadderPlanar
