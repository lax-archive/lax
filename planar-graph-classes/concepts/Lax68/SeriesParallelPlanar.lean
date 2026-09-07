import Lax68.SeriesParallel
import Lax68.Planar

/-!
---
title: Series-parallel graphs are planar
type: theorem
---
Every series-parallel graph is planar.
-/

set_option autoImplicit false

namespace Lax68.SeriesParallelPlanar

axiom seriesParallel_planar {V : Type*} {G : SimpleGraph V} :
  Lax68.SeriesParallel.IsSeriesParallel G →
  Lax68.Planar.IsPlanar G

end Lax68.SeriesParallelPlanar
