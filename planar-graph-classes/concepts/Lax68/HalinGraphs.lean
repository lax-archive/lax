import Mathlib.Combinatorics.SimpleGraph.Acyclic
import Mathlib.Combinatorics.SimpleGraph.Finite
import Lax68.Planar

/-!
---
title: Halin graphs
type: definition
---
A Halin graph is obtained from a finite plane tree with no vertex of degree two
by joining its leaves in their cyclic order.  Here the tree and leaf cycle give
the combinatorial shape, while a planar drawing certificate records the chosen
plane embedding.
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

def HasHalinShape {V : Type*} [Fintype V] (G : SimpleGraph V) : Prop :=
  ∃ T R : SimpleGraph V,
    T.IsTree ∧
    (∀ v, (T.neighborSet v).ncard ≠ 2) ∧
    IsCycleOn R {v | IsLeaf T v} ∧
    G = T ⊔ R

def IsHalin {V : Type*} [Fintype V] (G : SimpleGraph V) : Prop :=
  HasHalinShape G ∧ Planar.IsPlanar G

end Lax68.HalinGraphs
