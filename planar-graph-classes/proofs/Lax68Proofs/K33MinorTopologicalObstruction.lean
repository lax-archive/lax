import Lax68.K33MinorTopologicalObstruction
import Lax68.ConnectedThreeFan

set_option autoImplicit false

namespace Lax68Proofs.K33MinorTopologicalObstruction

open Lax68.GraphMinors
open Lax68.GraphTopologicalMinors
open Lax68.ThreeFans

universe u

variable {V : Type u} {G : SimpleGraph V}

private abbrev W := Fin 3 ⊕ Fin 3

private lemma k33_adj (i j : Fin 3) :
    K33.Adj (Sum.inl i) (Sum.inr j) := by
  simp [K33]

private structure Link (M : MinorModel K33 G) (i j : Fin 3) where
  left : V
  right : V
  left_mem : left ∈ M.branchSet (Sum.inl i)
  right_mem : right ∈ M.branchSet (Sum.inr j)
  adj : G.Adj left right

private noncomputable def link
    (M : MinorModel K33 G) (i j : Fin 3) : Link M i j :=
  Classical.choice <| by
    rcases M.adjacent (k33_adj i j) with ⟨x, hx, y, hy, hxy⟩
    exact ⟨⟨x, y, hx, hy, hxy⟩⟩

private structure BranchFan
    (M : MinorModel K33 G) (w : W)
    (port : Fin 3 → V) where
  center : V
  center_mem : center ∈ M.branchSet w
  arm : ∀ i, G.Walk center (port i)
  arm_isPath : ∀ i, (arm i).IsPath
  arm_support :
    ∀ i {x}, x ∈ (arm i).support → x ∈ M.branchSet w
  arm_inter :
    ∀ {i j}, i ≠ j →
      ∀ {x}, x ∈ (arm i).support → x ∈ (arm j).support →
        x = center

private lemma mem_support_of_mem_mapped_support
    {S : Set V} {a b : S}
    {P : (G.induce S).Walk a b} {x : V}
    (hx : x ∈ (P.map (SimpleGraph.Embedding.induce S).toHom).support) :
    ∃ y ∈ P.support, (y : V) = x := by
  simpa only [SimpleGraph.Walk.support_map, List.mem_map] using hx

private noncomputable def branchFan
    (M : MinorModel K33 G) (w : W)
    (port : Fin 3 → V)
    (hport : ∀ i, port i ∈ M.branchSet w) :
    BranchFan M w port := by
  let p0 : M.branchSet w := ⟨port 0, hport 0⟩
  let p1 : M.branchSet w := ⟨port 1, hport 1⟩
  let p2 : M.branchSet w := ⟨port 2, hport 2⟩
  let F : ThreeFan (G.induce (M.branchSet w)) p0 p1 p2 :=
    Classical.choice <|
      Lax68.ConnectedThreeFan.exists_threeFan
        (M.connected w) p0 p1 p2
  let e := SimpleGraph.Embedding.induce (G := G) (M.branchSet w)
  refine {
    center := F.center
    center_mem := F.center.property
    arm := Fin.cases (F.toA.map e.toHom)
      (Fin.cases (F.toB.map e.toHom)
        (Fin.cases (F.toC.map e.toHom) (fun i => Fin.elim0 i)))
    arm_isPath := ?_
    arm_support := ?_
    arm_inter := ?_
  }
  · intro i
    fin_cases i
    · exact SimpleGraph.Walk.map_isPath_of_injective
        e.injective F.toA_isPath
    · exact SimpleGraph.Walk.map_isPath_of_injective
        e.injective F.toB_isPath
    · exact SimpleGraph.Walk.map_isPath_of_injective
        e.injective F.toC_isPath
  · intro i x hx
    fin_cases i
    all_goals
      rcases mem_support_of_mem_mapped_support hx with ⟨y, hy, rfl⟩
      exact y.property
  · intro i j hij x hxi hxj
    fin_cases i <;> fin_cases j
    all_goals try exact (hij rfl).elim
    all_goals
      rcases mem_support_of_mem_mapped_support hxi with ⟨y, hy, rfl⟩
      rcases mem_support_of_mem_mapped_support hxj with ⟨z, hz, hzy⟩
      have hyz : y = z := Subtype.ext hzy.symm
      subst z
    · exact congrArg Subtype.val (F.toA_toB hy hz)
    · exact congrArg Subtype.val (F.toA_toC hy hz)
    · exact congrArg Subtype.val (F.toA_toB hz hy)
    · exact congrArg Subtype.val (F.toB_toC hy hz)
    · exact congrArg Subtype.val (F.toA_toC hz hy)
    · exact congrArg Subtype.val (F.toB_toC hz hy)

private noncomputable def leftFan
    (M : MinorModel K33 G) (i : Fin 3) :
    BranchFan M (Sum.inl i) (fun j => (link M i j).left) :=
  branchFan M (Sum.inl i) _ fun j => (link M i j).left_mem

private noncomputable def rightFan
    (M : MinorModel K33 G) (j : Fin 3) :
    BranchFan M (Sum.inr j) (fun i => (link M i j).right) :=
  branchFan M (Sum.inr j) _ fun i => (link M i j).right_mem



private noncomputable def branchPoint
    (M : MinorModel K33 G) : W → V
  | Sum.inl i => (leftFan M i).center
  | Sum.inr j => (rightFan M j).center

private lemma branchPoint_mem
    (M : MinorModel K33 G) (w : W) :
    branchPoint M w ∈ M.branchSet w := by
  cases w with
  | inl i => exact (leftFan M i).center_mem
  | inr j => exact (rightFan M j).center_mem

private lemma branchPoint_injective
    (M : MinorModel K33 G) :
    Function.Injective (branchPoint M) := by
  intro a b hab
  by_contra hne
  have hd := M.disjoint hne
  rw [Set.disjoint_left] at hd
  exact hd (branchPoint_mem M a) (hab ▸ branchPoint_mem M b)

private noncomputable def branchEmbedding
    (M : MinorModel K33 G) : W ↪ V where
  toFun := branchPoint M
  inj' := branchPoint_injective M

private noncomputable def rawRoute
    (M : MinorModel K33 G) (i j : Fin 3) :
    G.Walk (leftFan M i).center (rightFan M j).center :=
  ((leftFan M i).arm j).append <|
    .cons (link M i j).adj ((rightFan M j).arm i).reverse

private noncomputable def canonicalRoute
    (M : MinorModel K33 G) (i j : Fin 3) :
    G.Walk (leftFan M i).center (rightFan M j).center := by
  classical
  exact (rawRoute M i j).bypass

private lemma rawRoute_support_cases
    (M : MinorModel K33 G) (i j : Fin 3) {x : V}
    (hx : x ∈ (rawRoute M i j).support) :
    x ∈ ((leftFan M i).arm j).support ∨
      x ∈ ((rightFan M j).arm i).support := by
  simp only [rawRoute, SimpleGraph.Walk.mem_support_append_iff] at hx
  rcases hx with hx | hx
  · exact Or.inl hx
  rw [SimpleGraph.Walk.support_cons, List.mem_cons] at hx
  rcases hx with rfl | hx
  · exact Or.inl (SimpleGraph.Walk.end_mem_support _)
  · right
    simpa only [SimpleGraph.Walk.support_reverse, List.mem_reverse] using hx

private lemma canonicalRoute_support_cases
    (M : MinorModel K33 G) (i j : Fin 3) {x : V}
    (hx : x ∈ (canonicalRoute M i j).support) :
    x ∈ ((leftFan M i).arm j).support ∨
      x ∈ ((rightFan M j).arm i).support := by
  classical
  apply rawRoute_support_cases M i j
  exact SimpleGraph.Walk.support_bypass_subset (rawRoute M i j) hx

private lemma branchSet_eq_of_common
    (M : MinorModel K33 G) {a b : W} {x : V}
    (hxa : x ∈ M.branchSet a) (hxb : x ∈ M.branchSet b) :
    a = b := by
  by_contra hab
  have hd := M.disjoint hab
  rw [Set.disjoint_left] at hd
  exact hd hxa hxb



private lemma canonicalRoute_interiors_disjoint
    (M : MinorModel K33 G) (i j k l : Fin 3)
    (hne : i ≠ k ∨ j ≠ l) :
    Disjoint
      (walkInterior (canonicalRoute M i j))
      (walkInterior (canonicalRoute M k l)) := by
  rw [Set.disjoint_left]
  intro x hx hy
  rcases hx with ⟨hx, hxLeft, hxRight⟩
  rcases hy with ⟨hy, hyLeft, hyRight⟩
  rcases canonicalRoute_support_cases M i j hx with hxi | hxj
  · rcases canonicalRoute_support_cases M k l hy with hxk | hxl
    · have hik : i = k := Sum.inl.inj <|
        branchSet_eq_of_common M
          ((leftFan M i).arm_support j hxi)
          ((leftFan M k).arm_support l hxk)
      subst k
      have hjl : j ≠ l := by
        intro hjl
        exact hne.elim (fun h => h rfl) (fun h => h hjl)
      exact hxLeft <| (leftFan M i).arm_inter hjl hxi hxk
    · have hfalse : (Sum.inl i : W) = Sum.inr l :=
        branchSet_eq_of_common M
          ((leftFan M i).arm_support j hxi)
          ((rightFan M l).arm_support k hxl)
      exact Sum.inl_ne_inr hfalse
  · rcases canonicalRoute_support_cases M k l hy with hxk | hxl
    · have hfalse : (Sum.inr j : W) = Sum.inl k :=
        branchSet_eq_of_common M
          ((rightFan M j).arm_support i hxj)
          ((leftFan M k).arm_support l hxk)
      exact Sum.inr_ne_inl hfalse
    · have hjl : j = l := Sum.inr.inj <|
        branchSet_eq_of_common M
          ((rightFan M j).arm_support i hxj)
          ((rightFan M l).arm_support k hxl)
      subst l
      have hik : i ≠ k := by
        intro hik
        exact hne.elim (fun h => h hik) (fun h => h rfl)
      exact hxRight <| (rightFan M j).arm_inter hik hxj hxl

private lemma walkInterior_reverse
    {a b : V} (P : G.Walk a b) :
    walkInterior P.reverse = walkInterior P := by
  ext x
  simp only [walkInterior, Set.mem_setOf_eq,
    SimpleGraph.Walk.support_reverse, List.mem_reverse]
  aesop

private lemma canonicalRoute_branch_avoids
    (M : MinorModel K33 G) (i j : Fin 3) (w : W) :
    branchPoint M w ∉ walkInterior (canonicalRoute M i j) := by
  intro hw
  rcases canonicalRoute_support_cases M i j hw.1 with hxi | hxj
  · have hwi : w = Sum.inl i :=
      branchSet_eq_of_common M (branchPoint_mem M w)
        ((leftFan M i).arm_support j hxi)
    subst w
    exact hw.2.1 rfl
  · have hwj : w = Sum.inr j :=
      branchSet_eq_of_common M (branchPoint_mem M w)
        ((rightFan M j).arm_support i hxj)
    subst w
    exact hw.2.2 rfl

private noncomputable def route
    (M : MinorModel K33 G) {a b : W} (h : K33.Adj a b) :
    G.Walk (branchPoint M a) (branchPoint M b) := by
  cases a with
  | inl i =>
      cases b with
      | inl k => simp [K33] at h
      | inr j => exact canonicalRoute M i j
  | inr j =>
      cases b with
      | inl i => exact (canonicalRoute M i j).reverse
      | inr l => simp [K33] at h

private lemma route_isPath
    (M : MinorModel K33 G) {a b : W} (h : K33.Adj a b) :
    (route M h).IsPath := by
  classical
  cases a with
  | inl i =>
      cases b with
      | inl k => simp [K33] at h
      | inr j =>
          simpa [route, canonicalRoute] using
            SimpleGraph.Walk.bypass_isPath (rawRoute M i j)
  | inr j =>
      cases b with
      | inl i =>
          change (canonicalRoute M i j).reverse.IsPath
          exact (SimpleGraph.Walk.bypass_isPath (rawRoute M i j)).reverse
      | inr l => simp [K33] at h

private lemma route_branch_avoids
    (M : MinorModel K33 G) {a b : W} (h : K33.Adj a b) (w : W) :
    branchPoint M w ∉ walkInterior (route M h) := by
  classical
  cases a with
  | inl i =>
      cases b with
      | inl k => simp [K33] at h
      | inr j =>
          simpa [route] using canonicalRoute_branch_avoids M i j w
  | inr j =>
      cases b with
      | inl i =>
          change branchPoint M w ∉
            walkInterior ((canonicalRoute M i j).reverse)
          simpa only [walkInterior_reverse] using
            canonicalRoute_branch_avoids M i j w
      | inr l => simp [K33] at h


private lemma route_interiors_disjoint
    (M : MinorModel K33 G)
    {a b c d : W}
    (hab : K33.Adj a b) (hcd : K33.Adj c d)
    (hne : ¬ ((a = c ∧ b = d) ∨ (a = d ∧ b = c))) :
    Disjoint (walkInterior (route M hab))
      (walkInterior (route M hcd)) := by
  classical
  rcases a with i | j
  · rcases b with i' | j'
    · simp [K33] at hab
    · rcases c with k | l
      · rcases d with k' | l'
        · simp [K33] at hcd
        · have hp : i ≠ k ∨ j' ≠ l' := by
            by_contra hp
            push Not at hp
            rcases hp with ⟨rfl, rfl⟩
            exact hne (Or.inl ⟨rfl, rfl⟩)
          simpa only [route] using
            canonicalRoute_interiors_disjoint M i j' k l' hp
      · rcases d with k | l'
        · have hp : i ≠ k ∨ j' ≠ l := by
            by_contra hp
            push Not at hp
            rcases hp with ⟨rfl, rfl⟩
            exact hne (Or.inr ⟨rfl, rfl⟩)
          change Disjoint
            (walkInterior (canonicalRoute M i j'))
            (walkInterior ((canonicalRoute M k l).reverse))
          rw [walkInterior_reverse]
          exact canonicalRoute_interiors_disjoint M i j' k l hp
        · simp [K33] at hcd
  · rcases b with i | j'
    · rcases c with k | l
      · rcases d with k' | l'
        · simp [K33] at hcd
        · have hp : i ≠ k ∨ j ≠ l' := by
            by_contra hp
            push Not at hp
            rcases hp with ⟨rfl, rfl⟩
            exact hne (Or.inr ⟨rfl, rfl⟩)
          change Disjoint
            (walkInterior ((canonicalRoute M i j).reverse))
            (walkInterior (canonicalRoute M k l'))
          rw [walkInterior_reverse]
          exact canonicalRoute_interiors_disjoint M i j k l' hp
      · rcases d with k | l'
        · have hp : i ≠ k ∨ j ≠ l := by
            by_contra hp
            push Not at hp
            rcases hp with ⟨rfl, rfl⟩
            exact hne (Or.inl ⟨rfl, rfl⟩)
          change Disjoint
            (walkInterior ((canonicalRoute M i j).reverse))
            (walkInterior ((canonicalRoute M k l).reverse))
          rw [walkInterior_reverse, walkInterior_reverse]
          exact canonicalRoute_interiors_disjoint M i j k l hp
        · simp [K33] at hcd
    · simp [K33] at hab


/--
---
conclusion: Lax68.K33MinorTopologicalObstruction.k33Minor_topologicalMinor
assumptions:
  - Lax68.ConnectedThreeFan.exists_threeFan
---
Choose one witness edge for every edge of K₃,₃. Inside each branch set, a
three-fan joins the three witness endpoints to one branch vertex. Concatenating
these arms with the witness edges gives the required subdivision paths.
-/
theorem k33Minor_topologicalMinor :
    IsMinor K33 G →
      IsTopologicalMinor K33 G := by
  rintro ⟨M⟩
  refine ⟨{
    branch := branchEmbedding M
    route := fun h => route M h
    route_isPath := fun h => route_isPath M h
    branch_avoids_interiors := fun h w =>
      route_branch_avoids M h w
    route_interiors_disjoint := fun hab hcd hne =>
      route_interiors_disjoint M hab hcd hne
  }⟩

end Lax68Proofs.K33MinorTopologicalObstruction
