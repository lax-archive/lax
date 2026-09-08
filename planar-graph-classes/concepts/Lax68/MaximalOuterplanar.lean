import Lax68.Outerplanar

/-!
---
title: Maximal outerplanar graphs
type: definition
---
A finite outerplanar graph is maximal outerplanar when no edge can be added
between its existing vertices while preserving outerplanarity.
-/

set_option autoImplicit false

namespace Lax68.MaximalOuterplanar

def IsMaximalOuterplanar {V : Type*} [Fintype V]
    (G : SimpleGraph V) : Prop :=
  Outerplanar.IsOuterplanar G ∧
    ∀ H : SimpleGraph V,
      G < H →
      ¬ Outerplanar.IsOuterplanar H

end Lax68.MaximalOuterplanar
