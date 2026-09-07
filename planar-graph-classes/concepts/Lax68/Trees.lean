import Mathlib.Combinatorics.SimpleGraph.Acyclic
import Lax68.Outerplanar

/-!
---
title: Trees
type: definition
---
A tree is a connected acyclic simple graph.  The concept also records an
outerplane drawing certificate, the standard elementary embedding of a tree
with all vertices on the outer face.
-/

set_option autoImplicit false

namespace Lax68.Trees

def IsTree {V : Type*} (G : SimpleGraph V) : Prop :=
  G.IsTree ∧ Outerplanar.IsOuterplanar G

end Lax68.Trees
