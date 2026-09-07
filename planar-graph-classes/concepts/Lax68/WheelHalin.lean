import Lax68.Wheels
import Lax68.HalinGraphs

/-!
---
title: Wheels are Halin graphs
type: theorem
---
Every wheel graph is a Halin graph.
-/

set_option autoImplicit false

namespace Lax68.WheelHalin

axiom wheel_halin
    {V : Type*} [Fintype V] {G : SimpleGraph V} :
  Lax68.Wheels.IsWheel G →
  Lax68.HalinGraphs.IsHalin G

end Lax68.WheelHalin
