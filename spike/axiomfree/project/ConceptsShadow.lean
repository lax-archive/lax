module


public import Mathlib.Data.Nat.Prime.Defs

/-! Negative test (c): a module that redefines the concept constants under the
same names as `True`, without importing `Concepts`. -/

namespace Concepts

@[expose] public def ExistsPrimeDivisor : Prop := True

@[expose] public def InfinitelyManyPrimes : Prop := True

end Concepts
