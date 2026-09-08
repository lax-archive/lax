import Lax68.GridsAndWalls
import Lax68.Planar

/-!
---
title: Walls are planar
type: theorem
---
Every wall graph is planar.
-/

set_option autoImplicit false

namespace Lax68.WallPlanar

axiom wall_planar {V : Type*} [Fintype V] {G : SimpleGraph V} :
  Lax68.GridsAndWalls.IsWall G →
  Lax68.Planar.IsPlanar G

end Lax68.WallPlanar
