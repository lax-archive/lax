import Lax68.Planar
import Lax68.Outerplanar
import Lax68.MaximalOuterplanar
import Lax68.GridsAndWalls
import Lax68.Triangles
import Lax68.Stars
import Lax68.Ladders
import Lax68.HalinGraphs
import Lax68.Wheels
import Lax68.SeriesParallel
import Lax68.Trees
import Lax68.Paths
import Lax68.Triangulations

/-!
---
title: Basic relationships between planar graph classes
type: theorem
---
The familiar elementary inclusions between the graph classes in this
submission.  In particular every listed class is planar; trees, stars, paths,
ladders, triangles, and wheels have the more specific relationships stated
below.
-/

set_option autoImplicit false

namespace Lax68.Relationships

axiom outerplanar_planar {V : Type*} {G : SimpleGraph V} :
  Outerplanar.IsOuterplanar G →
  Planar.IsPlanar G

axiom maximalOuterplanar_outerplanar {V : Type*} {G : SimpleGraph V} :
  MaximalOuterplanar.IsMaximalOuterplanar G →
  Outerplanar.IsOuterplanar G

axiom maximalOuterplanar_planar {V : Type*} {G : SimpleGraph V} :
  MaximalOuterplanar.IsMaximalOuterplanar G →
  Planar.IsPlanar G

axiom grid_planar {V : Type*} {G : SimpleGraph V} :
  GridsAndWalls.IsGrid G →
  Planar.IsPlanar G

axiom wall_planar {V : Type*} {G : SimpleGraph V} :
  GridsAndWalls.IsWall G →
  Planar.IsPlanar G

axiom triangle_maximalOuterplanar
    {V : Type*} [Fintype V] {G : SimpleGraph V} :
  Triangles.IsTriangle G →
  MaximalOuterplanar.IsMaximalOuterplanar G

axiom triangle_outerplanar
    {V : Type*} [Fintype V] {G : SimpleGraph V} :
  Triangles.IsTriangle G →
  Outerplanar.IsOuterplanar G

axiom triangle_planar
    {V : Type*} [Fintype V] {G : SimpleGraph V} :
  Triangles.IsTriangle G →
  Planar.IsPlanar G

axiom star_tree {V : Type*} {G : SimpleGraph V} :
  Stars.IsStar G →
  Trees.IsTree G

axiom star_outerplanar {V : Type*} {G : SimpleGraph V} :
  Stars.IsStar G →
  Outerplanar.IsOuterplanar G

axiom star_planar {V : Type*} {G : SimpleGraph V} :
  Stars.IsStar G →
  Planar.IsPlanar G

axiom ladder_grid {V : Type*} {G : SimpleGraph V} :
  Ladders.IsLadder G →
  GridsAndWalls.IsGrid G

axiom ladder_outerplanar {V : Type*} {G : SimpleGraph V} :
  Ladders.IsLadder G →
  Outerplanar.IsOuterplanar G

axiom ladder_seriesParallel {V : Type*} {G : SimpleGraph V} :
  Ladders.IsLadder G →
  SeriesParallel.IsSeriesParallel G

axiom ladder_planar {V : Type*} {G : SimpleGraph V} :
  Ladders.IsLadder G →
  Planar.IsPlanar G

axiom halin_planar
    {V : Type*} [Fintype V] {G : SimpleGraph V} :
  HalinGraphs.IsHalin G →
  Planar.IsPlanar G

axiom wheel_halin
    {V : Type*} [Fintype V] {G : SimpleGraph V} :
  Wheels.IsWheel G →
  HalinGraphs.IsHalin G

axiom wheel_planar
    {V : Type*} [Fintype V] {G : SimpleGraph V} :
  Wheels.IsWheel G →
  Planar.IsPlanar G

axiom seriesParallel_planar {V : Type*} {G : SimpleGraph V} :
  SeriesParallel.IsSeriesParallel G →
  Planar.IsPlanar G

axiom tree_outerplanar {V : Type*} {G : SimpleGraph V} :
  Trees.IsTree G →
  Outerplanar.IsOuterplanar G

axiom tree_planar {V : Type*} {G : SimpleGraph V} :
  Trees.IsTree G →
  Planar.IsPlanar G

axiom path_tree {V : Type*} {G : SimpleGraph V} :
  Paths.IsPath G →
  Trees.IsTree G

axiom path_outerplanar {V : Type*} {G : SimpleGraph V} :
  Paths.IsPath G →
  Outerplanar.IsOuterplanar G

axiom path_planar {V : Type*} {G : SimpleGraph V} :
  Paths.IsPath G →
  Planar.IsPlanar G

axiom triangulation_planar {V : Type*} {G : SimpleGraph V} :
  Triangulations.IsTriangulation G →
  Planar.IsPlanar G

end Lax68.Relationships
