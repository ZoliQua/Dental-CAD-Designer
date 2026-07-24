// packages/cad-pipeline/src/gates/watertight.ts
//
// Phase 4 Task 9: the WATERTIGHT and MANIFOLD QC gates — the two purely
// topological gates of the §6 crown gate set. Both read `@dqcad/kernel`'s
// `analyzeMesh` (`intake/analyze.ts`) `MeshStats` — a read-only combinatorial
// analysis (edge degree, boundary edges, connected components) that never
// mutates the mesh — so both gates are pure, deterministic, Node- and
// worker-callable (invariant 6), and touch no renderer.
//
// ## Why they take a pre-computed `MeshStats`, not the mesh
//
// `analyzeMesh` is a single O(triangles) pass that yields BOTH the watertight
// flag and the manifold/component facts these two gates need. The QC report
// assembly (`report.ts`) runs it ONCE on the finished crown solid and hands
// the same `MeshStats` to both gates, so the report never re-analyzes the same
// mesh twice. Each gate is still a pure `(input) => QcGateResult` (mirrors
// `marginFit.ts` / `minWallThickness.ts`); a unit test simply calls
// `analyzeMesh(mesh)` itself and passes the result.
//
// ## Fail-safe: a degenerate / empty analysis FAILS, never passes
//
// A mesh with zero triangles reports `watertight: false` from `analyzeMesh`
// (it guards `triangleCount > 0`), so the empty-mesh case fails both gates
// rather than trivially passing — the QC-gate safety direction (CLAUDE.md
// invariant 4: a gate never silently passes something unverifiable).
import type { MeshStats } from '@dqcad/kernel';
import type { QcGateResult } from '@dqcad/shared-types';

/** Stable gate names (used in the QcReport, acknowledgment lookup, UI). */
export const WATERTIGHT_GATE_NAME = 'watertight';
export const MANIFOLD_GATE_NAME = 'manifold';

export interface TopologyGateInput {
  /** The finished crown solid's `analyzeMesh` result — computed once by the
   * report assembly (see this file's module doc). */
  readonly stats: MeshStats;
}

/**
 * The WATERTIGHT QC gate — passes iff the crown solid is closed (no boundary
 * edges, no non-manifold edges, non-empty): `analyzeMesh`'s `watertight` flag.
 * A non-watertight crown cannot be milled/printed as a solid and cannot be
 * booleaned (the manifold-3d wrapper rejects it), so this blocks export.
 * Pure/deterministic; no threshold (a boolean gate — `value`/`threshold` are
 * `null`).
 */
export function watertightGate(input: TopologyGateInput): QcGateResult {
  const { watertight, boundaryEdgeCount } = input.stats;
  return {
    gate: WATERTIGHT_GATE_NAME,
    passed: watertight,
    acknowledged: false,
    value: null,
    threshold: null,
    unit: null,
    message: watertight
      ? 'watertight (closed 2-manifold surface, no boundary edges)'
      : `NOT watertight — ${boundaryEdgeCount} boundary (open) edge(s); the crown solid has holes/open rims and cannot be exported as a solid`,
  };
}

/**
 * The MANIFOLD QC gate — passes iff the crown solid has NO non-manifold edges
 * (`analyzeMesh`'s `manifoldEdges`) AND is a single connected component
 * (`componentCount === 1`). A non-manifold edge (shared by ≠2 faces) or a
 * stray disconnected shell is a topological defect that fails downstream
 * boolean/milling. Pure/deterministic; boolean gate (no threshold).
 */
export function manifoldGate(input: TopologyGateInput): QcGateResult {
  const { manifoldEdges, componentCount } = input.stats;
  const passed = manifoldEdges && componentCount === 1;
  let message: string;
  if (passed) {
    message = 'manifold (no non-manifold edges) and a single connected component';
  } else if (!manifoldEdges && componentCount !== 1) {
    message = `NOT manifold — non-manifold edge(s) present AND ${componentCount} disconnected component(s) (expected 1)`;
  } else if (!manifoldEdges) {
    message = 'NOT manifold — one or more edges are shared by ≠ 2 faces (non-manifold edge)';
  } else {
    message = `NOT a single solid — ${componentCount} disconnected component(s) (expected 1); stray shells must be removed`;
  }
  return {
    gate: MANIFOLD_GATE_NAME,
    passed,
    acknowledged: false,
    value: componentCount,
    threshold: 1,
    unit: 'components',
    message,
  };
}
