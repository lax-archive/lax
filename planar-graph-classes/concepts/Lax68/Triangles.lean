import Mathlib.Combinatorics.SimpleGraph.Basic

/-!
---
title: Triangles
type: definition
---
A triangle is a finite complete graph on exactly three vertices.
-/

set_option autoImplicit false

namespace Lax68.Triangles

def IsTriangle {V : Type*} [Fintype V] (G : SimpleGraph V) : Prop :=
  Fintype.card V = 3 ∧
    G = SimpleGraph.completeGraph V

end Lax68.Triangles
