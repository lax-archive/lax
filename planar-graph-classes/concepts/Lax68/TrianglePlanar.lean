import Lax68.Triangles
import Lax68.Planar

/-!
---
title: Triangles are planar
type: theorem
---
Every triangle is planar.
-/

set_option autoImplicit false

namespace Lax68.TrianglePlanar

axiom triangle_planar
    {V : Type*} {G : SimpleGraph V} :
  Lax68.Triangles.IsTriangle G →
  Lax68.Planar.IsPlanar G

end Lax68.TrianglePlanar
