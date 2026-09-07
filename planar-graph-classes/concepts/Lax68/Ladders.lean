import Lax68.GridsAndWalls
import Lax68.Outerplanar
import Lax68.SeriesParallel

/-!
---
title: Ladders
type: definition
---
A ladder is the two-row grid: two paths joined by corresponding rungs.  Its
grid, outerplanar, and series-parallel certificates are recorded explicitly.
-/

set_option autoImplicit false

namespace Lax68.Ladders

def HasLadderShape {V : Type*} (G : SimpleGraph V) : Prop :=
  ∃ n : ℕ,
    Nonempty
      (G ≃g (SimpleGraph.pathGraph n □ SimpleGraph.pathGraph 2))

def IsLadder {V : Type*} (G : SimpleGraph V) : Prop :=
  HasLadderShape G ∧
    GridsAndWalls.IsGrid G ∧
    Outerplanar.IsOuterplanar G ∧
    SeriesParallel.IsSeriesParallel G

end Lax68.Ladders
