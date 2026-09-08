import Lax68.Stars
import Lax68.Planar

/-!
---
title: Stars are planar
type: theorem
---
Every star graph is planar.
-/

set_option autoImplicit false

namespace Lax68.StarPlanar

axiom star_planar {V : Type*} [Fintype V] {G : SimpleGraph V} :
  Lax68.Stars.IsStar G →
  Lax68.Planar.IsPlanar G

end Lax68.StarPlanar
