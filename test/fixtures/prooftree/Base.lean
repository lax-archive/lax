import Concepts

theorem proofA : True := True.intro

structure Wrapper where
  value : True

theorem helperUsingA : True := (Wrapper.mk A).value

theorem proofB : True := helperUsingA
