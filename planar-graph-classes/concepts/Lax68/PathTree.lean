import Lax68.Paths
import Lax68.Trees

/-!
---
title: Paths are trees
type: theorem
---
Every path graph is a tree.
-/

set_option autoImplicit false

namespace Lax68.PathTree

axiom path_tree {V : Type*} [Fintype V] {G : SimpleGraph V} :
  Lax68.Paths.IsPath G →
  Lax68.Trees.IsTree G

end Lax68.PathTree
