import Mathlib.Combinatorics.SimpleGraph.UniversalVerts

/-!
---
title: Wheels
type: definition
---
A finite wheel consists of a cycle of at least three rim vertices together
with one hub adjacent to every rim vertex, and has no other edges.
-/

set_option autoImplicit false

namespace Lax68.Wheels

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

def HasWheelShape {V : Type*} (G : SimpleGraph V) : Prop :=
  ∃ hub : V,
    hub ∈ G.universalVerts ∧
    ∃ rim : SimpleGraph V,
      IsCycleOn rim {v | v ≠ hub} ∧
      ∀ ⦃u v⦄,
        u ≠ hub →
        v ≠ hub →
        (G.Adj u v ↔ rim.Adj u v)

def IsWheel {V : Type*} (G : SimpleGraph V) : Prop :=
  HasWheelShape G

end Lax68.Wheels
