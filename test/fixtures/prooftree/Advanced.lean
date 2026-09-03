import Lean
import Concepts

theorem advancedProofA : True := True.intro

structure Box (α : Sort u) where
  value : α

theorem advancedProofB : True := (Box.mk (α := True) A).value

inductive TruthChain (α : Sort u) where
  | stop (value : α)
  | next (rest : TruthChain α)

def TruthChain.value : TruthChain α → α
  | .stop value => value
  | .next rest => rest.value

theorem advancedProofC : True :=
  TruthChain.value (.next (.stop (α := True) A))

def advancedChooseLeft (left _right : True) : True := left

open Lean Elab Term in
elab "largeSharedProof" : term => do
  let leaf ← elabTerm (mkIdent `A) none
  let chooseLeft ← elabTerm (mkIdent `advancedChooseLeft) none
  let mut value := leaf
  for _ in [:24] do
    value := mkAppN chooseLeft #[value, value]
  return value

theorem advancedProofD : True := largeSharedProof

theorem advancedProofE : True := Open

theorem advancedProofF : True := E

theorem advancedProofG : True := (Box.mk (α := True) A).value

inductive TruthNest where
  | leaf (value : True)
  | node (children : List TruthNest)

def TruthNest.value : TruthNest → True
  | .leaf value => value
  | .node [] => True.intro
  | .node (child :: _) => child.value

theorem advancedProofH : True := TruthNest.value (.node [.leaf A])
