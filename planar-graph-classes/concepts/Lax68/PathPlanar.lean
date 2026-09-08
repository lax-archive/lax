import Lax68.Paths
import Lax68.Planar

/-!
---
title: Paths are planar
type: theorem
---
Every path graph is planar.
-/

set_option autoImplicit false

namespace Lax68.PathPlanar

axiom path_planar {V : Type*} [Fintype V] {G : SimpleGraph V} :
  Lax68.Paths.IsPath G →
  Lax68.Planar.IsPlanar G

end Lax68.PathPlanar
