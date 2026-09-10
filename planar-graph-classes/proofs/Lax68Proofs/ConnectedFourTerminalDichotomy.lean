import Lax68.ConnectedFourTerminalDichotomy
import Lax68.TreeFourTerminalDichotomy

set_option autoImplicit false

namespace Lax68Proofs.ConnectedFourTerminalDichotomy

open Lax68.FourTerminalFans

universe u

variable {V : Type u} {G T : SimpleGraph V}

private def mapFourFan {a b c d : V}
    (hTG : T ≤ G) (F : FourFan T a b c d) :
    FourFan G a b c d := {
  center := F.center
  toA := F.toA.mapLe hTG
  toB := F.toB.mapLe hTG
  toC := F.toC.mapLe hTG
  toD := F.toD.mapLe hTG
  toA_isPath := F.toA_isPath.mapLe hTG
  toB_isPath := F.toB_isPath.mapLe hTG
  toC_isPath := F.toC_isPath.mapLe hTG
  toD_isPath := F.toD_isPath.mapLe hTG
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
  toA_toD := by
    intro x hxA hxD
    apply F.toA_toD
    · simpa only [SimpleGraph.Walk.support_mapLe_eq_support] using hxA
    · simpa only [SimpleGraph.Walk.support_mapLe_eq_support] using hxD
  toB_toC := by
    intro x hxB hxC
    apply F.toB_toC
    · simpa only [SimpleGraph.Walk.support_mapLe_eq_support] using hxB
    · simpa only [SimpleGraph.Walk.support_mapLe_eq_support] using hxC
  toB_toD := by
    intro x hxB hxD
    apply F.toB_toD
    · simpa only [SimpleGraph.Walk.support_mapLe_eq_support] using hxB
    · simpa only [SimpleGraph.Walk.support_mapLe_eq_support] using hxD
  toC_toD := by
    intro x hxC hxD
    apply F.toC_toD
    · simpa only [SimpleGraph.Walk.support_mapLe_eq_support] using hxC
    · simpa only [SimpleGraph.Walk.support_mapLe_eq_support] using hxD
}

private def mapSplitFourFan {a b c d : V}
    (hTG : T ≤ G) (F : SplitFourFan T a b c d) :
    SplitFourFan G a b c d := {
  leftCenter := F.leftCenter
  rightCenter := F.rightCenter
  centers_ne := F.centers_ne
  toA := F.toA.mapLe hTG
  toB := F.toB.mapLe hTG
  bridge := F.bridge.mapLe hTG
  toC := F.toC.mapLe hTG
  toD := F.toD.mapLe hTG
  toA_isPath := F.toA_isPath.mapLe hTG
  toB_isPath := F.toB_isPath.mapLe hTG
  bridge_isPath := F.bridge_isPath.mapLe hTG
  toC_isPath := F.toC_isPath.mapLe hTG
  toD_isPath := F.toD_isPath.mapLe hTG
  left_arms_meet := by
    intro x hxA hxB
    apply F.left_arms_meet
    · simpa only [SimpleGraph.Walk.support_mapLe_eq_support] using hxA
    · simpa only [SimpleGraph.Walk.support_mapLe_eq_support] using hxB
  right_arms_meet := by
    intro x hxC hxD
    apply F.right_arms_meet
    · simpa only [SimpleGraph.Walk.support_mapLe_eq_support] using hxC
    · simpa only [SimpleGraph.Walk.support_mapLe_eq_support] using hxD
  opposite_arms_disjoint := by
    intro x hxLeft hxRight
    apply F.opposite_arms_disjoint
    · rcases hxLeft with hxA | hxB
      · exact .inl (by simpa only
          [SimpleGraph.Walk.support_mapLe_eq_support] using hxA)
      · exact .inr (by simpa only
          [SimpleGraph.Walk.support_mapLe_eq_support] using hxB)
    · rcases hxRight with hxC | hxD
      · exact .inl (by simpa only
          [SimpleGraph.Walk.support_mapLe_eq_support] using hxC)
      · exact .inr (by simpa only
          [SimpleGraph.Walk.support_mapLe_eq_support] using hxD)
  bridge_meets_left := by
    intro x hxBridge hxLeft
    apply F.bridge_meets_left
    · simpa only [SimpleGraph.Walk.support_mapLe_eq_support] using hxBridge
    · rcases hxLeft with hxA | hxB
      · exact .inl (by simpa only
          [SimpleGraph.Walk.support_mapLe_eq_support] using hxA)
      · exact .inr (by simpa only
          [SimpleGraph.Walk.support_mapLe_eq_support] using hxB)
  bridge_meets_right := by
    intro x hxBridge hxRight
    apply F.bridge_meets_right
    · simpa only [SimpleGraph.Walk.support_mapLe_eq_support] using hxBridge
    · rcases hxRight with hxC | hxD
      · exact .inl (by simpa only
          [SimpleGraph.Walk.support_mapLe_eq_support] using hxC)
      · exact .inr (by simpa only
          [SimpleGraph.Walk.support_mapLe_eq_support] using hxD)
}

/--
---
conclusion: Lax68.ConnectedFourTerminalDichotomy.exists_fourFan_or_split
assumptions:
  - Lax68.TreeFourTerminalDichotomy.exists_fourFan_or_split
---
Choose a spanning tree, use its four-terminal dichotomy, and regard the
resulting paths as paths in the original connected graph.
-/
theorem exists_fourFan_or_split :
    G.Connected →
      ∀ a b c d : V,
        HasFourFan G a b c d ∨
        HasSplitFourFan G a b c d ∨
        HasSplitFourFan G a c b d ∨
        HasSplitFourFan G b c a d := by
  intro hG a b c d
  obtain ⟨T, hTG, hT⟩ := hG.exists_isTree_le
  rcases Lax68.TreeFourTerminalDichotomy.exists_fourFan_or_split
      hT a b c d with hF | hS | hS | hS
  · exact .inl ⟨mapFourFan hTG hF.some⟩
  · exact .inr (.inl ⟨mapSplitFourFan hTG hS.some⟩)
  · exact .inr (.inr (.inl ⟨mapSplitFourFan hTG hS.some⟩))
  · exact .inr (.inr (.inr ⟨mapSplitFourFan hTG hS.some⟩))

end Lax68Proofs.ConnectedFourTerminalDichotomy
