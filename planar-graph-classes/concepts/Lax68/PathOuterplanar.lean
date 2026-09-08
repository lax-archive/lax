import Lax68.Paths
import Lax68.Outerplanar

/-!
---
title: Paths are outerplanar
type: theorem
---
Every path graph is outerplanar.
-/

set_option autoImplicit false

namespace Lax68.PathOuterplanar

axiom path_outerplanar {V : Type*} {G : SimpleGraph V} :
  Lax68.Paths.IsPath G →
  Lax68.Outerplanar.IsOuterplanar G

end Lax68.PathOuterplanar
