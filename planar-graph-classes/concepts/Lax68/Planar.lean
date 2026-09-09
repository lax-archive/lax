import Lax68.StraightLineDrawings
import Mathlib.Combinatorics.SimpleGraph.Connectivity.Connected

/-!
---
title: Planar graphs
type: definition
---
A graph is planar when it can be drawn in the plane without crossings.
Equivalently, a finite graph is planar when it contains neither the complete
graph *K₅* nor the complete bipartite graph *K₃,₃* as a minor. A minor is
represented by pairwise disjoint connected branch sets, with adjacent branch
sets for every edge of the minor.

The drawing certificate itself belongs to the separate
`Straight-line graph drawings` concept.
-/

set_option autoImplicit false

namespace Lax68.Planar

def IsPlanar {V : Type*} (G : SimpleGraph V) : Prop :=
  StraightLineDrawings.HasStraightLineDrawing G

/-- A branch-set model of `H` as a minor of `G`. -/
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

def IsPlanarByExcludedMinors {V : Type*} (G : SimpleGraph V) : Prop :=
  ¬IsMinor K5 G ∧
  ¬IsMinor K33 G

end Lax68.Planar
