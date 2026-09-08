import Lax68.Trees
import Lax68.Outerplanar

/-!
---
title: Trees are outerplanar
type: theorem
---
Every tree is outerplanar.
-/

set_option autoImplicit false

namespace Lax68.TreeOuterplanar

axiom tree_outerplanar {V : Type*} [Fintype V] {G : SimpleGraph V} :
  Lax68.Trees.IsTree G →
  Lax68.Outerplanar.IsOuterplanar G

end Lax68.TreeOuterplanar
