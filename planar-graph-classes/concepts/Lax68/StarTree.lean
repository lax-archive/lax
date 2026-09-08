import Lax68.Stars
import Lax68.Trees

/-!
---
title: Stars are trees
type: theorem
---
Every star graph is a tree.
-/

set_option autoImplicit false

namespace Lax68.StarTree

axiom star_tree {V : Type*} [Fintype V] {G : SimpleGraph V} :
  Lax68.Stars.IsStar G →
  Lax68.Trees.IsTree G

end Lax68.StarTree
