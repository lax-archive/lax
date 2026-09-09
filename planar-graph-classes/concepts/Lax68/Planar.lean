import Lax68.StraightLineDrawings
import Lax68.GraphMinors

/-!
---
title: Planar graphs
type: definition
---
A graph is planar when it can be drawn in the plane without crossings.
For finite graphs, this is equivalent to containing neither the complete graph
*K₅* nor the complete bipartite graph *K₃,₃* as a minor. The drawing certificate
and graph-minor relation are supplied by separate concepts.
-/

set_option autoImplicit false

namespace Lax68.Planar

open GraphMinors

def IsPlanar {V : Type*} (G : SimpleGraph V) : Prop :=
  StraightLineDrawings.HasStraightLineDrawing G

def IsPlanarByExcludedMinors {V : Type*} (G : SimpleGraph V) : Prop :=
  ¬IsMinor K5 G ∧
  ¬IsMinor K33 G

end Lax68.Planar
