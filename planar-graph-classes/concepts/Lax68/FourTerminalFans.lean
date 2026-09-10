import Mathlib.Combinatorics.SimpleGraph.Paths

/-!
---
title: Four-terminal fans
type: definition
---
Four terminals in a tree can be joined in one of two elementary shapes:
either four arms meet at one center, or two pairs of arms meet at two centers
joined by a bridge.
-/

set_option autoImplicit false

namespace Lax68.FourTerminalFans

structure FourFan {V : Type*} (G : SimpleGraph V) (a b c d : V) where
  center : V
  toA : G.Walk center a
  toB : G.Walk center b
  toC : G.Walk center c
  toD : G.Walk center d
  toA_isPath : toA.IsPath
  toB_isPath : toB.IsPath
  toC_isPath : toC.IsPath
  toD_isPath : toD.IsPath
  toA_toB :
    ∀ {x}, x ∈ toA.support → x ∈ toB.support → x = center
  toA_toC :
    ∀ {x}, x ∈ toA.support → x ∈ toC.support → x = center
  toA_toD :
    ∀ {x}, x ∈ toA.support → x ∈ toD.support → x = center
  toB_toC :
    ∀ {x}, x ∈ toB.support → x ∈ toC.support → x = center
  toB_toD :
    ∀ {x}, x ∈ toB.support → x ∈ toD.support → x = center
  toC_toD :
    ∀ {x}, x ∈ toC.support → x ∈ toD.support → x = center

def HasFourFan {V : Type*} (G : SimpleGraph V) (a b c d : V) : Prop :=
  Nonempty (FourFan G a b c d)

structure SplitFourFan {V : Type*} (G : SimpleGraph V)
    (a b c d : V) where
  leftCenter : V
  rightCenter : V
  centers_ne : leftCenter ≠ rightCenter
  toA : G.Walk leftCenter a
  toB : G.Walk leftCenter b
  bridge : G.Walk leftCenter rightCenter
  toC : G.Walk rightCenter c
  toD : G.Walk rightCenter d
  toA_isPath : toA.IsPath
  toB_isPath : toB.IsPath
  bridge_isPath : bridge.IsPath
  toC_isPath : toC.IsPath
  toD_isPath : toD.IsPath
  left_arms_meet :
    ∀ {x}, x ∈ toA.support → x ∈ toB.support → x = leftCenter
  right_arms_meet :
    ∀ {x}, x ∈ toC.support → x ∈ toD.support → x = rightCenter
  opposite_arms_disjoint :
    ∀ {x},
      (x ∈ toA.support ∨ x ∈ toB.support) →
      (x ∈ toC.support ∨ x ∈ toD.support) →
      False
  bridge_meets_left :
    ∀ {x},
      x ∈ bridge.support →
      (x ∈ toA.support ∨ x ∈ toB.support) →
      x = leftCenter
  bridge_meets_right :
    ∀ {x},
      x ∈ bridge.support →
      (x ∈ toC.support ∨ x ∈ toD.support) →
      x = rightCenter

def HasSplitFourFan {V : Type*} (G : SimpleGraph V)
    (a b c d : V) : Prop :=
  Nonempty (SplitFourFan G a b c d)

end Lax68.FourTerminalFans
