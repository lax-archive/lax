import Lax68.MaximalOuterplanar
import Lax68.Planar

/-!
---
title: Maximal outerplanar graphs are planar
type: theorem
---
Every maximal outerplanar graph is planar.
-/

set_option autoImplicit false

namespace Lax68.MaximalOuterplanarPlanar

axiom maximalOuterplanar_planar {V : Type*} [Fintype V] {G : SimpleGraph V} :
  Lax68.MaximalOuterplanar.IsMaximalOuterplanar G →
  Lax68.Planar.IsPlanar G

end Lax68.MaximalOuterplanarPlanar
