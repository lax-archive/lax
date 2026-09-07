import Lax68.MaximalOuterplanar

/-!
---
title: Triangles
type: definition
---
A triangle is the complete graph on exactly three vertices.  Its maximal
outerplanar certificate is recorded explicitly.
-/

set_option autoImplicit false

namespace Lax68.Triangles

def IsTriangle {V : Type*} [Fintype V] (G : SimpleGraph V) : Prop :=
  Fintype.card V = 3 ∧
    G = SimpleGraph.completeGraph V ∧
    MaximalOuterplanar.IsMaximalOuterplanar G

end Lax68.Triangles
