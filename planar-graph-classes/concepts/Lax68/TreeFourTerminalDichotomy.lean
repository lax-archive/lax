import Mathlib.Combinatorics.SimpleGraph.Acyclic
import Lax68.FourTerminalFans

/-!
---
title: Four terminals in a tree
type: theorem
---
Four vertices of a tree are joined either by a four-fan or by two three-way
centers joined by a path.  The three split alternatives record the three
possible pairings of the terminals.
-/

set_option autoImplicit false

namespace Lax68.TreeFourTerminalDichotomy

open Lax68.FourTerminalFans

universe u

axiom exists_fourFan_or_split
    {V : Type u} {G : SimpleGraph V} :
  G.IsTree →
    ∀ a b c d : V,
      HasFourFan G a b c d ∨
      HasSplitFourFan G a b c d ∨
      HasSplitFourFan G a c b d ∨
      HasSplitFourFan G b c a d

end Lax68.TreeFourTerminalDichotomy
