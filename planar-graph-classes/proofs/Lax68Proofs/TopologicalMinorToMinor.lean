import Mathlib.Combinatorics.SimpleGraph.Connectivity.Subgraph
import Lax68.GraphTopologicalMinors
import Lax68.TopologicalMinorIsMinor

set_option autoImplicit false

namespace Lax68Proofs.TopologicalMinorToMinor

open Lax68.GraphMinors
open Lax68.GraphTopologicalMinors

variable {W V : Type*} {H : SimpleGraph W} {G : SimpleGraph V}

private def branchSet [LinearOrder W]
    (M : TopologicalMinorModel H G) (w : W) : Set V :=
  {x |
    x = M.branch w ∨
      ∃ (v : W) (h : H.Adj w v),
        w < v ∧ x ∈ (M.route h).dropLast.support}

private lemma branch_or_interior_of_mem_dropLast
    {a b x : V} (P : G.Walk a b) (hP : P.IsPath)
    (hab : a ≠ b)
    (hx : x ∈ P.dropLast.support) :
    x = a ∨ x ∈ walkInterior P := by
  by_cases hxa : x = a
  · exact Or.inl hxa
  right
  have hnil : ¬P.Nil := SimpleGraph.Walk.not_nil_of_ne hab
  have hxb : x ≠ b := by
    have hbnot : b ∉ P.dropLast.support := by
      have hconcat :
          (P.dropLast.concat (P.adj_penultimate hnil)).IsPath := by
        simpa using hP
      exact (SimpleGraph.Walk.concat_isPath_iff _).mp hconcat |>.2
    intro hxb
    subst x
    exact hbnot hx
  exact ⟨List.mem_of_mem_dropLast (P.support_dropLast hnil ▸ hx), hxa, hxb⟩

private lemma branchSet_connected [LinearOrder W]
    (M : TopologicalMinorModel H G) (w : W) :
    (G.induce (branchSet M w)).Connected := by
  apply G.induce_connected_of_patches (M.branch w)
  · exact Or.inl rfl
  intro x hx
  rcases hx with rfl | ⟨v, h, hwv, hx⟩
  · refine ⟨{M.branch w}, ?_, by simp, by simp, ?_⟩
    · intro y hy
      simp only [Set.mem_singleton_iff] at hy
      exact Or.inl hy
    exact SimpleGraph.Reachable.rfl
  · let P := (M.route h).dropLast
    refine ⟨{y | y ∈ P.support}, ?_, P.start_mem_support, hx, ?_⟩
    · intro y hy
      exact Or.inr ⟨v, h, hwv, hy⟩
    exact P.connected_induce_support
      ⟨M.branch w, P.start_mem_support⟩ ⟨x, hx⟩

private lemma branchSet_member_cases [LinearOrder W]
    (M : TopologicalMinorModel H G) {w : W} {x : V}
    (hx : x ∈ branchSet M w) :
    x = M.branch w ∨
      ∃ (v : W) (h : H.Adj w v),
        w < v ∧ x ∈ walkInterior (M.route h) := by
  rcases hx with hx | ⟨v, h, hwv, hx⟩
  · exact Or.inl hx
  rcases branch_or_interior_of_mem_dropLast
      (M.route h) (M.route_isPath h)
      (fun hb => h.ne (M.branch.injective hb))
      hx with hx | hx
  · exact Or.inl hx
  · exact Or.inr ⟨v, h, hwv, hx⟩

private lemma branchSet_disjoint [LinearOrder W]
    (M : TopologicalMinorModel H G) {u v : W} (huv : u ≠ v) :
    Disjoint (branchSet M u) (branchSet M v) := by
  rw [Set.disjoint_left]
  intro x hxu hxv
  rcases branchSet_member_cases M hxu with hxu | ⟨u', huu', huu'lt, hxu⟩
  · rcases branchSet_member_cases M hxv with hxv | ⟨v', hvv', hvv'lt, hxv⟩
    · exact huv (M.branch.injective (hxu.symm.trans hxv))
    · subst x
      exact M.branch_avoids_interiors hvv' u hxv
  · rcases branchSet_member_cases M hxv with hxv | ⟨v', hvv', hvv'lt, hxv⟩
    · subst x
      exact M.branch_avoids_interiors huu' v hxu
    · have hedge :
          ¬ ((u = v ∧ u' = v') ∨ (u = v' ∧ u' = v)) := by
        rintro (⟨huv', _⟩ | ⟨huv', hu'v⟩)
        · exact huv huv'
        · subst v'
          subst u'
          exact lt_asymm huu'lt hvv'lt
      exact Set.disjoint_left.mp
        (M.route_interiors_disjoint huu' hvv' hedge) hxu hxv

private lemma branchSet_adjacent [LinearOrder W]
    (M : TopologicalMinorModel H G) {u v : W} (huv : H.Adj u v) :
    ∃ x ∈ branchSet M u, ∃ y ∈ branchSet M v, G.Adj x y := by
  have huv_ne : u ≠ v := huv.ne
  rcases lt_or_gt_of_ne huv_ne with huvlt | hvult
  · let P := M.route huv
    have hbranch : M.branch u ≠ M.branch v := by
      intro h
      exact huv_ne (M.branch.injective h)
    have hP : ¬P.Nil := SimpleGraph.Walk.not_nil_of_ne hbranch
    refine ⟨P.penultimate, ?_, M.branch v, Or.inl rfl, P.adj_penultimate hP⟩
    exact Or.inr ⟨v, huv, huvlt, P.dropLast.end_mem_support⟩
  · let P := M.route huv.symm
    have hbranch : M.branch v ≠ M.branch u := by
      intro h
      exact huv_ne ((M.branch.injective h).symm)
    have hP : ¬P.Nil := SimpleGraph.Walk.not_nil_of_ne hbranch
    refine ⟨M.branch u, Or.inl rfl, P.penultimate, ?_, (P.adj_penultimate hP).symm⟩
    exact Or.inr ⟨u, huv.symm, hvult, P.dropLast.end_mem_support⟩

def TopologicalMinorModel.toMinorModel [LinearOrder W]
    (M : TopologicalMinorModel H G) : MinorModel H G where
  branchSet := branchSet M
  connected := branchSet_connected M
  disjoint := branchSet_disjoint M
  adjacent := branchSet_adjacent M

/--
---
conclusion: Lax68.TopologicalMinorIsMinor.isMinor_of_isTopologicalMinor
---
Assign each route interior to its smaller endpoint. The resulting branch sets
are connected, pairwise disjoint, and adjacent whenever the source vertices
are adjacent.
-/
theorem isMinor_of_isTopologicalMinor [LinearOrder W] :
    IsTopologicalMinor H G → IsMinor H G := by
  rintro ⟨M⟩
  exact ⟨TopologicalMinorModel.toMinorModel M⟩

end Lax68Proofs.TopologicalMinorToMinor
