import Mathlib.Analysis.Convex.Segment
import Mathlib.Combinatorics.SimpleGraph.Basic
import Mathlib.Data.Real.Basic

/-!
---
title: Planar graphs
type: definition
---
A finite simple graph is planar when it admits a drawing in the plane with
distinct vertices and with edges meeting only at a common endpoint. We use a
straight-line drawing as the certificate; for finite simple graphs this is
equivalent to the usual topological definition by Fáry's theorem.
-/

set_option autoImplicit false

namespace Lax68.Planar

abbrev Point := ℝ × ℝ

structure StraightLineDrawing {V : Type*} (G : SimpleGraph V) where
  point : V → Point
  injective : Function.Injective point
  noVertexOnEdge :
    ∀ {a b c : V},
      G.Adj a b →
      c ≠ a →
      c ≠ b →
      point c ∉ segment ℝ (point a) (point b)
  disjointEdges :
    ∀ {a b c d : V},
      G.Adj a b →
      G.Adj c d →
      Disjoint ({a, b} : Set V) ({c, d} : Set V) →
      Disjoint
        (segment ℝ (point a) (point b))
        (segment ℝ (point c) (point d))

def IsPlanar {V : Type*} [Fintype V] (G : SimpleGraph V) : Prop :=
  Nonempty (StraightLineDrawing G)

end Lax68.Planar
