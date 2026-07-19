// packages/kernel/src/repair/types.ts
//
// Shared types for the repair pipeline (Task 8): removeComponents,
// splitNonManifoldEdges, fillSmallHoles. Every repair function is pure
// (never mutates its input `IndexedMesh`, always returns a fresh one — same
// "meshes are immutable, ops return new buffers" convention as intake/) and
// returns a journal-ready `report` alongside the result mesh: the report's
// `before`/`after` counts plus operation-specific `details` are exactly what
// a caller (apps/client/src/engine/repair.ts) wraps into a case-journal
// `Operation` (see @dqcad/shared-types' `Operation` doc) — this module has
// no knowledge of journaling/hashing itself, mirroring intake's
// IntakeReport/IntakeStepReport split (packages/kernel/src/intake/types.ts).

import type { Bbox } from '../intake/types.ts';

export type { Bbox };

/** Vertex/triangle counts before or after a repair — the same minimal shape
 * intake's `IntakeStepCounts` uses (packages/kernel/src/intake/report.ts),
 * reused here rather than duplicated. */
export interface RepairCounts {
  vertexCount: number;
  triangleCount: number;
}

// ---------------------------------------------------------------------------
// removeComponents
// ---------------------------------------------------------------------------

/** One connected component of the mesh `removeComponents` was called on,
 * as reported for preview purposes — `id` matches
 * `topology.ts`'s `ConnectedComponents.componentIndexOfRoot` numbering
 * (0-based, first-triangle-occurrence order; stable/deterministic). */
export interface ComponentInfo {
  id: number;
  triangleCount: number;
  /** Count of DISTINCT vertex indices referenced by this component's
   * triangles (not a range over `positions` — a component's vertices can be
   * interleaved with other components' in the shared vertex buffer). */
  vertexCount: number;
  bbox: Bbox;
}

/** Either select components to KEEP by id, or keep every component whose
 * triangle count is >= `minTriangles` (small-component removal — the brief's
 * primary use case: dropping scanner floaters/specks). Exactly one of the
 * two shapes — never both — so a caller's intent is unambiguous in the
 * journaled `params`. */
export type RemoveComponentsSelector =
  | { readonly mode: 'keep'; readonly keepIds: readonly number[] }
  | { readonly mode: 'minTriangles'; readonly minTriangles: number };

export interface RemoveComponentsReport {
  selector: RemoveComponentsSelector;
  /** Every component of the INPUT mesh (before removal) — the UI's preview
   * list. */
  components: readonly ComponentInfo[];
  keptComponentIds: readonly number[];
  removedComponentIds: readonly number[];
  before: RepairCounts;
  after: RepairCounts;
}

export interface RemoveComponentsResult {
  mesh: import('../mesh/types.ts').IndexedMesh;
  report: RemoveComponentsReport;
}

// ---------------------------------------------------------------------------
// splitNonManifoldEdges
// ---------------------------------------------------------------------------

export interface SplitNonManifoldEdgesReport {
  /** Non-manifold (degree > 2) edges found in the INPUT mesh. */
  nonManifoldEdgeCountBefore: number;
  /** Always 0 in a successful result — see splitNonManifoldEdges.ts's module
   * doc for the (rare, documented) case a single pass cannot fully resolve. */
  nonManifoldEdgeCountAfter: number;
  /** New vertices created (one per triangle-corner disconnected from a
   * non-manifold edge beyond its first 2 incidences — see module doc). */
  duplicatedVertexCount: number;
  before: RepairCounts;
  after: RepairCounts;
}

export interface SplitNonManifoldEdgesResult {
  mesh: import('../mesh/types.ts').IndexedMesh;
  report: SplitNonManifoldEdgesReport;
}

// ---------------------------------------------------------------------------
// splitNonManifoldVertices (Phase 2 Task 11 — "bowtie" split)
// ---------------------------------------------------------------------------

export interface SplitNonManifoldVerticesReport {
  /** Bowtie vertices (`findNonManifoldVertices`, halfedge/build.ts) found in
   * the INPUT mesh — every edge around each of these already has degree
   * <= 2 (a DIFFERENT, narrower non-manifoldness than
   * `SplitNonManifoldEdgesReport.nonManifoldEdgeCountBefore`, see
   * splitNonManifoldVertices.ts's module doc). */
  nonManifoldVertexCountBefore: number;
  /** Always 0 in a successful result — re-verified (not assumed) by
   * re-running `findNonManifoldVertices` on the OUTPUT mesh, same
   * "verified, not assumed" convention `splitNonManifoldEdges.ts` uses for
   * its own `nonManifoldEdgeCountAfter`. */
  nonManifoldVertexCountAfter: number;
  /** New vertices created — one per bowtie vertex's extra fan beyond its
   * first (kept-original-id) fan; see module doc's "first-fan-keeps-
   * original" convention. */
  duplicatedVertexCount: number;
  before: RepairCounts;
  after: RepairCounts;
}

export interface SplitNonManifoldVerticesResult {
  mesh: import('../mesh/types.ts').IndexedMesh;
  report: SplitNonManifoldVerticesReport;
}

// ---------------------------------------------------------------------------
// fillSmallHoles
// ---------------------------------------------------------------------------

export interface FillSmallHolesOptions {
  /** A boundary loop with more edges than this is refused (skipped, not
   * filled) — the brief's default of 32 keeps ear-clipping's O(n^3) cost
   * trivial and, per the plan's Phase 1 deviation note, keeps the
   * non-curvature-continuous fill's honest error bound small (a big loop
   * projected to one best-fit plane is far more likely to be badly
   * non-planar). */
  maxBoundaryEdges?: number;
  /** A boundary loop whose (3D, best-fit-plane) polygon area exceeds this is
   * also refused. `undefined` (the default) disables the area gate — only
   * `maxBoundaryEdges` applies. */
  maxAreaMm2?: number;
}

export const DEFAULT_MAX_BOUNDARY_EDGES = 32;

/** `degenerate` covers a boundary loop whose best-fit-plane normal collapses
 * to (near) zero length — e.g. a collinear or otherwise geometrically
 * degenerate loop, which ear-clipping cannot meaningfully triangulate. Rare
 * in practice (real scan boundaries are never perfectly collinear) but
 * handled defensively rather than left to throw.
 *
 * `bowtie-adjacent` (Fix batch, post-Task-11): the loop's boundary-plus-
 * context vertex set (its own boundary-loop vertices, plus every vertex of
 * every original triangle incident to one of them — exactly
 * curvatureFill.ts's local-mesh node set) contains a bowtie vertex
 * (`findNonManifoldVertices`, halfedge/build.ts). This is the loud refusal
 * for the gap that function's module doc used to leave silent: filling such
 * a loop anyway would silently under-weight that vertex's Laplacian row
 * (its one-ring within the local patch+context mesh is incomplete because
 * `buildHalfedge` does not reject bowtie vertices), producing a
 * curvature-continuity result that is quietly WORSE than reported rather
 * than refused. `SkippedHole.bowtieVertexIndices` names the offending
 * vertex id(s); the fix is `splitNonManifoldVertices.ts` — run it first,
 * then re-run `fillSmallHoles` (see fillSmallHoles.test.ts's end-to-end
 * "bowtie-adjacent" test for exactly this workflow). */
export type SkippedHoleReason = 'tooManyEdges' | 'tooLargeArea' | 'degenerate' | 'bowtie-adjacent';

export interface SkippedHole {
  boundaryEdgeCount: number;
  areaMm2: number;
  reason: SkippedHoleReason;
  /** One representative vertex index from the loop — enough for a caller to
   * highlight roughly where the refused hole is without this report having
   * to carry the whole loop. */
  sampleVertexIndex: number;
  /** Populated ONLY when `reason` is `'bowtie-adjacent'` — every bowtie
   * vertex id (ascending) found in this loop's boundary+context vertex set
   * (see that reason's doc above). Deliberately OPTIONAL (absent, not
   * `undefined`-valued, for every other reason) so a mesh with no bowties
   * — e.g. this package's own golden fixture — serializes this report
   * byte-identically to before this field existed; JSON.stringify drops an
   * absent key exactly like an `undefined`-valued one. */
  bowtieVertexIndices?: readonly number[];
}

export interface FillSmallHolesReport {
  maxBoundaryEdges: number;
  maxAreaMm2: number | null;
  loopsFound: number;
  loopsFilled: number;
  loopsSkipped: readonly SkippedHole[];
  /** New (fan-centroid + chord-midpoint) interior vertices added across
   * every filled loop — see module doc's "Refining the ear-clip patch"
   * section. */
  newVertexCount: number;
  newTriangleCount: number;
  /** Count of filled loops whose curvature-continuity solve
   * (curvatureFill.ts) could not run (local patch+context topology was
   * itself non-manifold-edge — see that file's "Fallback" section) and
   * therefore used the plain Laplacian relax fallback instead. `0` in the
   * overwhelmingly common case; a nonzero value does NOT mean the fill
   * failed (the mesh is still watertight/manifold), only that this
   * specific loop's patch is not curvature-continuous. */
  curvatureFallbackLoopCount: number;
  before: RepairCounts;
  after: RepairCounts;
}

export interface FillSmallHolesResult {
  mesh: import('../mesh/types.ts').IndexedMesh;
  report: FillSmallHolesReport;
}
