import Lax68.Triangles
import Lax68.Outerplanar

/-!
---
title: Triangles are outerplanar
type: theorem
---
Every triangle is outerplanar.
-/

set_option autoImplicit false

namespace Lax68.TriangleOuterplanar

axiom triangle_outerplanar
    {V : Type*} {G : SimpleGraph V} :
  Lax68.Triangles.IsTriangle G →
  Lax68.Outerplanar.IsOuterplanar G

end Lax68.TriangleOuterplanar
