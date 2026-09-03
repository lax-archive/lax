import Lax0.Relationships

set_option autoImplicit false

namespace Lax0Proofs

/--
---
conclusion: Lax0.Relationships.outerplanar_planar
---
An outerplane drawing is, after forgetting its boundary condition, a planar
drawing.
-/
theorem outerplanar_planar {V : Type*} {G : SimpleGraph V} :
    Lax0.Outerplanar.IsOuterplanar G →
    Lax0.Planar.IsPlanar G := by
  rintro ⟨drawing⟩
  exact ⟨drawing.toStraightLineDrawing⟩

/--
---
conclusion: Lax0.Relationships.maximalOuterplanar_outerplanar
---
Maximal outerplanarity includes outerplanarity.
-/
theorem maximalOuterplanar_outerplanar {V : Type*} {G : SimpleGraph V} :
    Lax0.MaximalOuterplanar.IsMaximalOuterplanar G →
    Lax0.Outerplanar.IsOuterplanar G :=
  fun h => h.1

/--
---
conclusion: Lax0.Relationships.maximalOuterplanar_planar
---
Every maximal outerplanar graph is planar.
-/
theorem maximalOuterplanar_planar {V : Type*} {G : SimpleGraph V} :
    Lax0.MaximalOuterplanar.IsMaximalOuterplanar G →
    Lax0.Planar.IsPlanar G :=
  fun h => outerplanar_planar h.1

/--
---
conclusion: Lax0.Relationships.grid_planar
---
Every certified grid is planar.
-/
theorem grid_planar {V : Type*} {G : SimpleGraph V} :
    Lax0.GridsAndWalls.IsGrid G →
    Lax0.Planar.IsPlanar G :=
  fun h => h.2

/--
---
conclusion: Lax0.Relationships.wall_planar
---
Every certified wall is planar.
-/
theorem wall_planar {V : Type*} {G : SimpleGraph V} :
    Lax0.GridsAndWalls.IsWall G →
    Lax0.Planar.IsPlanar G :=
  fun h => h.2

/--
---
conclusion: Lax0.Relationships.triangle_maximalOuterplanar
---
A triangle carries its maximal-outerplanar certificate.
-/
theorem triangle_maximalOuterplanar
    {V : Type*} [Fintype V] {G : SimpleGraph V} :
    Lax0.Triangles.IsTriangle G →
    Lax0.MaximalOuterplanar.IsMaximalOuterplanar G :=
  fun h => h.2.2

/--
---
conclusion: Lax0.Relationships.triangle_outerplanar
---
Every triangle is outerplanar.
-/
theorem triangle_outerplanar
    {V : Type*} [Fintype V] {G : SimpleGraph V} :
    Lax0.Triangles.IsTriangle G →
    Lax0.Outerplanar.IsOuterplanar G :=
  fun h => maximalOuterplanar_outerplanar h.2.2

/--
---
conclusion: Lax0.Relationships.triangle_planar
---
Every triangle is planar.
-/
theorem triangle_planar
    {V : Type*} [Fintype V] {G : SimpleGraph V} :
    Lax0.Triangles.IsTriangle G →
    Lax0.Planar.IsPlanar G :=
  fun h => maximalOuterplanar_planar h.2.2

/--
---
conclusion: Lax0.Relationships.star_tree
---
Every star is a tree.
-/
theorem star_tree {V : Type*} {G : SimpleGraph V} :
    Lax0.Stars.IsStar G →
    Lax0.Trees.IsTree G :=
  fun h => h.2

/--
---
conclusion: Lax0.Relationships.star_outerplanar
---
Every star is outerplanar.
-/
theorem star_outerplanar {V : Type*} {G : SimpleGraph V} :
    Lax0.Stars.IsStar G →
    Lax0.Outerplanar.IsOuterplanar G :=
  fun h => h.2.2

/--
---
conclusion: Lax0.Relationships.star_planar
---
Every star is planar.
-/
theorem star_planar {V : Type*} {G : SimpleGraph V} :
    Lax0.Stars.IsStar G →
    Lax0.Planar.IsPlanar G :=
  fun h => outerplanar_planar h.2.2

/--
---
conclusion: Lax0.Relationships.ladder_grid
---
Every ladder is a two-row grid.
-/
theorem ladder_grid {V : Type*} {G : SimpleGraph V} :
    Lax0.Ladders.IsLadder G →
    Lax0.GridsAndWalls.IsGrid G :=
  fun h => h.2.1

/--
---
conclusion: Lax0.Relationships.ladder_outerplanar
---
Every ladder is outerplanar.
-/
theorem ladder_outerplanar {V : Type*} {G : SimpleGraph V} :
    Lax0.Ladders.IsLadder G →
    Lax0.Outerplanar.IsOuterplanar G :=
  fun h => h.2.2.1

/--
---
conclusion: Lax0.Relationships.ladder_seriesParallel
---
Every ladder is series-parallel.
-/
theorem ladder_seriesParallel {V : Type*} {G : SimpleGraph V} :
    Lax0.Ladders.IsLadder G →
    Lax0.SeriesParallel.IsSeriesParallel G :=
  fun h => h.2.2.2

/--
---
conclusion: Lax0.Relationships.ladder_planar
---
Every ladder is planar.
-/
theorem ladder_planar {V : Type*} {G : SimpleGraph V} :
    Lax0.Ladders.IsLadder G →
    Lax0.Planar.IsPlanar G :=
  fun h => h.2.1.2

/--
---
conclusion: Lax0.Relationships.halin_planar
---
Every Halin graph is planar.
-/
theorem halin_planar
    {V : Type*} [Fintype V] {G : SimpleGraph V} :
    Lax0.HalinGraphs.IsHalin G →
    Lax0.Planar.IsPlanar G :=
  fun h => h.2

/--
---
conclusion: Lax0.Relationships.wheel_halin
---
Every wheel is a Halin graph.
-/
theorem wheel_halin
    {V : Type*} [Fintype V] {G : SimpleGraph V} :
    Lax0.Wheels.IsWheel G →
    Lax0.HalinGraphs.IsHalin G :=
  fun h => h.2

/--
---
conclusion: Lax0.Relationships.wheel_planar
---
Every wheel is planar.
-/
theorem wheel_planar
    {V : Type*} [Fintype V] {G : SimpleGraph V} :
    Lax0.Wheels.IsWheel G →
    Lax0.Planar.IsPlanar G :=
  fun h => h.2.2

/--
---
conclusion: Lax0.Relationships.seriesParallel_planar
---
Every series-parallel graph is planar.
-/
theorem seriesParallel_planar {V : Type*} {G : SimpleGraph V} :
    Lax0.SeriesParallel.IsSeriesParallel G →
    Lax0.Planar.IsPlanar G :=
  fun h => h.2

/--
---
conclusion: Lax0.Relationships.tree_outerplanar
---
Every tree is outerplanar.
-/
theorem tree_outerplanar {V : Type*} {G : SimpleGraph V} :
    Lax0.Trees.IsTree G →
    Lax0.Outerplanar.IsOuterplanar G :=
  fun h => h.2

/--
---
conclusion: Lax0.Relationships.tree_planar
---
Every tree is planar.
-/
theorem tree_planar {V : Type*} {G : SimpleGraph V} :
    Lax0.Trees.IsTree G →
    Lax0.Planar.IsPlanar G :=
  fun h => outerplanar_planar h.2

/--
---
conclusion: Lax0.Relationships.path_tree
---
Every path is a tree.
-/
theorem path_tree {V : Type*} {G : SimpleGraph V} :
    Lax0.Paths.IsPath G →
    Lax0.Trees.IsTree G :=
  fun h => h.2

/--
---
conclusion: Lax0.Relationships.path_outerplanar
---
Every path is outerplanar.
-/
theorem path_outerplanar {V : Type*} {G : SimpleGraph V} :
    Lax0.Paths.IsPath G →
    Lax0.Outerplanar.IsOuterplanar G :=
  fun h => h.2.2

/--
---
conclusion: Lax0.Relationships.path_planar
---
Every path is planar.
-/
theorem path_planar {V : Type*} {G : SimpleGraph V} :
    Lax0.Paths.IsPath G →
    Lax0.Planar.IsPlanar G :=
  fun h => outerplanar_planar h.2.2

/--
---
conclusion: Lax0.Relationships.triangulation_planar
---
Every triangulation is planar.
-/
theorem triangulation_planar {V : Type*} {G : SimpleGraph V} :
    Lax0.Triangulations.IsTriangulation G →
    Lax0.Planar.IsPlanar G :=
  fun h => h.1

end Lax0Proofs
