import Lax68.HalinGraphs
import Lax68.Planar

/-!
---
title: Halin graphs are planar
type: theorem
---
Every Halin graph is planar.
-/

set_option autoImplicit false

namespace Lax68.HalinPlanar

axiom halin_planar
    {V : Type*} [Fintype V] {G : SimpleGraph V} :
  Lax68.HalinGraphs.IsHalin G →
  Lax68.Planar.IsPlanar G

end Lax68.HalinPlanar
