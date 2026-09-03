import Lax0.Planar

/-!
---
title: Series-parallel graphs
type: definition
---
A two-terminal series-parallel graph is built from a single terminal edge by
series and parallel composition.  The side conditions say that the composed
graphs meet only at the intended terminals.  The class predicate records a
planar drawing certificate.
-/

set_option autoImplicit false

namespace Lax0.SeriesParallel

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
  (∃ s t : V, TwoTerminal G s t) ∧
    Planar.IsPlanar G

end Lax0.SeriesParallel
