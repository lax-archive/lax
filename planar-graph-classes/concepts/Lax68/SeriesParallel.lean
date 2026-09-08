import Mathlib.Combinatorics.SimpleGraph.Basic

/-!
---
title: Series-parallel graphs
type: definition
---
A finite two-terminal series-parallel graph is built from a single terminal
edge by series and parallel composition. The side conditions say that the
composed graphs meet only at the intended terminals, and the final support
condition excludes unused isolated vertices.
-/

set_option autoImplicit false

namespace Lax68.SeriesParallel

def edgeGraph {V : Type*} (s t : V) : SimpleGraph V :=
  SimpleGraph.fromRel fun u v =>
    (u = s ∧ v = t) ∨
    (u = t ∧ v = s)

inductive TwoTerminal {V : Type*} : SimpleGraph V → V → V → Prop
  | edge (s t : V) (hne : s ≠ t) :
      TwoTerminal (edgeGraph s t) s t
  | series
      {G H : SimpleGraph V}
      {s m t : V}
      (left : TwoTerminal G s m)
      (right : TwoTerminal H m t)
      (meet :
        ∀ v,
          v ∈ G.support →
          v ∈ H.support →
          v = m) :
      TwoTerminal (G ⊔ H) s t
  | parallel
      {G H : SimpleGraph V}
      {s t : V}
      (left : TwoTerminal G s t)
      (right : TwoTerminal H s t)
      (meet :
        ∀ v,
          v ∈ G.support →
          v ∈ H.support →
          v = s ∨ v = t) :
      TwoTerminal (G ⊔ H) s t

def IsSeriesParallel {V : Type*} (G : SimpleGraph V) : Prop :=
  ∃ s t,
    TwoTerminal G s t ∧
    G.support = Set.univ

end Lax68.SeriesParallel
