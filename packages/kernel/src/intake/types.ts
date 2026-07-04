// packages/kernel/src/intake/types.ts
//
// Shared types for the mesh intake pipeline (weld -> drop-degenerate ->
// orient-normals -> analyze -> intake). Float64 throughout, per the kernel's
// Global Constraints (docs/plans/phase-1-import-viewer.md).

import type { IndexedMesh } from '../mesh/types.ts';

/**
 * Structural twin of packages/io's `RawTriangleSoup`, deliberately NOT
 * imported from `@dqcad/io` — the layer rule (CLAUDE.md: `kernel` imports
 * nothing from `io`, only `shared-types`; see eslint.config.js's
 * `boundaries/dependencies` policy) forbids `packages/kernel` from depending
 * on `packages/io`. Every field here matches `RawTriangleSoup` exactly
 * (same field names, same shapes), so any `RawTriangleSoup` value produced
 * by `packages/io`'s STL/PLY parsers is a valid `TriangleSoup` by structural
 * typing — callers pass parser output straight into `weldVertices`/`intake`
 * with no conversion or copy required.
 *
 * `positions` is a flat, Float64, 9-values-per-triangle array in triangle
 * order (length = `triangleCount * 9`, i.e. an UNINDEXED "triangle soup" —
 * every triangle owns its own three vertices, with no shared-vertex
 * indexing). `normals`, when present, is one facet normal per triangle (3
 * values per triangle); `null` when the source carries no normals. Intake
 * never reads `normals` — orientation is derived purely from triangle
 * winding (see orient.ts) — it exists on this type only so `RawTriangleSoup`
 * values are structurally assignable without stripping fields.
 */
export interface TriangleSoup {
  positions: Float64Array;
  normals: Float64Array | null;
  triangleCount: number;
}

/** Either shape intake can start from: a raw unindexed soup (STL, or a PLY
 * mesh explicitly expanded via `indexedToSoup` — see soup.ts), which is run
 * through `weldVertices` first; or an already-indexed mesh (e.g. PLY parser
 * output, which is shared-vertex by construction) that skips the weld
 * stage entirely — see intake.ts's module doc for why skipping weld is
 * sound for that case and when a caller should convert to soup instead. */
export type IntakeInput = { kind: 'soup'; soup: TriangleSoup } | { kind: 'indexed'; mesh: IndexedMesh };

/** An axis-aligned bounding box, in mm. */
export interface Bbox {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
}

/**
 * Topological/geometric facts about an `IndexedMesh`, as reported by
 * `analyzeMesh`. Self-intersection is deliberately NOT one of these fields —
 * see analyze.ts's module doc for why that check is deferred to
 * manifold/QC time.
 */
export interface MeshStats {
  /** `true` iff the mesh is a closed 2-manifold: every edge is shared by
   * exactly 2 triangles (`manifoldEdges` holds) AND there is no boundary
   * (`boundaryEdgeCount === 0`). Equivalent to
   * `manifoldEdges && boundaryEdgeCount === 0`. */
  watertight: boolean;
  /** `true` iff no edge is shared by more than 2 triangles — i.e. the mesh
   * has no non-manifold edges. A mesh can be `manifoldEdges` and still have
   * boundary (open) edges; `watertight` additionally requires zero
   * boundary. */
  manifoldEdges: boolean;
  /** Number of connected components, where two triangles are connected iff
   * they share an edge (any multiplicity — this is the same connectivity
   * notion `orientNormalsConsistently` partitions its per-component
   * reasoning over, see orient.ts). */
  componentCount: number;
  /** Bounding box over every vertex actually referenced by `indices` (not
   * every entry in `positions` — a mesh that has passed through
   * `dropDegenerateTriangles` can have vertices in `positions` that no
   * longer appear in any triangle; those are excluded so the box reflects
   * the mesh's actual surface, not stale buffer contents). `{min:[0,0,0],
   * max:[0,0,0]}` for a mesh with zero triangles. */
  bbox: Bbox;
  /** Total surface area in mm² — sum of every triangle's area
   * (`|cross(v1-v0, v2-v0)| / 2`), regardless of manifoldness. */
  surfaceAreaMm2: number;
  /** Signed enclosed volume in mm³ via the divergence theorem, computed
   * ONLY when `watertight` is true (a well-defined enclosed volume requires
   * a closed 2-manifold surface) — `null` otherwise. Positive iff the
   * mesh's triangles wind CCW-from-outside (the kernel's outward-normal
   * convention, matching `boolean/manifold.ts`'s winding requirement). */
  signedVolumeMm3: number | null;
  /** Count of triangles that are degenerate by the same criteria
   * `dropDegenerateTriangles` uses (see degenerate.ts): zero cross-product
   * norm (< 1e-12 mm²) or a repeated vertex index. This is a read-only
   * diagnostic — `analyzeMesh` never removes anything; call
   * `dropDegenerateTriangles` first if you want them gone. */
  degenerateCount: number;
  /** Count of boundary edges — edges shared by exactly 1 triangle. */
  boundaryEdgeCount: number;
}

/** Per-connected-component counts, before/after triangle-count values used
 * by `IntakeStepReport`. */
export interface IntakeStepCounts {
  vertexCount: number;
  triangleCount: number;
}

/** One journal-ready entry in an `IntakeReport`: what a single intake stage
 * did, in terms a case journal `Operation` can record (before/after counts
 * plus step-specific detail numbers — e.g. `flippedCount` for the orient
 * stage). See report.ts for how these are built. */
export interface IntakeStepReport {
  step: 'weld' | 'dropDegenerateTriangles' | 'orientNormalsConsistently';
  before: IntakeStepCounts;
  after: IntakeStepCounts;
  /** Step-specific counts (e.g. `{ degenerateCount, duplicateIndexCount }`
   * for `dropDegenerateTriangles`, `{ flippedCount, componentCount,
   * ambiguousComponentCount }` for `orientNormalsConsistently`). Kept as a
   * loosely-typed bag (rather than a per-step union) so `IntakeReport` has
   * one flat, easy-to-journal shape — the step-specific test files assert
   * on the exact keys each step populates. */
  details: Record<string, number>;
}

/** Journal-ready summary of a full `intake()` run: the weld epsilon used
 * (a clinical parameter, see weld.ts's `MESH_WELD_EPSILON_MM` doc) plus one
 * `IntakeStepReport` per stage actually run (the weld stage is omitted
 * entirely — not just zeroed — when `IntakeInput.kind === 'indexed'`, since
 * no weld ran). */
export interface IntakeReport {
  weldEpsilonMm: number;
  steps: IntakeStepReport[];
}

/** Progress/behavior knobs for `intake()`. See intake.ts's module doc for
 * why cancellation is intentionally NOT offered here (only at the
 * kernel-workers `intakeMesh` job layer, which has real yield points
 * between stages). */
export interface IntakeOptions {
  /** Overrides `MESH_WELD_EPSILON_MM` (weld.ts) — present for tests and
   * advanced callers; production callers should not need this (the weld
   * tolerance is a fixed clinical constant, PLAN.md §3). Ignored when
   * `IntakeInput.kind === 'indexed'` (no weld stage runs). */
  epsilon?: number;
  /** Called with a fraction in [0, 1] after each of the (up to) 4 stages —
   * weld (if run), dropDegenerateTriangles, orientNormalsConsistently,
   * analyzeMesh. Fire-and-forget, called synchronously (intake() itself is
   * fully synchronous — see its module doc). */
  onProgress?: (fraction: number) => void;
}

export interface IntakeResult {
  mesh: IndexedMesh;
  stats: MeshStats;
  report: IntakeReport;
}
