import Mathlib.Combinatorics.SimpleGraph.Connectivity.Connected
import Lax68.FourTerminalFans

/-!
---
title: Four terminals in a connected graph
type: theorem
---
Four vertices of a connected graph admit either a four-fan or one of the
three possible paired split fans.
-/

set_option autoImplicit false

namespace Lax68.ConnectedFourTerminalDichotomy

open Lax68.FourTerminalFans

universe u

axiom exists_fourFan_or_split
    {V : Type u} {G : SimpleGraph V} :
  G.Connected →
    ∀ a b c d : V,
      HasFourFan G a b c d ∨
      HasSplitFourFan G a b c d ∨
      HasSplitFourFan G a c b d ∨
      HasSplitFourFan G b c a d

end Lax68.ConnectedFourTerminalDichotomy
