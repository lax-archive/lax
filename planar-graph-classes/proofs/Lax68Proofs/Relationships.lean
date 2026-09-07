import Lax68

set_option autoImplicit false

namespace Lax68Proofs

/--
---
conclusion: Lax68.OuterplanarPlanar.outerplanar_planar
---
An outerplane drawing is, after forgetting its boundary condition, a planar
drawing.
-/
theorem outerplanar_planar {V : Type*} {G : SimpleGraph V} :
    Lax68.Outerplanar.IsOuterplanar G →
    Lax68.Planar.IsPlanar G := by
  rintro ⟨drawing⟩
  exact ⟨drawing.toStraightLineDrawing⟩

/--
---
conclusion: Lax68.MaximalOuterplanarOuterplanar.maximalOuterplanar_outerplanar
---
Maximal outerplanarity includes outerplanarity.
-/
theorem maximalOuterplanar_outerplanar {V : Type*} {G : SimpleGraph V} :
    Lax68.MaximalOuterplanar.IsMaximalOuterplanar G →
    Lax68.Outerplanar.IsOuterplanar G :=
  fun h => h.1

/--
---
conclusion: Lax68.MaximalOuterplanarPlanar.maximalOuterplanar_planar
assumptions:
  - Lax68.MaximalOuterplanarOuterplanar.maximalOuterplanar_outerplanar
  - Lax68.OuterplanarPlanar.outerplanar_planar
---
Every maximal outerplanar graph is planar.
-/
theorem maximalOuterplanar_planar {V : Type*} {G : SimpleGraph V} :
    Lax68.MaximalOuterplanar.IsMaximalOuterplanar G →
    Lax68.Planar.IsPlanar G :=
  fun h =>
    Lax68.OuterplanarPlanar.outerplanar_planar
      (Lax68.MaximalOuterplanarOuterplanar.maximalOuterplanar_outerplanar h)

/--
---
conclusion: Lax68.GridPlanar.grid_planar
---
Every certified grid is planar.
-/
theorem grid_planar {V : Type*} {G : SimpleGraph V} :
    Lax68.GridsAndWalls.IsGrid G →
    Lax68.Planar.IsPlanar G :=
  fun h => h.2

/--
---
conclusion: Lax68.WallPlanar.wall_planar
---
Every certified wall is planar.
-/
theorem wall_planar {V : Type*} {G : SimpleGraph V} :
    Lax68.GridsAndWalls.IsWall G →
    Lax68.Planar.IsPlanar G :=
  fun h => h.2

/--
---
conclusion: Lax68.TriangleMaximalOuterplanar.triangle_maximalOuterplanar
---
A triangle carries its maximal-outerplanar certificate.
-/
theorem triangle_maximalOuterplanar
    {V : Type*} [Fintype V] {G : SimpleGraph V} :
    Lax68.Triangles.IsTriangle G →
    Lax68.MaximalOuterplanar.IsMaximalOuterplanar G :=
  fun h => h.2.2

/--
---
conclusion: Lax68.TriangleOuterplanar.triangle_outerplanar
assumptions:
  - Lax68.MaximalOuterplanarOuterplanar.maximalOuterplanar_outerplanar
  - Lax68.TriangleMaximalOuterplanar.triangle_maximalOuterplanar
---
Every triangle is outerplanar.
-/
theorem triangle_outerplanar
    {V : Type*} [Fintype V] {G : SimpleGraph V} :
    Lax68.Triangles.IsTriangle G →
    Lax68.Outerplanar.IsOuterplanar G :=
  fun h =>
    Lax68.MaximalOuterplanarOuterplanar.maximalOuterplanar_outerplanar
      (Lax68.TriangleMaximalOuterplanar.triangle_maximalOuterplanar h)

/--
---
conclusion: Lax68.TrianglePlanar.triangle_planar
assumptions:
  - Lax68.OuterplanarPlanar.outerplanar_planar
  - Lax68.TriangleOuterplanar.triangle_outerplanar
---
Every triangle is planar.
-/
theorem triangle_planar
    {V : Type*} [Fintype V] {G : SimpleGraph V} :
    Lax68.Triangles.IsTriangle G →
    Lax68.Planar.IsPlanar G :=
  fun h =>
    Lax68.OuterplanarPlanar.outerplanar_planar
      (Lax68.TriangleOuterplanar.triangle_outerplanar h)

/--
---
conclusion: Lax68.StarTree.star_tree
---
Every star is a tree.
-/
theorem star_tree {V : Type*} {G : SimpleGraph V} :
    Lax68.Stars.IsStar G →
    Lax68.Trees.IsTree G :=
  fun h => h.2

/--
---
conclusion: Lax68.StarOuterplanar.star_outerplanar
assumptions:
  - Lax68.StarTree.star_tree
  - Lax68.TreeOuterplanar.tree_outerplanar
---
Every star is outerplanar.
-/
theorem star_outerplanar {V : Type*} {G : SimpleGraph V} :
    Lax68.Stars.IsStar G →
    Lax68.Outerplanar.IsOuterplanar G :=
  fun h =>
    Lax68.TreeOuterplanar.tree_outerplanar
      (Lax68.StarTree.star_tree h)

/--
---
conclusion: Lax68.StarPlanar.star_planar
assumptions:
  - Lax68.OuterplanarPlanar.outerplanar_planar
  - Lax68.StarOuterplanar.star_outerplanar
---
Every star is planar.
-/
theorem star_planar {V : Type*} {G : SimpleGraph V} :
    Lax68.Stars.IsStar G →
    Lax68.Planar.IsPlanar G :=
  fun h =>
    Lax68.OuterplanarPlanar.outerplanar_planar
      (Lax68.StarOuterplanar.star_outerplanar h)

/--
---
conclusion: Lax68.LadderGrid.ladder_grid
---
Every ladder is a two-row grid.
-/
theorem ladder_grid {V : Type*} {G : SimpleGraph V} :
    Lax68.Ladders.IsLadder G →
    Lax68.GridsAndWalls.IsGrid G :=
  fun h => h.2.1

/--
---
conclusion: Lax68.LadderOuterplanar.ladder_outerplanar
---
Every ladder is outerplanar.
-/
theorem ladder_outerplanar {V : Type*} {G : SimpleGraph V} :
    Lax68.Ladders.IsLadder G →
    Lax68.Outerplanar.IsOuterplanar G :=
  fun h => h.2.2.1

/--
---
conclusion: Lax68.LadderSeriesParallel.ladder_seriesParallel
---
Every ladder is series-parallel.
-/
theorem ladder_seriesParallel {V : Type*} {G : SimpleGraph V} :
    Lax68.Ladders.IsLadder G →
    Lax68.SeriesParallel.IsSeriesParallel G :=
  fun h => h.2.2.2

/--
---
conclusion: Lax68.LadderPlanar.ladder_planar
assumptions:
  - Lax68.GridPlanar.grid_planar
  - Lax68.LadderGrid.ladder_grid
---
Every ladder is planar.
-/
theorem ladder_planar {V : Type*} {G : SimpleGraph V} :
    Lax68.Ladders.IsLadder G →
    Lax68.Planar.IsPlanar G :=
  fun h =>
    Lax68.GridPlanar.grid_planar
      (Lax68.LadderGrid.ladder_grid h)

/--
---
conclusion: Lax68.HalinPlanar.halin_planar
---
Every Halin graph is planar.
-/
theorem halin_planar
    {V : Type*} [Fintype V] {G : SimpleGraph V} :
    Lax68.HalinGraphs.IsHalin G →
    Lax68.Planar.IsPlanar G :=
  fun h => h.2

/--
---
conclusion: Lax68.WheelHalin.wheel_halin
---
Every wheel is a Halin graph.
-/
theorem wheel_halin
    {V : Type*} [Fintype V] {G : SimpleGraph V} :
    Lax68.Wheels.IsWheel G →
    Lax68.HalinGraphs.IsHalin G :=
  fun h => h.2

/--
---
conclusion: Lax68.WheelPlanar.wheel_planar
assumptions:
  - Lax68.HalinPlanar.halin_planar
  - Lax68.WheelHalin.wheel_halin
---
Every wheel is planar.
-/
theorem wheel_planar
    {V : Type*} [Fintype V] {G : SimpleGraph V} :
    Lax68.Wheels.IsWheel G →
    Lax68.Planar.IsPlanar G :=
  fun h =>
    Lax68.HalinPlanar.halin_planar
      (Lax68.WheelHalin.wheel_halin h)

/--
---
conclusion: Lax68.SeriesParallelPlanar.seriesParallel_planar
---
Every series-parallel graph is planar.
-/
theorem seriesParallel_planar {V : Type*} {G : SimpleGraph V} :
    Lax68.SeriesParallel.IsSeriesParallel G →
    Lax68.Planar.IsPlanar G :=
  fun h => h.2

/--
---
conclusion: Lax68.TreeOuterplanar.tree_outerplanar
---
Every tree is outerplanar.
-/
theorem tree_outerplanar {V : Type*} {G : SimpleGraph V} :
    Lax68.Trees.IsTree G →
    Lax68.Outerplanar.IsOuterplanar G :=
  fun h => h.2

/--
---
conclusion: Lax68.TreePlanar.tree_planar
assumptions:
  - Lax68.OuterplanarPlanar.outerplanar_planar
  - Lax68.TreeOuterplanar.tree_outerplanar
---
Every tree is planar.
-/
theorem tree_planar {V : Type*} {G : SimpleGraph V} :
    Lax68.Trees.IsTree G →
    Lax68.Planar.IsPlanar G :=
  fun h =>
    Lax68.OuterplanarPlanar.outerplanar_planar
      (Lax68.TreeOuterplanar.tree_outerplanar h)

/--
---
conclusion: Lax68.PathTree.path_tree
---
Every path is a tree.
-/
theorem path_tree {V : Type*} {G : SimpleGraph V} :
    Lax68.Paths.IsPath G →
    Lax68.Trees.IsTree G :=
  fun h => h.2

/--
---
conclusion: Lax68.PathOuterplanar.path_outerplanar
assumptions:
  - Lax68.PathTree.path_tree
  - Lax68.TreeOuterplanar.tree_outerplanar
---
Every path is outerplanar.
-/
theorem path_outerplanar {V : Type*} {G : SimpleGraph V} :
    Lax68.Paths.IsPath G →
    Lax68.Outerplanar.IsOuterplanar G :=
  fun h =>
    Lax68.TreeOuterplanar.tree_outerplanar
      (Lax68.PathTree.path_tree h)

/--
---
conclusion: Lax68.PathPlanar.path_planar
assumptions:
  - Lax68.OuterplanarPlanar.outerplanar_planar
  - Lax68.PathOuterplanar.path_outerplanar
---
Every path is planar.
-/
theorem path_planar {V : Type*} {G : SimpleGraph V} :
    Lax68.Paths.IsPath G →
    Lax68.Planar.IsPlanar G :=
  fun h =>
    Lax68.OuterplanarPlanar.outerplanar_planar
      (Lax68.PathOuterplanar.path_outerplanar h)

/--
---
conclusion: Lax68.TriangulationPlanar.triangulation_planar
---
Every triangulation is planar.
-/
theorem triangulation_planar {V : Type*} {G : SimpleGraph V} :
    Lax68.Triangulations.IsTriangulation G →
    Lax68.Planar.IsPlanar G :=
  fun h => h.1

end Lax68Proofs
