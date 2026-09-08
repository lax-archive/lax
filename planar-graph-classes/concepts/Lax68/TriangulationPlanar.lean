import Lax68.Triangulations
import Lax68.Planar

/-!
---
title: Triangulations of planar graphs are planar
type: theorem
---
If T is a triangulation of a planar graph G, then T is planar.
-/

set_option autoImplicit false

namespace Lax68.TriangulationPlanar

axiom triangulationOf_planar {V : Type*}
    {G T : SimpleGraph V} :
  Lax68.Planar.IsPlanar G →
  Lax68.Triangulations.IsTriangulationOf G T →
  Lax68.Planar.IsPlanar T

end Lax68.TriangulationPlanar
