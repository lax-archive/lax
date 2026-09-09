import Mathlib.Combinatorics.SimpleGraph.Paths
import Lax68.GraphMinors

/-!
---
title: Topological graph minors
type: definition
---
A graph *H* is a topological minor of *G* when the vertices of *H* are
represented by distinct branch vertices of *G* and its edges by paths whose
interiors contain no branch vertex and are pairwise disjoint. Equivalently,
*G* contains a subdivision of *H* as a subgraph.
-/

set_option autoImplicit false

namespace Lax68.GraphTopologicalMinors

open GraphMinors

def walkInterior {V : Type*} {G : SimpleGraph V} {a b : V}
    (P : G.Walk a b) : Set V :=
  {x | x ∈ P.support ∧ x ≠ a ∧ x ≠ b}

structure TopologicalMinorModel {W V : Type*}
    (H : SimpleGraph W) (G : SimpleGraph V) where
  branch : W ↪ V
  route :
    ∀ {a b : W}, H.Adj a b →
      G.Walk (branch a) (branch b)
  route_isPath :
    ∀ {a b : W} (h : H.Adj a b),
      (route h).IsPath
  branch_avoids_interiors :
    ∀ {a b : W} (h : H.Adj a b) (w : W),
      branch w ∉ walkInterior (route h)
  route_interiors_disjoint :
    ∀ {a b c d : W}
        (hab : H.Adj a b) (hcd : H.Adj c d),
      ¬ ((a = c ∧ b = d) ∨ (a = d ∧ b = c)) →
        Disjoint
          (walkInterior (route hab))
          (walkInterior (route hcd))

def IsTopologicalMinor {W V : Type*}
    (H : SimpleGraph W) (G : SimpleGraph V) : Prop :=
  Nonempty (TopologicalMinorModel H G)

def IsKuratowskiFree {V : Type*} (G : SimpleGraph V) : Prop :=
  ¬IsTopologicalMinor K5 G ∧
  ¬IsTopologicalMinor K33 G

end Lax68.GraphTopologicalMinors
