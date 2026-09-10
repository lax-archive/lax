import Lax68.ConnectedThreeFan
import Lax68.TreeThreeFan

set_option autoImplicit false

namespace Lax68Proofs.ConnectedThreeFan

open Lax68.ThreeFans

universe u

variable {V : Type u} {G : SimpleGraph V}

/--
---
conclusion: Lax68.ConnectedThreeFan.exists_threeFan
assumptions:
  - Lax68.TreeThreeFan.exists_threeFan
---
Choose a spanning tree, take the tree three-fan, and regard its paths as paths
in the original graph.
-/
theorem exists_threeFan :
    G.Connected →
      ∀ a b c : V, HasThreeFan G a b c := by
  intro hG a b c
  obtain ⟨T, hTG, hT⟩ := hG.exists_isTree_le
  obtain ⟨F⟩ :=
    Lax68.TreeThreeFan.exists_threeFan hT a b c
  refine ⟨{
    center := F.center
    toA := F.toA.mapLe hTG
    toB := F.toB.mapLe hTG
    toC := F.toC.mapLe hTG
    toA_isPath := F.toA_isPath.mapLe hTG
    toB_isPath := F.toB_isPath.mapLe hTG
    toC_isPath := F.toC_isPath.mapLe hTG
    toA_toB := by
      intro x hxA hxB
      apply F.toA_toB
      · simpa only [SimpleGraph.Walk.support_mapLe_eq_support] using hxA
      · simpa only [SimpleGraph.Walk.support_mapLe_eq_support] using hxB
    toA_toC := by
      intro x hxA hxC
      apply F.toA_toC
      · simpa only [SimpleGraph.Walk.support_mapLe_eq_support] using hxA
      · simpa only [SimpleGraph.Walk.support_mapLe_eq_support] using hxC
    toB_toC := by
      intro x hxB hxC
      apply F.toB_toC
      · simpa only [SimpleGraph.Walk.support_mapLe_eq_support] using hxB
      · simpa only [SimpleGraph.Walk.support_mapLe_eq_support] using hxC
  }⟩

end Lax68Proofs.ConnectedThreeFan
