import Lax68.Outerplanar
import Lax68.Planar

/-!
---
title: Outerplanar graphs are planar
type: theorem
---
Every outerplanar graph is planar.
-/

set_option autoImplicit false

namespace Lax68.OuterplanarPlanar

axiom outerplanar_planar {V : Type*} [Fintype V] {G : SimpleGraph V} :
  Lax68.Outerplanar.IsOuterplanar G →
  Lax68.Planar.IsPlanar G

end Lax68.OuterplanarPlanar
