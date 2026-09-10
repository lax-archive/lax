import Mathlib.Combinatorics.SimpleGraph.Paths

/-!
---
title: Three-fans
type: definition
---
A three-fan joins one center to three terminals by paths whose pairwise
intersections contain only the center.
-/

set_option autoImplicit false

namespace Lax68.ThreeFans

structure ThreeFan {V : Type*} (G : SimpleGraph V) (a b c : V) where
  center : V
  toA : G.Walk center a
  toB : G.Walk center b
  toC : G.Walk center c
  toA_isPath : toA.IsPath
  toB_isPath : toB.IsPath
  toC_isPath : toC.IsPath
  toA_toB :
    ∀ {x}, x ∈ toA.support → x ∈ toB.support → x = center
  toA_toC :
    ∀ {x}, x ∈ toA.support → x ∈ toC.support → x = center
  toB_toC :
    ∀ {x}, x ∈ toB.support → x ∈ toC.support → x = center

def HasThreeFan {V : Type*} (G : SimpleGraph V) (a b c : V) : Prop :=
  Nonempty (ThreeFan G a b c)

end Lax68.ThreeFans
