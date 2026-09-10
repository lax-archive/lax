import Lax68.TreeThreeFan

set_option autoImplicit false

namespace Lax68Proofs

open Lax68.ThreeFans

universe u

variable {V : Type u} {G : SimpleGraph V}

private lemma eq_center_of_mem_split_support [DecidableEq V]
    {a b m x : V} (P : G.Walk a b) (hP : P.IsPath)
    (hm : m ∈ P.support)
    (hx₁ : x ∈ (P.takeUntil m hm).support)
    (hx₂ : x ∈ (P.dropUntil m hm).support) :
    x = m := by
  classical
  by_contra hxm
  have hsplit :
      ((P.takeUntil m hm).append (P.dropUntil m hm)).IsPath := by
    rw [P.take_spec hm]
    exact hP
  exact
    (hsplit.ne_of_mem_support_of_append hxm hx₁ hx₂) rfl

private def commonIndices [DecidableEq V]
    {T : SimpleGraph V} {a b c : V}
    (P : T.Walk a b) (Q : T.Walk a c) :
    Finset (Fin (P.length + 1)) :=
  Finset.univ.filter fun i => P.getVert i ∈ Q.support

private lemma commonIndices_nonempty [DecidableEq V]
    {T : SimpleGraph V} {a b c : V}
    (P : T.Walk a b) (Q : T.Walk a c) :
    (commonIndices P Q).Nonempty := by
  refine ⟨⟨0, Nat.zero_lt_succ P.length⟩, ?_⟩
  simp [commonIndices]

private noncomputable def lastCommonIndex [DecidableEq V]
    {T : SimpleGraph V} {a b c : V}
    (P : T.Walk a b) (Q : T.Walk a c) :
    Fin (P.length + 1) :=
  (commonIndices P Q).max' (commonIndices_nonempty P Q)

private lemma lastCommonIndex_mem [DecidableEq V]
    {T : SimpleGraph V} {a b c : V}
    (P : T.Walk a b) (Q : T.Walk a c) :
    lastCommonIndex P Q ∈ commonIndices P Q := by
  exact Finset.max'_mem _ _

private lemma le_lastCommonIndex [DecidableEq V]
    {T : SimpleGraph V} {a b c : V}
    (P : T.Walk a b) (Q : T.Walk a c)
    {i : Fin (P.length + 1)} (hi : i ∈ commonIndices P Q) :
    i ≤ lastCommonIndex P Q := by
  exact Finset.le_max' _ _ hi

private lemma index_lt_idxOf_of_mem_drop [DecidableEq V]
    {l : List V} (hl : l.Nodup) {k : ℕ} (hk : k < l.length)
    {x : V} (hx : x ∈ l.drop k) (hne : x ≠ l[k]) :
    k < l.idxOf x := by
  have hxTail : x ∈ l.drop (k + 1) := by
    rw [List.drop_eq_getElem_cons hk] at hx
    simp only [List.mem_cons] at hx
    cases hx with
    | inl hxHead =>
        exact (hne hxHead).elim
    | inr hxTail =>
        exact hxTail
  have hxList : x ∈ l := List.mem_of_mem_drop hxTail
  have hnd :
      (l.take (k + 1) ++ l.drop (k + 1)).Nodup := by
    simpa using hl
  have hnotTake : x ∉ l.take (k + 1) := by
    intro hxTake
    exact ((List.nodup_append.mp hnd).2.2 x hxTake x hxTail) rfl
  rw [List.mem_take_iff_idxOf_lt hxList] at hnotTake
  omega

private lemma eq_lastCommon_of_mem_drops [DecidableEq V]
    {T : SimpleGraph V} {a b c x : V}
    (P : T.Walk a b) (Q : T.Walk a c)
    (hP : P.IsPath)
    (hxP :
      x ∈ (P.dropUntil (P.getVert (lastCommonIndex P Q))
        (P.getVert_mem_support _)).support)
    (hxQ :
      x ∈ (Q.dropUntil (P.getVert (lastCommonIndex P Q))
        ((Finset.mem_filter.mp (lastCommonIndex_mem P Q)).2)).support) :
    x = P.getVert (lastCommonIndex P Q) := by
  let k := lastCommonIndex P Q
  let m := P.getVert k
  have hmP : m ∈ P.support := P.getVert_mem_support k
  have hmQ : m ∈ Q.support := by
    exact (Finset.mem_filter.mp (lastCommonIndex_mem P Q)).2
  change x ∈ (P.dropUntil m hmP).support at hxP
  change x ∈ (Q.dropUntil m hmQ).support at hxQ
  by_contra hxm
  have hxPSupport : x ∈ P.support :=
    P.support_dropUntil_subset hmP hxP
  have hxQSupport : x ∈ Q.support :=
    Q.support_dropUntil_subset hmQ hxQ
  have hkLe : k.val ≤ P.length := by omega
  have hkSupportLt : k.val < P.support.length := by
    simpa [P.length_support] using k.isLt
  have hmk : m = P.support[k.val] := by
    dsimp [m]
    exact P.getVert_eq_support_getElem hkLe
  have hidxM : P.support.idxOf m = k.val := by
    rw [hmk]
    exact hP.support_nodup.idxOf_getElem k.val hkSupportLt
  have hxDrop : x ∈ P.support.drop k.val := by
    rw [P.dropUntil_eq_drop hmP, SimpleGraph.Walk.support_copy,
      P.drop_support_eq_support_drop_min] at hxP
    simpa [hidxM, Nat.min_eq_left hkLe] using hxP
  have hindex :
      k.val < P.support.idxOf x := by
    apply index_lt_idxOf_of_mem_drop hP.support_nodup hkSupportLt hxDrop
    intro hx
    apply hxm
    exact hx.trans hmk.symm
  let i : Fin (P.length + 1) :=
    ⟨P.support.idxOf x, by
      rw [← P.length_support]
      exact P.support.idxOf_lt_length_of_mem hxPSupport⟩
  have hi : i ∈ commonIndices P Q := by
    simp only [commonIndices, Finset.mem_filter, Finset.mem_univ, true_and]
    change P.getVert (P.support.idxOf x) ∈ Q.support
    simpa [P.getVert_support_idxOf hxPSupport] using hxQSupport
  have hle := le_lastCommonIndex P Q hi
  exact (Nat.not_lt_of_ge hle) hindex

/--
---
conclusion: Lax68.TreeThreeFan.exists_threeFan
---
Choose the last common vertex of the paths from the first terminal to the
other two. The three path pieces at that vertex meet nowhere else.
-/
theorem tree_exists_threeFan :
    G.IsTree →
      ∀ a b c : V, Lax68.ThreeFans.HasThreeFan G a b c := by
  intro hG a b c
  change Nonempty (ThreeFan G a b c)
  classical
  obtain ⟨P, hP, _⟩ := hG.existsUnique_path a b
  obtain ⟨Q, hQ, _⟩ := hG.existsUnique_path a c
  let k := lastCommonIndex P Q
  let m := P.getVert k
  have hmP : m ∈ P.support := P.getVert_mem_support k
  have hmQ : m ∈ Q.support := by
    exact (Finset.mem_filter.mp (lastCommonIndex_mem P Q)).2
  let A := (P.takeUntil m hmP).reverse
  let B := P.dropUntil m hmP
  let C := Q.dropUntil m hmQ
  have hprefix :
      P.takeUntil m hmP = Q.takeUntil m hmQ :=
    (hG.existsUnique_path a m).unique
      (hP.takeUntil hmP) (hQ.takeUntil hmQ)
  refine ⟨{
    center := m
    toA := A
    toB := B
    toC := C
    toA_isPath := by
      exact (hP.takeUntil hmP).reverse
    toB_isPath := by
      exact hP.dropUntil hmP
    toC_isPath := by
      exact hQ.dropUntil hmQ
    toA_toB := by
      intro x hxA hxB
      apply eq_center_of_mem_split_support P hP hmP
      · simpa [A] using hxA
      · simpa [B] using hxB
    toA_toC := by
      intro x hxA hxC
      apply eq_center_of_mem_split_support Q hQ hmQ
      · rw [← hprefix]
        simpa [A] using hxA
      · simpa [C] using hxC
    toB_toC := by
      intro x hxB hxC
      simpa [B, C, m, k] using
        (eq_lastCommon_of_mem_drops P Q hP hxB hxC)
  }⟩

end Lax68Proofs
