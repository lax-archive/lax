import Lax68.TreeFourTerminalDichotomy
import Lax68.TreeThreeFan

set_option autoImplicit false

namespace Lax68Proofs.TreeFourTerminalDichotomy

open Lax68.ThreeFans
open Lax68.FourTerminalFans

universe u

variable {V : Type u} {G : SimpleGraph V}

private def unionIndices [DecidableEq V]
    {a b c d : V} (F : ThreeFan G a b c)
    (R : G.Walk F.center d) :
    Finset (Fin (R.length + 1)) :=
  Finset.univ.filter fun i =>
    R.getVert i ∈ F.toA.support ∨
    R.getVert i ∈ F.toB.support ∨
    R.getVert i ∈ F.toC.support

private lemma unionIndices_nonempty [DecidableEq V]
    {a b c d : V} (F : ThreeFan G a b c)
    (R : G.Walk F.center d) :
    (unionIndices F R).Nonempty := by
  refine ⟨⟨0, Nat.zero_lt_succ R.length⟩, ?_⟩
  simp [unionIndices]

private noncomputable def lastUnionIndex [DecidableEq V]
    {a b c d : V} (F : ThreeFan G a b c)
    (R : G.Walk F.center d) :
    Fin (R.length + 1) :=
  (unionIndices F R).max' (unionIndices_nonempty F R)

private lemma lastUnionIndex_mem [DecidableEq V]
    {a b c d : V} (F : ThreeFan G a b c)
    (R : G.Walk F.center d) :
    lastUnionIndex F R ∈ unionIndices F R := by
  exact Finset.max'_mem _ _

private lemma le_lastUnionIndex [DecidableEq V]
    {a b c d : V} (F : ThreeFan G a b c)
    (R : G.Walk F.center d)
    {i : Fin (R.length + 1)} (hi : i ∈ unionIndices F R) :
    i ≤ lastUnionIndex F R := by
  exact Finset.le_max' _ _ hi

private lemma index_lt_idxOf_of_mem_drop [DecidableEq V]
    {l : List V} (hl : l.Nodup) {k : ℕ} (hk : k < l.length)
    {x : V} (hx : x ∈ l.drop k) (hne : x ≠ l[k]) :
    k < l.idxOf x := by
  have hxTail : x ∈ l.drop (k + 1) := by
    rw [List.drop_eq_getElem_cons hk] at hx
    simp only [List.mem_cons] at hx
    cases hx with
    | inl hxHead => exact (hne hxHead).elim
    | inr hxTail => exact hxTail
  have hxList : x ∈ l := List.mem_of_mem_drop hxTail
  have hnd :
      (l.take (k + 1) ++ l.drop (k + 1)).Nodup := by
    simpa using hl
  have hnotTake : x ∉ l.take (k + 1) := by
    intro hxTake
    exact ((List.nodup_append.mp hnd).2.2 x hxTake x hxTail) rfl
  rw [List.mem_take_iff_idxOf_lt hxList] at hnotTake
  omega

private lemma eq_lastUnion_of_mem_tail_and_arm [DecidableEq V]
    {a b c d x : V} (F : ThreeFan G a b c)
    (R : G.Walk F.center d) (hR : R.IsPath)
    (hxR :
      x ∈ (R.dropUntil (R.getVert (lastUnionIndex F R))
        (R.getVert_mem_support _)).support)
    (hxArm :
      x ∈ F.toA.support ∨
      x ∈ F.toB.support ∨
      x ∈ F.toC.support) :
    x = R.getVert (lastUnionIndex F R) := by
  let k := lastUnionIndex F R
  let q := R.getVert k
  have hqR : q ∈ R.support := R.getVert_mem_support k
  change x ∈ (R.dropUntil q hqR).support at hxR
  by_contra hxq
  have hxSupport : x ∈ R.support :=
    R.support_dropUntil_subset hqR hxR
  have hkLe : k.val ≤ R.length := by omega
  have hkSupportLt : k.val < R.support.length := by
    simpa [R.length_support] using k.isLt
  have hqk : q = R.support[k.val] := by
    dsimp [q]
    exact R.getVert_eq_support_getElem hkLe
  have hidxQ : R.support.idxOf q = k.val := by
    rw [hqk]
    exact hR.support_nodup.idxOf_getElem k.val hkSupportLt
  have hxDrop : x ∈ R.support.drop k.val := by
    rw [R.dropUntil_eq_drop hqR, SimpleGraph.Walk.support_copy,
      R.drop_support_eq_support_drop_min] at hxR
    simpa [hidxQ, Nat.min_eq_left hkLe] using hxR
  have hindex : k.val < R.support.idxOf x := by
    apply index_lt_idxOf_of_mem_drop hR.support_nodup hkSupportLt hxDrop
    intro hx
    apply hxq
    exact hx.trans hqk.symm
  let i : Fin (R.length + 1) :=
    ⟨R.support.idxOf x, by
      rw [← R.length_support]
      exact R.support.idxOf_lt_length_of_mem hxSupport⟩
  have hi : i ∈ unionIndices F R := by
    simp only [unionIndices, Finset.mem_filter, Finset.mem_univ, true_and]
    change R.getVert (R.support.idxOf x) ∈ F.toA.support ∨
      R.getVert (R.support.idxOf x) ∈ F.toB.support ∨
      R.getVert (R.support.idxOf x) ∈ F.toC.support
    simpa [R.getVert_support_idxOf hxSupport] using hxArm
  have hle := le_lastUnionIndex F R hi
  exact (Nat.not_lt_of_ge hle) hindex

private lemma eq_split_of_mem_prefix_tail [DecidableEq V]
    {m p q x : V} (P : G.Walk m p) (hP : P.IsPath)
    (hq : q ∈ P.support)
    (hxPrefix : x ∈ (P.takeUntil q hq).support)
    (hxTail : x ∈ (P.dropUntil q hq).support) :
    x = q := by
  by_contra hxq
  have hsplit :
      ((P.takeUntil q hq).append (P.dropUntil q hq)).IsPath := by
    rw [P.take_spec hq]
    exact hP
  exact
    (hsplit.ne_of_mem_support_of_append hxq hxPrefix hxTail) rfl

private lemma start_not_mem_tail [DecidableEq V]
    {m p q : V} (P : G.Walk m p) (hP : P.IsPath)
    (hq : q ∈ P.support) (hmq : m ≠ q) :
    m ∉ (P.dropUntil q hq).support := by
  intro hm
  apply hmq
  exact eq_split_of_mem_prefix_tail P hP hq
    (SimpleGraph.Walk.start_mem_support _) hm

private noncomputable def splitOfLastIntersection
    [DecidableEq V]
    {m p l₁ l₂ d q : V}
    (P : G.Walk m p) (L₁ : G.Walk m l₁)
    (L₂ : G.Walk m l₂) (R : G.Walk m d)
    (hP : P.IsPath) (hL₁ : L₁.IsPath)
    (hL₂ : L₂.IsPath) (hR : R.IsPath)
    (hP₁ : ∀ {x}, x ∈ P.support → x ∈ L₁.support → x = m)
    (hP₂ : ∀ {x}, x ∈ P.support → x ∈ L₂.support → x = m)
    (h₁₂ : ∀ {x}, x ∈ L₁.support → x ∈ L₂.support → x = m)
    (hqP : q ∈ P.support) (hqR : q ∈ R.support) (hqm : q ≠ m)
    (hlast :
      ∀ {x},
        x ∈ (R.dropUntil q hqR).support →
        (x ∈ P.support ∨ x ∈ L₁.support ∨ x ∈ L₂.support) →
        x = q) :
    SplitFourFan G l₁ l₂ p d := by
  classical
  have hmP₁ : m ∉ (P.dropUntil q hqP).support := by
    exact start_not_mem_tail P hP hqP hqm.symm
  have hqL₁ : q ∉ L₁.support := by
    intro hq
    exact hqm (hP₁ hqP hq)
  have hqL₂ : q ∉ L₂.support := by
    intro hq
    exact hqm (hP₂ hqP hq)
  refine {
    leftCenter := m
    rightCenter := q
    centers_ne := hqm.symm
    toA := L₁
    toB := L₂
    bridge := P.takeUntil q hqP
    toC := P.dropUntil q hqP
    toD := R.dropUntil q hqR
    toA_isPath := hL₁
    toB_isPath := hL₂
    bridge_isPath := hP.takeUntil hqP
    toC_isPath := hP.dropUntil hqP
    toD_isPath := hR.dropUntil hqR
    left_arms_meet := h₁₂
    right_arms_meet := ?_
    opposite_arms_disjoint := ?_
    bridge_meets_left := ?_
    bridge_meets_right := ?_
  }
  · intro x hxP hxD
    exact hlast hxD (.inl (P.support_dropUntil_subset hqP hxP))
  · intro x hxLeft hxRight
    rcases hxLeft with hxL₁ | hxL₂
    · rcases hxRight with hxP | hxD
      · have hxm := hP₁ (P.support_dropUntil_subset hqP hxP) hxL₁
        exact hmP₁ (hxm ▸ hxP)
      · have hxq := hlast hxD (.inr (.inl hxL₁))
        exact hqL₁ (hxq ▸ hxL₁)
    · rcases hxRight with hxP | hxD
      · have hxm := hP₂ (P.support_dropUntil_subset hqP hxP) hxL₂
        exact hmP₁ (hxm ▸ hxP)
      · have hxq := hlast hxD (.inr (.inr hxL₂))
        exact hqL₂ (hxq ▸ hxL₂)
  · intro x hxBridge hxLeft
    have hxP := P.support_takeUntil_subset_support hqP hxBridge
    rcases hxLeft with hxL₁ | hxL₂
    · exact hP₁ hxP hxL₁
    · exact hP₂ hxP hxL₂
  · intro x hxBridge hxRight
    rcases hxRight with hxP | hxD
    · exact eq_split_of_mem_prefix_tail P hP hqP hxBridge hxP
    · exact hlast hxD (.inl
        (P.support_takeUntil_subset_support hqP hxBridge))

/--
---
conclusion: Lax68.TreeFourTerminalDichotomy.exists_fourFan_or_split
assumptions:
  - Lax68.TreeThreeFan.exists_threeFan
---
Join three terminals by a three-fan and follow the path from its center to
the fourth terminal.  Its last intersection with the three old arms either
is the center, giving a four-fan, or lies on exactly one arm, splitting the
connector into two paired centers.
-/
theorem exists_fourFan_or_split :
    G.IsTree →
      ∀ a b c d : V,
        HasFourFan G a b c d ∨
        HasSplitFourFan G a b c d ∨
        HasSplitFourFan G a c b d ∨
        HasSplitFourFan G b c a d := by
  intro hG a b c d
  classical
  let F : ThreeFan G a b c :=
    Classical.choice <| Lax68.TreeThreeFan.exists_threeFan hG a b c
  obtain ⟨R, hR, _⟩ := hG.existsUnique_path F.center d
  let k := lastUnionIndex F R
  let q := R.getVert k
  have hqR : q ∈ R.support := R.getVert_mem_support k
  have hqUnion :
      q ∈ F.toA.support ∨
      q ∈ F.toB.support ∨
      q ∈ F.toC.support := by
    exact (Finset.mem_filter.mp (lastUnionIndex_mem F R)).2
  have hlast :
      ∀ {x},
        x ∈ (R.dropUntil q hqR).support →
        (x ∈ F.toA.support ∨
          x ∈ F.toB.support ∨
          x ∈ F.toC.support) →
        x = q := by
    intro x hxR hxArm
    simpa [q, k] using
      (eq_lastUnion_of_mem_tail_and_arm F R hR hxR hxArm)
  by_cases hqm : q = F.center
  · left
    refine ⟨{
      center := F.center
      toA := F.toA
      toB := F.toB
      toC := F.toC
      toD := (R.dropUntil q hqR).copy hqm rfl
      toA_isPath := F.toA_isPath
      toB_isPath := F.toB_isPath
      toC_isPath := F.toC_isPath
      toD_isPath := by
        simpa only [SimpleGraph.Walk.isPath_copy] using
          hR.dropUntil hqR
      toA_toB := F.toA_toB
      toA_toC := F.toA_toC
      toA_toD := by
        intro x hxA hxD
        have hxD' : x ∈ (R.dropUntil q hqR).support := by
          simpa only [SimpleGraph.Walk.support_copy] using hxD
        exact (hlast hxD' (.inl hxA)).trans hqm
      toB_toC := F.toB_toC
      toB_toD := by
        intro x hxB hxD
        have hxD' : x ∈ (R.dropUntil q hqR).support := by
          simpa only [SimpleGraph.Walk.support_copy] using hxD
        exact (hlast hxD' (.inr (.inl hxB))).trans hqm
      toC_toD := by
        intro x hxC hxD
        have hxD' : x ∈ (R.dropUntil q hqR).support := by
          simpa only [SimpleGraph.Walk.support_copy] using hxD
        exact (hlast hxD' (.inr (.inr hxC))).trans hqm
    }⟩
  · rcases hqUnion with hqA | hqB | hqC
    · right; right; right
      exact ⟨splitOfLastIntersection
        F.toA F.toB F.toC R
        F.toA_isPath F.toB_isPath F.toC_isPath hR
        F.toA_toB F.toA_toC F.toB_toC
        hqA hqR hqm hlast⟩
    · right; right; left
      exact ⟨splitOfLastIntersection
        F.toB F.toA F.toC R
        F.toB_isPath F.toA_isPath F.toC_isPath hR
        (fun hxB hxA => F.toA_toB hxA hxB)
        F.toB_toC F.toA_toC
        hqB hqR hqm (by
          intro x hxR hx
          apply hlast hxR
          rcases hx with hxB | hxA | hxC
          · exact .inr (.inl hxB)
          · exact .inl hxA
          · exact .inr (.inr hxC))⟩
    · right; left
      exact ⟨splitOfLastIntersection
        F.toC F.toA F.toB R
        F.toC_isPath F.toA_isPath F.toB_isPath hR
        (fun hxC hxA => F.toA_toC hxA hxC)
        (fun hxC hxB => F.toB_toC hxB hxC)
        F.toA_toB
        hqC hqR hqm (by
          intro x hxR hx
          apply hlast hxR
          rcases hx with hxC | hxA | hxB
          · exact .inr (.inr hxC)
          · exact .inl hxA
          · exact .inr (.inl hxB))⟩

end Lax68Proofs.TreeFourTerminalDichotomy
