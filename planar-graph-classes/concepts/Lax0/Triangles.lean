import Lax0.MaximalOuterplanar

/-!
---
title: Triangles
type: definition
---
A triangle is the complete graph on exactly three vertices.  Its maximal
outerplanar certificate is recorded explicitly.
-/

set_option autoImplicit false

namespace Lax0.Triangles

def IsTriangle {V : Type*} [Fintype V] (G : SimpleGraph V) : Prop :=
  Fintype.card V = 3 ∧
    G = SimpleGraph.completeGraph V ∧
    MaximalOuterplanar.IsMaximalOuterplanar G

end Lax0.Triangles
