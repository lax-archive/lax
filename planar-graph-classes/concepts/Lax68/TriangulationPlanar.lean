import Lax68.Triangulations
import Lax68.Planar

/-!
---
title: Triangulations are planar
type: theorem
---
Every triangulation is planar.
-/

set_option autoImplicit false

namespace Lax68.TriangulationPlanar

axiom triangulation_planar {V : Type*} {G : SimpleGraph V} :
  Lax68.Triangulations.IsTriangulation G →
  Lax68.Planar.IsPlanar G

end Lax68.TriangulationPlanar
