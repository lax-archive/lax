import Lax68.Trees
import Lax68.Planar

/-!
---
title: Trees are planar
type: theorem
---
Every tree is planar.
-/

set_option autoImplicit false

namespace Lax68.TreePlanar

axiom tree_planar {V : Type*} [Fintype V] {G : SimpleGraph V} :
  Lax68.Trees.IsTree G →
  Lax68.Planar.IsPlanar G

end Lax68.TreePlanar
