import Mathlib.Combinatorics.SimpleGraph.Connectivity.Connected

/-!
---
title: Graph minors
type: definition
---
A graph *H* is a minor of a graph *G* when the vertices of *H* can be
represented by pairwise disjoint connected branch sets in *G*, with an edge
joining the corresponding branch sets for every edge of *H*.
-/

set_option autoImplicit false

namespace Lax68.GraphMinors

structure MinorModel {W V : Type*}
    (H : SimpleGraph W) (G : SimpleGraph V) where
  branchSet : W → Set V
  connected : ∀ w, (G.induce (branchSet w)).Connected
  disjoint :
    ∀ {u v}, u ≠ v →
      Disjoint (branchSet u) (branchSet v)
  adjacent :
    ∀ {u v}, H.Adj u v →
      ∃ x ∈ branchSet u, ∃ y ∈ branchSet v, G.Adj x y

def IsMinor {W V : Type*}
    (H : SimpleGraph W) (G : SimpleGraph V) : Prop :=
  Nonempty (MinorModel H G)

abbrev K5 : SimpleGraph (Fin 5) :=
  SimpleGraph.completeGraph (Fin 5)

abbrev K33 : SimpleGraph (Fin 3 ⊕ Fin 3) :=
  completeBipartiteGraph (Fin 3) (Fin 3)

end Lax68.GraphMinors
