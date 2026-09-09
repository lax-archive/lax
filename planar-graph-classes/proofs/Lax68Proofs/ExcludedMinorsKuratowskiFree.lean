import Mathlib.Data.Sum.Order
import Lax68.ExcludedMinorsKuratowskiFree
import Lax68.TopologicalMinorIsMinor

set_option autoImplicit false

namespace Lax68Proofs

/--
---
conclusion: Lax68.ExcludedMinorsKuratowskiFree.excludedMinors_kuratowskiFree
assumptions:
  - Lax68.TopologicalMinorIsMinor.isMinor_of_isTopologicalMinor
---
A topological-minor model gives a minor model. Therefore excluding each of the
two minors excludes the corresponding subdivision.
-/
theorem excludedMinors_kuratowskiFree
    {V : Type*} {G : SimpleGraph V} :
  Lax68.Planar.IsPlanarByExcludedMinors G →
    Lax68.GraphTopologicalMinors.IsKuratowskiFree G := by
  intro h
  constructor
  · intro htop
    exact h.1
      (Lax68.TopologicalMinorIsMinor.isMinor_of_isTopologicalMinor htop)
  · intro htop
    letI : LinearOrder (Fin 3 ⊕ Fin 3) :=
      LinearOrder.lift'
        (toLex : (Fin 3 ⊕ Fin 3) → (Fin 3 ⊕ₗ Fin 3))
        (fun _ _ hxy => congrArg ofLex hxy)
    exact h.2
      (Lax68.TopologicalMinorIsMinor.isMinor_of_isTopologicalMinor htop)

end Lax68Proofs
