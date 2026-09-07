import Lax68.Ladders
import Lax68.GridsAndWalls

/-!
---
title: Ladders are grids
type: theorem
---
Every ladder graph is a two-row grid.
-/

set_option autoImplicit false

namespace Lax68.LadderGrid

axiom ladder_grid {V : Type*} {G : SimpleGraph V} :
  Lax68.Ladders.IsLadder G →
  Lax68.GridsAndWalls.IsGrid G

end Lax68.LadderGrid
