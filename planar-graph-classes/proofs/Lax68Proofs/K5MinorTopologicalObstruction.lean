import Lax68.K5MinorTopologicalObstruction
import Lax68.ConnectedFourTerminalDichotomy
import Lax68.K33MinorTopologicalObstruction

set_option autoImplicit false

namespace Lax68Proofs.K5MinorTopologicalObstruction

open Lax68.GraphMinors
open Lax68.GraphTopologicalMinors
open Lax68.FourTerminalFans

universe u

variable {V : Type u} {G : SimpleGraph V}

private lemma k5_adj_of_ne {i j : Fin 5} (h : i ≠ j) :
    K5.Adj i j := by
  simpa [K5] using h

private structure Link (M : MinorModel K5 G)
    (i j : Fin 5) where
  left : V
  right : V
  left_mem : left ∈ M.branchSet i
  right_mem : right ∈ M.branchSet j
  adj : G.Adj left right

private noncomputable def linkUp
    (M : MinorModel K5 G) (i j : Fin 5) (hij : i < j) :
    Link M i j :=
  Classical.choice <| by
    rcases M.adjacent (k5_adj_of_ne hij.ne) with
      ⟨x, hx, y, hy, hxy⟩
    exact ⟨⟨x, y, hx, hy, hxy⟩⟩

private noncomputable def endpoint
    (M : MinorModel K5 G) (i j : Fin 5) (hij : i ≠ j) : V :=
  if h : i < j then
    (linkUp M i j h).left
  else
    (linkUp M j i ((Fin.lt_or_lt_of_ne hij).resolve_left h)).right

private lemma endpoint_mem
    (M : MinorModel K5 G) (i j : Fin 5) (hij : i ≠ j) :
    endpoint M i j hij ∈ M.branchSet i := by
  by_cases h : i < j
  · simpa [endpoint, h] using (linkUp M i j h).left_mem
  · let hji : j < i := (Fin.lt_or_lt_of_ne hij).resolve_left h
    simpa [endpoint, h, hji] using (linkUp M j i hji).right_mem

private lemma endpoint_adj
    (M : MinorModel K5 G) (i j : Fin 5) (hij : i ≠ j) :
    G.Adj (endpoint M i j hij) (endpoint M j i hij.symm) := by
  by_cases h : i < j
  · have hji : ¬j < i := not_lt_of_ge h.le
    simpa [endpoint, h, hji] using (linkUp M i j h).adj
  · let hji : j < i := (Fin.lt_or_lt_of_ne hij).resolve_left h
    simpa [endpoint, h, hji] using (linkUp M j i hji).adj.symm

private noncomputable def port
    (M : MinorModel K5 G) (i : Fin 5) (k : Fin 4) : V :=
  endpoint M i (i.succAbove k) (Fin.ne_succAbove i k)

private lemma port_mem
    (M : MinorModel K5 G) (i : Fin 5) (k : Fin 4) :
    port M i k ∈ M.branchSet i :=
  endpoint_mem M i (i.succAbove k) (Fin.ne_succAbove i k)

private noncomputable def branchPort
    (M : MinorModel K5 G) (i : Fin 5) (k : Fin 4) :
    M.branchSet i :=
  ⟨port M i k, port_mem M i k⟩

private lemma mem_support_of_mem_mapped_support
    {S : Set V} {a b : S}
    {P : (G.induce S).Walk a b} {x : V}
    (hx : x ∈ (P.map (SimpleGraph.Embedding.induce S).toHom).support) :
    ∃ y ∈ P.support, (y : V) = x := by
  simpa only [SimpleGraph.Walk.support_map, List.mem_map] using hx

private noncomputable def mapFour
    {S : Set V} {a b c d : S}
    (F : FourFan (G.induce S) a b c d) :
    FourFan G (a : V) (b : V) (c : V) (d : V) := by
  let e := SimpleGraph.Embedding.induce (G := G) S
  refine {
    center := F.center
    toA := F.toA.map e.toHom
    toB := F.toB.map e.toHom
    toC := F.toC.map e.toHom
    toD := F.toD.map e.toHom
    toA_isPath := SimpleGraph.Walk.map_isPath_of_injective
      e.injective F.toA_isPath
    toB_isPath := SimpleGraph.Walk.map_isPath_of_injective
      e.injective F.toB_isPath
    toC_isPath := SimpleGraph.Walk.map_isPath_of_injective
      e.injective F.toC_isPath
    toD_isPath := SimpleGraph.Walk.map_isPath_of_injective
      e.injective F.toD_isPath
    toA_toB := ?_
    toA_toC := ?_
    toA_toD := ?_
    toB_toC := ?_
    toB_toD := ?_
    toC_toD := ?_
  }
  all_goals
    intro x hx₁ hx₂
    rcases mem_support_of_mem_mapped_support hx₁ with ⟨y, hy, rfl⟩
    rcases mem_support_of_mem_mapped_support hx₂ with ⟨z, hz, hzy⟩
    have hyz : y = z := Subtype.ext hzy.symm
    have hyz : y = z := Subtype.ext hzy.symm
    subst z
  · exact congrArg Subtype.val (F.toA_toB hy hz)
  · exact congrArg Subtype.val (F.toA_toC hy hz)
  · exact congrArg Subtype.val (F.toA_toD hy hz)
  · exact congrArg Subtype.val (F.toB_toC hy hz)
  · exact congrArg Subtype.val (F.toB_toD hy hz)
  · exact congrArg Subtype.val (F.toC_toD hy hz)

private noncomputable def mapSplit
    {S : Set V} {a b c d : S}
    (F : SplitFourFan (G.induce S) a b c d) :
    SplitFourFan G (a : V) (b : V) (c : V) (d : V) := by
  let e := SimpleGraph.Embedding.induce (G := G) S
  refine {
    leftCenter := F.leftCenter
    rightCenter := F.rightCenter
    centers_ne := by
      intro h
      exact F.centers_ne (Subtype.ext h)
    toA := F.toA.map e.toHom
    toB := F.toB.map e.toHom
    bridge := F.bridge.map e.toHom
    toC := F.toC.map e.toHom
    toD := F.toD.map e.toHom
    toA_isPath := SimpleGraph.Walk.map_isPath_of_injective
      e.injective F.toA_isPath
    toB_isPath := SimpleGraph.Walk.map_isPath_of_injective
      e.injective F.toB_isPath
    bridge_isPath := SimpleGraph.Walk.map_isPath_of_injective
      e.injective F.bridge_isPath
    toC_isPath := SimpleGraph.Walk.map_isPath_of_injective
      e.injective F.toC_isPath
    toD_isPath := SimpleGraph.Walk.map_isPath_of_injective
      e.injective F.toD_isPath
    left_arms_meet := ?_
    right_arms_meet := ?_
    opposite_arms_disjoint := ?_
    bridge_meets_left := ?_
    bridge_meets_right := ?_
  }
  · intro x hxA hxB
    rcases mem_support_of_mem_mapped_support hxA with ⟨y, hy, rfl⟩
    rcases mem_support_of_mem_mapped_support hxB with ⟨z, hz, hzy⟩
    have hyz : y = z := Subtype.ext hzy.symm
    subst z
    exact congrArg Subtype.val (F.left_arms_meet hy hz)
  · intro x hxC hxD
    rcases mem_support_of_mem_mapped_support hxC with ⟨y, hy, rfl⟩
    rcases mem_support_of_mem_mapped_support hxD with ⟨z, hz, hzy⟩
    have hyz : y = z := Subtype.ext hzy.symm
    subst z
    exact congrArg Subtype.val (F.right_arms_meet hy hz)
  · intro x hxLeft hxRight
    rcases hxLeft with hxA | hxB
    · rcases mem_support_of_mem_mapped_support hxA with ⟨y, hy, rfl⟩
      rcases hxRight with hxC | hxD
      · rcases mem_support_of_mem_mapped_support hxC with ⟨z, hz, hzy⟩
        have hyz : y = z := Subtype.ext hzy.symm
        subst z
        exact F.opposite_arms_disjoint (.inl hy) (.inl hz)
      · rcases mem_support_of_mem_mapped_support hxD with ⟨z, hz, hzy⟩
        have hyz : y = z := Subtype.ext hzy.symm
        subst z
        exact F.opposite_arms_disjoint (.inl hy) (.inr hz)
    · rcases mem_support_of_mem_mapped_support hxB with ⟨y, hy, rfl⟩
      rcases hxRight with hxC | hxD
      · rcases mem_support_of_mem_mapped_support hxC with ⟨z, hz, hzy⟩
        have hyz : y = z := Subtype.ext hzy.symm
        subst z
        exact F.opposite_arms_disjoint (.inr hy) (.inl hz)
      · rcases mem_support_of_mem_mapped_support hxD with ⟨z, hz, hzy⟩
        have hyz : y = z := Subtype.ext hzy.symm
        subst z
        exact F.opposite_arms_disjoint (.inr hy) (.inr hz)
  · intro x hxBridge hxLeft
    rcases mem_support_of_mem_mapped_support hxBridge with ⟨y, hy, rfl⟩
    rcases hxLeft with hxA | hxB
    · rcases mem_support_of_mem_mapped_support hxA with ⟨z, hz, hzy⟩
      have hyz : y = z := Subtype.ext hzy.symm
      subst z
      exact congrArg Subtype.val (F.bridge_meets_left hy (.inl hz))
    · rcases mem_support_of_mem_mapped_support hxB with ⟨z, hz, hzy⟩
      have hyz : y = z := Subtype.ext hzy.symm
      subst z
      exact congrArg Subtype.val (F.bridge_meets_left hy (.inr hz))
  · intro x hxBridge hxRight
    rcases mem_support_of_mem_mapped_support hxBridge with ⟨y, hy, rfl⟩
    rcases hxRight with hxC | hxD
    · rcases mem_support_of_mem_mapped_support hxC with ⟨z, hz, hzy⟩
      have hyz : y = z := Subtype.ext hzy.symm
      subst z
      exact congrArg Subtype.val (F.bridge_meets_right hy (.inl hz))
    · rcases mem_support_of_mem_mapped_support hxD with ⟨z, hz, hzy⟩
      have hyz : y = z := Subtype.ext hzy.symm
      subst z
      exact congrArg Subtype.val (F.bridge_meets_right hy (.inr hz))

private structure BranchFour
    (M : MinorModel K5 G) (i : Fin 5) where
  fan : FourFan G (port M i 0) (port M i 1)
    (port M i 2) (port M i 3)
  center_mem : fan.center ∈ M.branchSet i
  toA_support :
    ∀ {x}, x ∈ fan.toA.support → x ∈ M.branchSet i
  toB_support :
    ∀ {x}, x ∈ fan.toB.support → x ∈ M.branchSet i
  toC_support :
    ∀ {x}, x ∈ fan.toC.support → x ∈ M.branchSet i
  toD_support :
    ∀ {x}, x ∈ fan.toD.support → x ∈ M.branchSet i

private structure BranchSplit
    (M : MinorModel K5 G) (i : Fin 5)
    (a b c d : Fin 4) where
  fan : SplitFourFan G (port M i a) (port M i b)
    (port M i c) (port M i d)
  left_mem : fan.leftCenter ∈ M.branchSet i
  right_mem : fan.rightCenter ∈ M.branchSet i
  toA_support :
    ∀ {x}, x ∈ fan.toA.support → x ∈ M.branchSet i
  toB_support :
    ∀ {x}, x ∈ fan.toB.support → x ∈ M.branchSet i
  bridge_support :
    ∀ {x}, x ∈ fan.bridge.support → x ∈ M.branchSet i
  toC_support :
    ∀ {x}, x ∈ fan.toC.support → x ∈ M.branchSet i
  toD_support :
    ∀ {x}, x ∈ fan.toD.support → x ∈ M.branchSet i

private noncomputable def branchDichotomy
    (M : MinorModel K5 G) (i : Fin 5) :
    Nonempty (BranchFour M i) ∨
    Nonempty (BranchSplit M i 0 1 2 3) ∨
    Nonempty (BranchSplit M i 0 2 1 3) ∨
    Nonempty (BranchSplit M i 1 2 0 3) := by
  let p0 := branchPort M i 0
  let p1 := branchPort M i 1
  let p2 := branchPort M i 2
  let p3 := branchPort M i 3
  rcases
      Lax68.ConnectedFourTerminalDichotomy.exists_fourFan_or_split
        (M.connected i) p0 p1 p2 p3 with
    hF | hS | hS | hS
  · rcases hF with ⟨F⟩
    let F' := mapFour F
    left
    refine ⟨{
      fan := F'
      center_mem := F.center.property
      toA_support := ?_
      toB_support := ?_
      toC_support := ?_
      toD_support := ?_
    }⟩
    all_goals
      intro x hx
      rcases mem_support_of_mem_mapped_support hx with ⟨y, hy, rfl⟩
      exact y.property
  · rcases hS with ⟨F⟩
    let F' := mapSplit F
    right; left
    refine ⟨{
      fan := F'
      left_mem := F.leftCenter.property
      right_mem := F.rightCenter.property
      toA_support := ?_
      toB_support := ?_
      bridge_support := ?_
      toC_support := ?_
      toD_support := ?_
    }⟩
    all_goals
      intro x hx
      rcases mem_support_of_mem_mapped_support hx with ⟨y, hy, rfl⟩
      exact y.property
  · rcases hS with ⟨F⟩
    let F' := mapSplit F
    right; right; left
    refine ⟨{
      fan := F'
      left_mem := F.leftCenter.property
      right_mem := F.rightCenter.property
      toA_support := ?_
      toB_support := ?_
      bridge_support := ?_
      toC_support := ?_
      toD_support := ?_
    }⟩
    all_goals
      intro x hx
      rcases mem_support_of_mem_mapped_support hx with ⟨y, hy, rfl⟩
      exact y.property
  · rcases hS with ⟨F⟩
    let F' := mapSplit F
    right; right; right
    refine ⟨{
      fan := F'
      left_mem := F.leftCenter.property
      right_mem := F.rightCenter.property
      toA_support := ?_
      toB_support := ?_
      bridge_support := ?_
      toC_support := ?_
      toD_support := ?_
    }⟩
    all_goals
      intro x hx
      rcases mem_support_of_mem_mapped_support hx with ⟨y, hy, rfl⟩
      exact y.property

private noncomputable def otherIndex
    (i j : Fin 5) (hji : j ≠ i) : Fin 4 :=
  Classical.choose (Fin.exists_succAbove_eq hji)

private lemma otherIndex_spec
    (i j : Fin 5) (hji : j ≠ i) :
    i.succAbove (otherIndex i j hji) = j :=
  Classical.choose_spec (Fin.exists_succAbove_eq hji)

private noncomputable def fanArm
    (M : MinorModel K5 G) (i : Fin 5)
    (F : BranchFour M i) (k : Fin 4) :
    G.Walk F.fan.center (port M i k) :=
  Fin.cases F.fan.toA
    (Fin.cases F.fan.toB
      (Fin.cases F.fan.toC
        (Fin.cases F.fan.toD (fun k => Fin.elim0 k)))) k

private lemma fanArm_isPath
    (M : MinorModel K5 G) (i : Fin 5)
    (F : BranchFour M i) (k : Fin 4) :
    (fanArm M i F k).IsPath := by
  have hk : k = 0 ∨ k = 1 ∨ k = 2 ∨ k = 3 := by omega
  rcases hk with rfl | rfl | rfl | rfl
  · simpa [fanArm] using F.fan.toA_isPath
  · simpa [fanArm] using F.fan.toB_isPath
  · simpa [fanArm] using F.fan.toC_isPath
  · simpa [fanArm] using F.fan.toD_isPath

private lemma fanArm_support
    (M : MinorModel K5 G) (i : Fin 5)
    (F : BranchFour M i) (k : Fin 4) {x : V}
    (hx : x ∈ (fanArm M i F k).support) :
    x ∈ M.branchSet i := by
  have hk : k = 0 ∨ k = 1 ∨ k = 2 ∨ k = 3 := by omega
  rcases hk with rfl | rfl | rfl | rfl
  · exact F.toA_support (by simpa [fanArm] using hx)
  · exact F.toB_support (by simpa [fanArm] using hx)
  · exact F.toC_support (by simpa [fanArm] using hx)
  · exact F.toD_support (by simpa [fanArm] using hx)

private lemma fanArm_inter
    (M : MinorModel K5 G) (i : Fin 5)
    (F : BranchFour M i) {k l : Fin 4} (hkl : k ≠ l)
    {x : V}
    (hxk : x ∈ (fanArm M i F k).support)
    (hxl : x ∈ (fanArm M i F l).support) :
    x = F.fan.center := by
  have hk : k = 0 ∨ k = 1 ∨ k = 2 ∨ k = 3 := by omega
  have hl : l = 0 ∨ l = 1 ∨ l = 2 ∨ l = 3 := by omega
  rcases hk with rfl | rfl | rfl | rfl <;>
    rcases hl with rfl | rfl | rfl | rfl
  all_goals try exact (hkl rfl).elim
  · exact F.fan.toA_toB (by simpa [fanArm] using hxk)
      (by simpa [fanArm] using hxl)
  · exact F.fan.toA_toC (by simpa [fanArm] using hxk)
      (by simpa [fanArm] using hxl)
  · exact F.fan.toA_toD (by simpa [fanArm] using hxk)
      (by simpa [fanArm] using hxl)
  · exact F.fan.toA_toB (by simpa [fanArm] using hxl)
      (by simpa [fanArm] using hxk)
  · exact F.fan.toB_toC (by simpa [fanArm] using hxk)
      (by simpa [fanArm] using hxl)
  · exact F.fan.toB_toD (by simpa [fanArm] using hxk)
      (by simpa [fanArm] using hxl)
  · exact F.fan.toA_toC (by simpa [fanArm] using hxl)
      (by simpa [fanArm] using hxk)
  · exact F.fan.toB_toC (by simpa [fanArm] using hxl)
      (by simpa [fanArm] using hxk)
  · exact F.fan.toC_toD (by simpa [fanArm] using hxk)
      (by simpa [fanArm] using hxl)
  · exact F.fan.toA_toD (by simpa [fanArm] using hxl)
      (by simpa [fanArm] using hxk)
  · exact F.fan.toB_toD (by simpa [fanArm] using hxl)
      (by simpa [fanArm] using hxk)
  · exact F.fan.toC_toD (by simpa [fanArm] using hxl)
      (by simpa [fanArm] using hxk)

private noncomputable def branchArm
    (M : MinorModel K5 G) (i j : Fin 5)
    (hij : i ≠ j) (F : BranchFour M i) :
    G.Walk F.fan.center (endpoint M i j hij) :=
  (fanArm M i F (otherIndex i j hij.symm)).copy rfl <| by
    simp only [port, otherIndex_spec]

private lemma branchArm_isPath
    (M : MinorModel K5 G) (i j : Fin 5)
    (hij : i ≠ j) (F : BranchFour M i) :
    (branchArm M i j hij F).IsPath := by
  simpa only [branchArm, SimpleGraph.Walk.isPath_copy] using
    fanArm_isPath M i F (otherIndex i j hij.symm)

private lemma branchArm_support
    (M : MinorModel K5 G) (i j : Fin 5)
    (hij : i ≠ j) (F : BranchFour M i) {x : V}
    (hx : x ∈ (branchArm M i j hij F).support) :
    x ∈ M.branchSet i := by
  apply fanArm_support M i F (otherIndex i j hij.symm)
  simpa only [branchArm, SimpleGraph.Walk.support_copy] using hx

private lemma branchArm_inter
    (M : MinorModel K5 G) (i j k : Fin 5)
    (hij : i ≠ j) (hik : i ≠ k) (hjk : j ≠ k)
    (F : BranchFour M i) {x : V}
    (hxj : x ∈ (branchArm M i j hij F).support)
    (hxk : x ∈ (branchArm M i k hik F).support) :
    x = F.fan.center := by
  apply fanArm_inter M i F
    (k := otherIndex i j hij.symm)
    (l := otherIndex i k hik.symm)
  · intro heq
    apply hjk
    rw [← otherIndex_spec i j hij.symm,
      ← otherIndex_spec i k hik.symm, heq]
  · simpa only [branchArm, SimpleGraph.Walk.support_copy] using hxj
  · simpa only [branchArm, SimpleGraph.Walk.support_copy] using hxk

private lemma branchSet_eq_of_common
    (M : MinorModel K5 G) {i j : Fin 5} {x : V}
    (hxi : x ∈ M.branchSet i) (hxj : x ∈ M.branchSet j) :
    i = j := by
  by_contra hij
  have hd := M.disjoint hij
  rw [Set.disjoint_left] at hd
  exact hd hxi hxj

private noncomputable def hub
    (M : MinorModel K5 G)
    (hAll : ∀ i, Nonempty (BranchFour M i))
    (i : Fin 5) : BranchFour M i :=
  Classical.choice (hAll i)

private noncomputable def hubPoint
    (M : MinorModel K5 G)
    (hAll : ∀ i, Nonempty (BranchFour M i))
    (i : Fin 5) : V :=
  (hub M hAll i).fan.center

private lemma hubPoint_mem
    (M : MinorModel K5 G)
    (hAll : ∀ i, Nonempty (BranchFour M i))
    (i : Fin 5) :
    hubPoint M hAll i ∈ M.branchSet i :=
  (hub M hAll i).center_mem

private lemma hubPoint_injective
    (M : MinorModel K5 G)
    (hAll : ∀ i, Nonempty (BranchFour M i)) :
    Function.Injective (hubPoint M hAll) := by
  intro i j hij
  by_contra hne
  have hd := M.disjoint hne
  rw [Set.disjoint_left] at hd
  exact hd (hubPoint_mem M hAll i) (hij ▸ hubPoint_mem M hAll j)

private noncomputable def hubEmbedding
    (M : MinorModel K5 G)
    (hAll : ∀ i, Nonempty (BranchFour M i)) :
    Fin 5 ↪ V where
  toFun := hubPoint M hAll
  inj' := hubPoint_injective M hAll

private noncomputable def rawHubRoute
    (M : MinorModel K5 G)
    (hAll : ∀ i, Nonempty (BranchFour M i))
    (i j : Fin 5) (hij : i ≠ j) :
    G.Walk (hubPoint M hAll i) (hubPoint M hAll j) :=
  (branchArm M i j hij (hub M hAll i)).append <|
    .cons (endpoint_adj M i j hij)
      (branchArm M j i hij.symm (hub M hAll j)).reverse

private noncomputable def canonicalHubRoute
    (M : MinorModel K5 G)
    (hAll : ∀ i, Nonempty (BranchFour M i))
    (i j : Fin 5) (hij : i ≠ j) :
    G.Walk (hubPoint M hAll i) (hubPoint M hAll j) := by
  classical
  exact (rawHubRoute M hAll i j hij).bypass

private lemma rawHubRoute_support_cases
    (M : MinorModel K5 G)
    (hAll : ∀ i, Nonempty (BranchFour M i))
    (i j : Fin 5) (hij : i ≠ j) {x : V}
    (hx : x ∈ (rawHubRoute M hAll i j hij).support) :
    x ∈ (branchArm M i j hij (hub M hAll i)).support ∨
    x ∈ (branchArm M j i hij.symm (hub M hAll j)).support := by
  change x ∈ ((branchArm M i j hij (hub M hAll i)).append <|
    .cons (endpoint_adj M i j hij)
      (branchArm M j i hij.symm (hub M hAll j)).reverse).support at hx
  rw [SimpleGraph.Walk.mem_support_append_iff] at hx
  rcases hx with hx | hx
  · exact .inl hx
  rw [SimpleGraph.Walk.support_cons, List.mem_cons] at hx
  rcases hx with rfl | hx
  · exact .inl (SimpleGraph.Walk.end_mem_support _)
  · right
    simpa only [SimpleGraph.Walk.support_reverse, List.mem_reverse] using hx

private lemma canonicalHubRoute_support_cases
    (M : MinorModel K5 G)
    (hAll : ∀ i, Nonempty (BranchFour M i))
    (i j : Fin 5) (hij : i ≠ j) {x : V}
    (hx : x ∈ (canonicalHubRoute M hAll i j hij).support) :
    x ∈ (branchArm M i j hij (hub M hAll i)).support ∨
    x ∈ (branchArm M j i hij.symm (hub M hAll j)).support := by
  classical
  apply rawHubRoute_support_cases M hAll i j hij
  exact SimpleGraph.Walk.support_bypass_subset
    (rawHubRoute M hAll i j hij) hx

private lemma canonicalHubRoute_branch_avoids
    (M : MinorModel K5 G)
    (hAll : ∀ i, Nonempty (BranchFour M i))
    (i j : Fin 5) (hij : i ≠ j) (w : Fin 5) :
    hubPoint M hAll w ∉
      walkInterior (canonicalHubRoute M hAll i j hij) := by
  intro hw
  rcases canonicalHubRoute_support_cases M hAll i j hij hw.1 with
    hxi | hxj
  · have hwi : w = i :=
      branchSet_eq_of_common M (hubPoint_mem M hAll w)
        (branchArm_support M i j hij (hub M hAll i) hxi)
    subst w
    exact hw.2.1 rfl
  · have hwj : w = j :=
      branchSet_eq_of_common M (hubPoint_mem M hAll w)
        (branchArm_support M j i hij.symm (hub M hAll j) hxj)
    subst w
    exact hw.2.2 rfl

private lemma canonicalHubRoute_interiors_disjoint
    (M : MinorModel K5 G)
    (hAll : ∀ i, Nonempty (BranchFour M i))
    (i j k l : Fin 5) (hij : i ≠ j) (hkl : k ≠ l)
    (hne : ¬ ((i = k ∧ j = l) ∨ (i = l ∧ j = k))) :
    Disjoint
      (walkInterior (canonicalHubRoute M hAll i j hij))
      (walkInterior (canonicalHubRoute M hAll k l hkl)) := by
  rw [Set.disjoint_left]
  intro x hx hy
  rcases hx with ⟨hx, hxStart, hxEnd⟩
  rcases hy with ⟨hy, hyStart, hyEnd⟩
  rcases canonicalHubRoute_support_cases M hAll i j hij hx with
    hxi | hxj
  · rcases canonicalHubRoute_support_cases M hAll k l hkl hy with
      hxk | hxl
    · have hik : i = k := branchSet_eq_of_common M
        (branchArm_support M i j hij (hub M hAll i) hxi)
        (branchArm_support M k l hkl (hub M hAll k) hxk)
      subst k
      have hjl : j ≠ l := by
        intro hjl
        exact hne (.inl ⟨rfl, hjl⟩)
      exact hxStart <| branchArm_inter M i j l hij hkl hjl
        (hub M hAll i) hxi hxk
    · have hil : i = l := branchSet_eq_of_common M
        (branchArm_support M i j hij (hub M hAll i) hxi)
        (branchArm_support M l k hkl.symm (hub M hAll l) hxl)
      subst l
      have hjk : j ≠ k := by
        intro hjk
        exact hne (.inr ⟨rfl, hjk⟩)
      exact hxStart <| branchArm_inter M i j k hij hkl.symm hjk
        (hub M hAll i) hxi hxl
  · rcases canonicalHubRoute_support_cases M hAll k l hkl hy with
      hxk | hxl
    · have hjk : j = k := branchSet_eq_of_common M
        (branchArm_support M j i hij.symm (hub M hAll j) hxj)
        (branchArm_support M k l hkl (hub M hAll k) hxk)
      subst k
      have hil : i ≠ l := by
        intro hil
        exact hne (.inr ⟨hil, rfl⟩)
      exact hxEnd <| branchArm_inter M j i l hij.symm hkl hil
        (hub M hAll j) hxj hxk
    · have hjl : j = l := branchSet_eq_of_common M
        (branchArm_support M j i hij.symm (hub M hAll j) hxj)
        (branchArm_support M l k hkl.symm (hub M hAll l) hxl)
      subst l
      have hik : i ≠ k := by
        intro hik
        exact hne (.inl ⟨hik, rfl⟩)
      exact hxEnd <| branchArm_inter M j i k hij.symm hkl.symm hik
        (hub M hAll j) hxj hxl

private def supportSet {a b : V} (P : G.Walk a b) : Set V :=
  {x | x ∈ P.support}

private def splitLeftSet
    {M : MinorModel K5 G} {i : Fin 5} {a b c d : Fin 4}
    (S : BranchSplit M i a b c d) : Set V :=
  supportSet S.fan.toA ∪ supportSet S.fan.toB

private def splitRightSet
    {M : MinorModel K5 G} {i : Fin 5} {a b c d : Fin 4}
    (S : BranchSplit M i a b c d)
    {v : V} (tail : G.Walk v S.fan.rightCenter) : Set V :=
  (supportSet tail ∪ supportSet S.fan.toC) ∪
    supportSet S.fan.toD

private lemma connected_of_center_paths
    (s : Set V) (center : V) (hcenter : center ∈ s)
    (hpaths :
      ∀ x, x ∈ s →
        ∃ P : G.Walk center x,
          ∀ {z}, z ∈ P.support → z ∈ s) :
    (G.induce s).Connected := by
  rw [SimpleGraph.connected_iff_exists_forall_reachable]
  refine ⟨⟨center, hcenter⟩, ?_⟩
  intro x
  rcases hpaths x x.property with ⟨P, hP⟩
  exact ⟨P.induce s (fun z hz => hP hz)⟩

private lemma splitLeft_connected
    {M : MinorModel K5 G} {i : Fin 5} {a b c d : Fin 4}
    (S : BranchSplit M i a b c d) :
    (G.induce (splitLeftSet S)).Connected := by
  classical
  apply connected_of_center_paths (splitLeftSet S) S.fan.leftCenter
  · exact .inl (SimpleGraph.Walk.start_mem_support _)
  · intro x hx
    rcases hx with hxA | hxB
    · refine ⟨S.fan.toA.takeUntil x hxA, ?_⟩
      intro z hz
      left
      exact S.fan.toA.support_takeUntil_subset_support hxA hz
    · refine ⟨S.fan.toB.takeUntil x hxB, ?_⟩
      intro z hz
      right
      exact S.fan.toB.support_takeUntil_subset_support hxB hz

private lemma splitRight_connected
    {M : MinorModel K5 G} {i : Fin 5} {a b c d : Fin 4}
    (S : BranchSplit M i a b c d)
    {v : V} (tail : G.Walk v S.fan.rightCenter) :
    (G.induce (splitRightSet S tail)).Connected := by
  classical
  apply connected_of_center_paths
    (splitRightSet S tail) S.fan.rightCenter
  · exact .inl (.inl (SimpleGraph.Walk.end_mem_support _))
  · intro x hx
    rcases hx with (hxTail | hxC) | hxD
    · refine ⟨(tail.dropUntil x hxTail).reverse, ?_⟩
      intro z hz
      left; left
      rw [SimpleGraph.Walk.support_reverse, List.mem_reverse] at hz
      exact tail.support_dropUntil_subset hxTail hz
    · refine ⟨S.fan.toC.takeUntil x hxC, ?_⟩
      intro z hz
      left; right
      exact S.fan.toC.support_takeUntil_subset_support hxC hz
    · refine ⟨S.fan.toD.takeUntil x hxD, ?_⟩
      intro z hz
      right
      exact S.fan.toD.support_takeUntil_subset_support hxD hz

private lemma splitLeft_subset
    {M : MinorModel K5 G} {i : Fin 5} {a b c d : Fin 4}
    (S : BranchSplit M i a b c d) :
    splitLeftSet S ⊆ M.branchSet i := by
  intro x hx
  rcases hx with hxA | hxB
  · exact S.toA_support hxA
  · exact S.toB_support hxB

private lemma splitRight_subset
    {M : MinorModel K5 G} {i : Fin 5} {a b c d : Fin 4}
    (S : BranchSplit M i a b c d)
    {v : V} (hadj : G.Adj S.fan.leftCenter v)
    (tail : G.Walk v S.fan.rightCenter)
    (hbridge : S.fan.bridge = .cons hadj tail) :
    splitRightSet S tail ⊆ M.branchSet i := by
  intro x hx
  rcases hx with (hxTail | hxC) | hxD
  · apply S.bridge_support
    rw [hbridge, SimpleGraph.Walk.support_cons, List.mem_cons]
    exact .inr hxTail
  · exact S.toC_support hxC
  · exact S.toD_support hxD

private lemma splitSets_disjoint
    {M : MinorModel K5 G} {i : Fin 5} {a b c d : Fin 4}
    (S : BranchSplit M i a b c d)
    {v : V} (hadj : G.Adj S.fan.leftCenter v)
    (tail : G.Walk v S.fan.rightCenter)
    (hbridge : S.fan.bridge = .cons hadj tail) :
    Disjoint (splitLeftSet S) (splitRightSet S tail) := by
  have hleft_not_tail :
      S.fan.leftCenter ∉ tail.support := by
    have hn := S.fan.bridge_isPath.support_nodup
    rw [hbridge, SimpleGraph.Walk.support_cons,
      List.nodup_cons] at hn
    exact hn.1
  rw [Set.disjoint_left]
  intro x hxLeft hxRight
  rcases hxLeft with hxA | hxB
  · rcases hxRight with (hxTail | hxC) | hxD
    · have hxBridge : x ∈ S.fan.bridge.support := by
        rw [hbridge, SimpleGraph.Walk.support_cons, List.mem_cons]
        exact .inr hxTail
      have hxeq :=
        S.fan.bridge_meets_left hxBridge (.inl hxA)
      exact hleft_not_tail (hxeq ▸ hxTail)
    · exact S.fan.opposite_arms_disjoint (.inl hxA) (.inl hxC)
    · exact S.fan.opposite_arms_disjoint (.inl hxA) (.inr hxD)
  · rcases hxRight with (hxTail | hxC) | hxD
    · have hxBridge : x ∈ S.fan.bridge.support := by
        rw [hbridge, SimpleGraph.Walk.support_cons, List.mem_cons]
        exact .inr hxTail
      have hxeq :=
        S.fan.bridge_meets_left hxBridge (.inr hxB)
      exact hleft_not_tail (hxeq ▸ hxTail)
    · exact S.fan.opposite_arms_disjoint (.inr hxB) (.inl hxC)
    · exact S.fan.opposite_arms_disjoint (.inr hxB) (.inr hxD)

private theorem split_yields_k33_minor
    (M : MinorModel K5 G) (i : Fin 5) (a b c d : Fin 4)
    (S : BranchSplit M i a b c d)
    (hab : a ≠ b) (hac : a ≠ c) (had : a ≠ d)
    (hbc : b ≠ c) (hbd : b ≠ d) (hcd : c ≠ d) :
    IsMinor K33 G := by
  let A := i.succAbove a
  let B := i.succAbove b
  let C := i.succAbove c
  let D := i.succAbove d
  have hiA : i ≠ A := Fin.ne_succAbove i a
  have hiB : i ≠ B := Fin.ne_succAbove i b
  have hiC : i ≠ C := Fin.ne_succAbove i c
  have hiD : i ≠ D := Fin.ne_succAbove i d
  have hAB : A ≠ B := by
    intro h
    exact hab (Fin.succAbove_right_injective h)
  have hAC : A ≠ C := by
    intro h
    exact hac (Fin.succAbove_right_injective h)
  have hAD : A ≠ D := by
    intro h
    exact had (Fin.succAbove_right_injective h)
  have hBC : B ≠ C := by
    intro h
    exact hbc (Fin.succAbove_right_injective h)
  have hBD : B ≠ D := by
    intro h
    exact hbd (Fin.succAbove_right_injective h)
  have hCD : C ≠ D := by
    intro h
    exact hcd (Fin.succAbove_right_injective h)
  obtain ⟨v, hadj, tail, hbridge⟩ :=
    S.fan.bridge.exists_eq_cons_of_ne S.fan.centers_ne
  let leftBranch : Fin 3 → Set V :=
    Fin.cases (splitLeftSet S)
      (Fin.cases (M.branchSet C)
        (Fin.cases (M.branchSet D) (fun k => Fin.elim0 k)))
  let rightBranch : Fin 3 → Set V :=
    Fin.cases (splitRightSet S tail)
      (Fin.cases (M.branchSet A)
        (Fin.cases (M.branchSet B) (fun k => Fin.elim0 k)))
  let branchSet : (Fin 3 ⊕ Fin 3) → Set V
    | Sum.inl k => leftBranch k
    | Sum.inr k => rightBranch k
  have hconnected :
      ∀ w, (G.induce (branchSet w)).Connected := by
    intro w
    rcases w with k | k
    · have hk : k = 0 ∨ k = 1 ∨ k = 2 := by omega
      rcases hk with rfl | rfl | rfl
      · simpa [branchSet, leftBranch] using splitLeft_connected S
      · simpa [branchSet, leftBranch] using M.connected C
      · simpa [branchSet, leftBranch] using M.connected D
    · have hk : k = 0 ∨ k = 1 ∨ k = 2 := by omega
      rcases hk with rfl | rfl | rfl
      · simpa [branchSet, rightBranch] using splitRight_connected S tail
      · simpa [branchSet, rightBranch] using M.connected A
      · simpa [branchSet, rightBranch] using M.connected B
  have disjoint_of_subsets
      {p q : Fin 5} (hpq : p ≠ q) {s t : Set V}
      (hs : s ⊆ M.branchSet p) (ht : t ⊆ M.branchSet q) :
      Disjoint s t := by
    rw [Set.disjoint_left]
    intro z hzs hzt
    have hd := M.disjoint hpq
    rw [Set.disjoint_left] at hd
    exact hd (hs hzs) (ht hzt)
  have hLsub : splitLeftSet S ⊆ M.branchSet i :=
    splitLeft_subset S
  have hRsub : splitRightSet S tail ⊆ M.branchSet i :=
    splitRight_subset S hadj tail hbridge
  have hLC := disjoint_of_subsets hiC hLsub (fun _ hx => hx)
  have hLD := disjoint_of_subsets hiD hLsub (fun _ hx => hx)
  have hLR := splitSets_disjoint S hadj tail hbridge
  have hLA := disjoint_of_subsets hiA hLsub (fun _ hx => hx)
  have hLB := disjoint_of_subsets hiB hLsub (fun _ hx => hx)
  have hCD := disjoint_of_subsets hCD
      (s := M.branchSet C) (t := M.branchSet D)
      (fun _ hx => hx) (fun _ hx => hx)
  have hCR := (disjoint_of_subsets hiC hRsub
      (fun _ hx => hx)).symm
  have hCA := disjoint_of_subsets hAC.symm
      (s := M.branchSet C) (t := M.branchSet A)
      (fun _ hx => hx) (fun _ hx => hx)
  have hCB := disjoint_of_subsets hBC.symm
      (s := M.branchSet C) (t := M.branchSet B)
      (fun _ hx => hx) (fun _ hx => hx)
  have hDR := (disjoint_of_subsets hiD hRsub
      (fun _ hx => hx)).symm
  have hDA := disjoint_of_subsets hAD.symm
      (s := M.branchSet D) (t := M.branchSet A)
      (fun _ hx => hx) (fun _ hx => hx)
  have hDB := disjoint_of_subsets hBD.symm
      (s := M.branchSet D) (t := M.branchSet B)
      (fun _ hx => hx) (fun _ hx => hx)
  have hRA := disjoint_of_subsets hiA hRsub (fun _ hx => hx)
  have hRB := disjoint_of_subsets hiB hRsub (fun _ hx => hx)
  have hAB := disjoint_of_subsets hAB
      (s := M.branchSet A) (t := M.branchSet B)
      (fun _ hx => hx) (fun _ hx => hx)
  have hLL :
      ∀ {x y : Fin 3}, x ≠ y →
        Disjoint (leftBranch x) (leftBranch y) := by
    intro x y hxy
    have hx : x = 0 ∨ x = 1 ∨ x = 2 := by omega
    have hy : y = 0 ∨ y = 1 ∨ y = 2 := by omega
    rcases hx with rfl | rfl | rfl <;>
      rcases hy with rfl | rfl | rfl
    · exact (hxy rfl).elim
    · exact hLC
    · exact hLD
    · exact hLC.symm
    · exact (hxy rfl).elim
    · exact hCD
    · exact hLD.symm
    · exact hCD.symm
    · exact (hxy rfl).elim
  have hLRall :
      ∀ x y : Fin 3, Disjoint (leftBranch x) (rightBranch y) := by
    intro x y
    have hx : x = 0 ∨ x = 1 ∨ x = 2 := by omega
    have hy : y = 0 ∨ y = 1 ∨ y = 2 := by omega
    rcases hx with rfl | rfl | rfl <;>
      rcases hy with rfl | rfl | rfl
    · exact hLR
    · exact hLA
    · exact hLB
    · exact hCR
    · exact hCA
    · exact hCB
    · exact hDR
    · exact hDA
    · exact hDB
  have hRR :
      ∀ {x y : Fin 3}, x ≠ y →
        Disjoint (rightBranch x) (rightBranch y) := by
    intro x y hxy
    have hx : x = 0 ∨ x = 1 ∨ x = 2 := by omega
    have hy : y = 0 ∨ y = 1 ∨ y = 2 := by omega
    rcases hx with rfl | rfl | rfl <;>
      rcases hy with rfl | rfl | rfl
    · exact (hxy rfl).elim
    · exact hRA
    · exact hRB
    · exact hRA.symm
    · exact (hxy rfl).elim
    · exact hAB
    · exact hRB.symm
    · exact hAB.symm
    · exact (hxy rfl).elim
  have hdisjoint :
      ∀ {x y}, x ≠ y →
        Disjoint (branchSet x) (branchSet y) := by
    intro x y hxy
    rcases x with x | x
    · rcases y with y | y
      · apply hLL
        intro h
        exact hxy (congrArg Sum.inl h)
      · exact hLRall x y
    · rcases y with y | y
      · exact (hLRall y x).symm
      · apply hRR
        intro h
        exact hxy (congrArg Sum.inr h)
  have hcross :
      ∀ x y,
        ∃ p ∈ branchSet (Sum.inl x),
          ∃ q ∈ branchSet (Sum.inr y), G.Adj p q := by
    intro x y
    have hx : x = 0 ∨ x = 1 ∨ x = 2 := by omega
    have hy : y = 0 ∨ y = 1 ∨ y = 2 := by omega
    rcases hx with rfl | rfl | rfl <;>
      rcases hy with rfl | rfl | rfl
    · refine ⟨S.fan.leftCenter, ?_, v, ?_, hadj⟩
      · exact .inl (SimpleGraph.Walk.start_mem_support _)
      · exact .inl (.inl (SimpleGraph.Walk.start_mem_support _))
    · refine ⟨port M i a, ?_, endpoint M A i hiA.symm, ?_, ?_⟩
      · exact .inl (SimpleGraph.Walk.end_mem_support _)
      · exact endpoint_mem M A i hiA.symm
      · simpa [A, port] using endpoint_adj M i A hiA
    · refine ⟨port M i b, ?_, endpoint M B i hiB.symm, ?_, ?_⟩
      · exact .inr (SimpleGraph.Walk.end_mem_support _)
      · exact endpoint_mem M B i hiB.symm
      · simpa [B, port] using endpoint_adj M i B hiB
    · refine ⟨endpoint M C i hiC.symm, ?_, port M i c, ?_, ?_⟩
      · exact endpoint_mem M C i hiC.symm
      · exact .inl (.inr (SimpleGraph.Walk.end_mem_support _))
      · simpa [C, port] using endpoint_adj M C i hiC.symm
    · rcases M.adjacent (k5_adj_of_ne hAC.symm) with
        ⟨p, hp, q, hq, hpq⟩
      exact ⟨p, hp, q, hq, hpq⟩
    · rcases M.adjacent (k5_adj_of_ne hBC.symm) with
        ⟨p, hp, q, hq, hpq⟩
      exact ⟨p, hp, q, hq, hpq⟩
    · refine ⟨endpoint M D i hiD.symm, ?_, port M i d, ?_, ?_⟩
      · exact endpoint_mem M D i hiD.symm
      · exact .inr (SimpleGraph.Walk.end_mem_support _)
      · simpa [D, port] using endpoint_adj M D i hiD.symm
    · rcases M.adjacent (k5_adj_of_ne hAD.symm) with
        ⟨p, hp, q, hq, hpq⟩
      exact ⟨p, hp, q, hq, hpq⟩
    · rcases M.adjacent (k5_adj_of_ne hBD.symm) with
        ⟨p, hp, q, hq, hpq⟩
      exact ⟨p, hp, q, hq, hpq⟩
  refine ⟨{
    branchSet := branchSet
    connected := hconnected
    disjoint := hdisjoint
    adjacent := ?_
  }⟩
  intro x y hxy
  rcases x with x | x
  · rcases y with y | y
    · simp [K33] at hxy
    · exact hcross x y
  · rcases y with y | y
    · rcases hcross y x with ⟨p, hp, q, hq, hpq⟩
      exact ⟨q, hq, p, hp, hpq.symm⟩
    · simp [K33] at hxy

/--
---
conclusion: Lax68.K5MinorTopologicalObstruction.k5Minor_topologicalObstruction
assumptions:
  - Lax68.ConnectedFourTerminalDichotomy.exists_fourFan_or_split
  - Lax68.K33MinorTopologicalObstruction.k33Minor_topologicalMinor
---
Choose one witness edge for every edge of K₅ and join the four witnesses in
each branch set.  If every connector is a four-fan, their centers and arms
form a subdivision of K₅.  Otherwise a split connector separates one branch
set into two pieces; together with the other four branch sets these pieces
form a K₃,₃ minor, whose subdivision is supplied by the K₃,₃ reduction.
-/
theorem k5Minor_topologicalObstruction
    {V' : Type*} {G' : SimpleGraph V'} :
  Lax68.GraphMinors.IsMinor Lax68.GraphMinors.K5 G' →
    (Lax68.GraphTopologicalMinors.IsTopologicalMinor
        Lax68.GraphMinors.K5 G' ∨
      Lax68.GraphTopologicalMinors.IsTopologicalMinor
        Lax68.GraphMinors.K33 G') := by
  rintro ⟨M⟩
  classical
  by_cases hAll : ∀ i, Nonempty (BranchFour M i)
  · left
    refine ⟨{
      branch := hubEmbedding M hAll
      route := fun {a b} h =>
        canonicalHubRoute M hAll a b (by
          simpa [K5] using h)
      route_isPath := ?_
      branch_avoids_interiors := ?_
      route_interiors_disjoint := ?_
    }⟩
    · intro a b h
      let hab : a ≠ b := by simpa [K5] using h
      simpa [canonicalHubRoute] using
        SimpleGraph.Walk.bypass_isPath
          (rawHubRoute M hAll a b hab)
    · intro a b h w
      let hab : a ≠ b := by simpa [K5] using h
      exact canonicalHubRoute_branch_avoids M hAll a b hab w
    · intro a b c d hab hcd hne
      let hab' : a ≠ b := by simpa [K5] using hab
      let hcd' : c ≠ d := by simpa [K5] using hcd
      exact canonicalHubRoute_interiors_disjoint
        M hAll a b c d hab' hcd' hne
  · rcases Classical.not_forall.mp hAll with ⟨i, hi⟩
    rcases branchDichotomy M i with hF | hS | hS | hS
    · exact (hi hF).elim
    · right
      apply Lax68.K33MinorTopologicalObstruction.k33Minor_topologicalMinor
      exact split_yields_k33_minor M i 0 1 2 3 hS.some
        (by decide) (by decide) (by decide)
        (by decide) (by decide) (by decide)
    · right
      apply Lax68.K33MinorTopologicalObstruction.k33Minor_topologicalMinor
      exact split_yields_k33_minor M i 0 2 1 3 hS.some
        (by decide) (by decide) (by decide)
        (by decide) (by decide) (by decide)
    · right
      apply Lax68.K33MinorTopologicalObstruction.k33Minor_topologicalMinor
      exact split_yields_k33_minor M i 1 2 0 3 hS.some
        (by decide) (by decide) (by decide)
        (by decide) (by decide) (by decide)

end Lax68Proofs.K5MinorTopologicalObstruction
