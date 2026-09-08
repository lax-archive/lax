import Mathlib.Combinatorics.SimpleGraph.Acyclic
import Mathlib.Combinatorics.SimpleGraph.Finite
import Lax68.Planar

/-!
---
title: Halin graphs
type: definition
---
A finite Halin graph is obtained from a finite plane tree with no vertex of
degree two by joining its leaves in their cyclic order. The construction
contains the chosen crossing-free embedding because the word "plane" is part
of the defining data, rather than attaching a separate planarity proposition.
-/

set_option autoImplicit false

namespace Lax68.HalinGraphs

def IsLeaf {V : Type*} [Fintype V] (T : SimpleGraph V) (v : V) : Prop :=
  (T.neighborSet v).ncard = 1

def CycleAdjacent {n : ℕ} (i j : Fin n) : Prop :=
  i.val + 1 = j.val ∨
  j.val + 1 = i.val ∨
  (i.val = 0 ∧ j.val + 1 = n) ∨
  (j.val = 0 ∧ i.val + 1 = n)

def IsCycleOn {V : Type*}
    (R : SimpleGraph V) (S : Set V) : Prop :=
  (∀ ⦃u v⦄, R.Adj u v → u ∈ S ∧ v ∈ S) ∧
    ∃ n : ℕ,
      3 ≤ n ∧
      ∃ e : Fin n ≃ {v : V // v ∈ S},
        ∀ i j,
          R.Adj (e i).1 (e j).1 ↔ CycleAdjacent i j

structure Construction {V : Type*} [Fintype V] (G : SimpleGraph V) where
  tree : SimpleGraph V
  rim : SimpleGraph V
  tree_isTree : tree.IsTree
  noDegreeTwo : ∀ v, (tree.neighborSet v).ncard ≠ 2
  rimCycle : IsCycleOn rim {v | IsLeaf tree v}
  graph_eq : G = tree ⊔ rim
  drawing : Planar.StraightLineDrawing G

def IsHalin {V : Type*} [Fintype V] (G : SimpleGraph V) : Prop :=
  Nonempty (Construction G)

end Lax68.HalinGraphs
