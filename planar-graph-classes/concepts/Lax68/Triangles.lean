import Mathlib.Combinatorics.SimpleGraph.Maps

/-!
---
title: Triangles
type: definition
---
A triangle is a finite complete graph on exactly three vertices.
-/

set_option autoImplicit false

namespace Lax68.Triangles

def IsTriangle {V : Type*} (G : SimpleGraph V) : Prop :=
  Nonempty (G ≃g SimpleGraph.completeGraph (Fin 3))

end Lax68.Triangles
