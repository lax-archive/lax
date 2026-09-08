import Lax68.GridsAndWalls
import Lax68.Planar

/-!
---
title: Grids are planar
type: theorem
---
Every grid graph is planar.
-/

set_option autoImplicit false

namespace Lax68.GridPlanar

axiom grid_planar {V : Type*} [Fintype V] {G : SimpleGraph V} :
  Lax68.GridsAndWalls.IsGrid G →
  Lax68.Planar.IsPlanar G

end Lax68.GridPlanar
