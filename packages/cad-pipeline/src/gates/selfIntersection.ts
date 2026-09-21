// packages/cad-pipeline/src/gates/selfIntersection.ts
//
// Phase 4 Task 9 / Feature #4: the SELF-INTERSECTION QC gate — the §6 "no
// self-intersections" gate. This is now a TRUE geometric determination, not a
// topology proxy: it runs the kernel's BVH-accelerated triangle–triangle
// self-intersection scan (`findSelfIntersections`, packages/kernel/src/
// intersect/) over the restoration solid, and ALSO keeps the manifold-3d
// construction check as a corroborating necessary condition.
//
// ## What the gate now proves (strictly stronger than the old proxy)
//
// The gate passes iff BOTH hold:
//   1. `manifoldValid` — manifold-3d accepts the mesh as a valid solid
//      (2-manifold topology, finite vertices, orientable) — the same
//      necessary-condition check as before; and
//   2. `geometricIntersectionPairs === 0` — the exact Float64 tri-tri scan
//      finds NO pair of non-adjacent faces that pass through each other.
//
// The old gate used (1) alone as a PROXY, and documented its blind spot: a mesh
// that is topologically 2-manifold and watertight but whose faces geometrically
// interpenetrate constructs a valid `Manifold` and so PASSED. Condition (2)
// closes that blind spot exactly. A PASS now means "provably free of
// triangle–triangle self-intersection up to the scan's @errorBound", not merely
// "manifold-3d accepts it". A FAIL is still always a genuine defect.
//
// ## @errorBound
//
// The geometric determination inherits `findSelfIntersections`'s bound
// (`packages/kernel/src/intersect/`): exact for non-degenerate, non-coplanar
// Float64 face pairs; a 1e-9 mm on-plane snap for coplanar/near-coplanar
// configs (6 orders of magnitude below the 1 µm clinical resolution).
// Topologically-adjacent faces (sharing ≥1 vertex index) are excluded by the
// scan — they meet at the shared feature by construction and are NOT
// self-intersections. Degenerate (zero-area) triangles are counted and
// excluded from pairing (surfaced as `degenerateTrianglesSkipped`), never
// silently guessed — and an intake-repaired solid has none.
//
// ## Pure split (async measure + sync gate), like `seating.ts`
//
// manifold-3d construction is WASM and async, so the measurement
// (`measureSelfIntersection`) is an async function done ONCE by the report
// assembly; the geometric scan is pure synchronous Float64 kernel code run
// inside it. The gate itself (`selfIntersectionGate`) stays a pure synchronous
// `(measurement) => QcGateResult` the deterministic runner can call. DOM/Three-
// free (invariant 6); determinism = same manifold-3d version + the scan's own
// fixed-order, no-Date.now/no-random guarantee.
import {
  volume,
  NonManifoldInputError,
  findSelfIntersections,
  type IndexedMesh,
} from '@dqcad/kernel';
import type { QcGateResult } from '@dqcad/shared-types';

/** Stable gate name (QcReport, acknowledgment lookup, UI). */
export const SELF_INTERSECTION_GATE_NAME = 'selfIntersection';

export interface SelfIntersectionMeasurement {
  /** True iff manifold-3d accepted the mesh as a valid solid (necessary
   * condition; corroborates the geometric scan). */
  readonly manifoldValid: boolean;
  /** The manifold-3d `ErrorStatus` string when construction FAILED, else null.
   * Typed loosely (`string`) to avoid importing manifold-3d into cad-pipeline. */
  readonly rejectionStatus: string | null;
  /** The constructed solid's volume (mm³) when valid — surfaced for the report;
   * null when construction failed. */
  readonly volumeMm3: number | null;
  /** Genuine self-intersecting face pairs found by the exact geometric tri-tri
   * scan (topologically-adjacent pairs + degenerate triangles excluded). 0 ⇒
   * provably free of triangle–triangle self-intersection up to the @errorBound. */
  readonly geometricIntersectionPairs: number;
  /** The lexicographically-smallest self-intersecting pair (triangle indices)
   * for the report's diagnostic locus, or null when there are none. */
  readonly geometricFirstLocus: { readonly triangleA: number; readonly triangleB: number } | null;
  /** Degenerate (zero-area) triangles the scan excluded from pairing — surfaced
   * (not silently dropped). Expected 0 for an intake-repaired solid. */
  readonly degenerateTrianglesSkipped: number;
  /** Triangles scanned — for the report / cost transparency. */
  readonly triangleCount: number;
  /** Narrow-phase tri-tri predicate evaluations actually run — the scan's
   * honest cost metric (the BVH broad phase's job is to keep this ≪ n²);
   * surfaced per the scan's module doc, not silently dropped. */
  readonly candidatePairsTested: number;
}

/**
 * Measures self-intersection of `mesh` two independent ways: the exact Float64
 * geometric tri-tri scan (`findSelfIntersections` — the primary, sufficient
 * determination) and manifold-3d construction (a corroborating necessary
 * condition). Async (manifold-3d is WASM); deterministic for a fixed
 * manifold-3d version + the scan's own determinism guarantee. Never throws for
 * a clinical failure — a mesh manifold-3d rejects returns `{ manifoldValid:
 * false, rejectionStatus, ... }` with the geometric fields still populated (the
 * scan does not require watertightness). The caller passes the finished,
 * intake/cleanup-repaired restoration solid (the same one the other gates see).
 */
export async function measureSelfIntersection(
  mesh: IndexedMesh,
): Promise<SelfIntersectionMeasurement> {
  // Geometric scan first — pure Float64 kernel, independent of manifold-3d and
  // never dependent on watertightness.
  const scan = findSelfIntersections(mesh);
  const geometric = {
    geometricIntersectionPairs: scan.intersectingPairCount,
    geometricFirstLocus: scan.firstLocus,
    degenerateTrianglesSkipped: scan.degenerateTrianglesSkipped,
    triangleCount: scan.triangleCount,
    candidatePairsTested: scan.candidatePairsTested,
  };
  try {
    const v = await volume(mesh);
    return { manifoldValid: true, rejectionStatus: null, volumeMm3: v, ...geometric };
  } catch (error) {
    if (error instanceof NonManifoldInputError) {
      return { manifoldValid: false, rejectionStatus: error.status, volumeMm3: null, ...geometric };
    }
    throw error;
  }
}

export interface SelfIntersectionGateInput {
  readonly measurement: SelfIntersectionMeasurement;
  /** The restoration noun for the message ('crown' / 'inlay' / 'onlay' /
   * 'bridge'). The gate is shared by `runCrownQc`, `runInlayQc`, and the bridge
   * report; the crown path omits it (defaults to 'crown'). */
  readonly restorationLabel?: string;
}

/**
 * The self-intersection QC gate — passes iff the exact geometric tri-tri scan
 * found NO self-intersecting face pair AND manifold-3d accepted the restoration
 * solid (see this module's doc). Boolean gate (no threshold). Pure/deterministic;
 * Node- and worker-callable.
 */
export function selfIntersectionGate(input: SelfIntersectionGateInput): QcGateResult {
  const {
    manifoldValid,
    rejectionStatus,
    geometricIntersectionPairs,
    geometricFirstLocus,
    triangleCount,
  } = input.measurement;
  const noun = input.restorationLabel ?? 'crown';
  const passed = manifoldValid && geometricIntersectionPairs === 0;

  let message: string;
  if (passed) {
    message =
      `no self-intersection detected — the exact triangle–triangle geometric scan found 0 self-intersecting ` +
      `face pairs across ${triangleCount} triangles, and manifold-3d accepts the ${noun} as a valid solid ` +
      '(provably free of triangle–triangle self-intersection up to the gate @errorBound; ' +
      'topologically-adjacent faces excluded)';
  } else if (geometricIntersectionPairs > 0) {
    const locus = geometricFirstLocus
      ? ` (first at triangles ${geometricFirstLocus.triangleA}↔${geometricFirstLocus.triangleB})`
      : '';
    const manifoldNote = manifoldValid
      ? 'manifold-3d accepted the topology, but the geometry is not a valid solid'
      : `manifold-3d also rejected it (status ${rejectionStatus ?? 'unknown'})`;
    message =
      `self-intersection — the geometric triangle–triangle scan found ${geometricIntersectionPairs} ` +
      `self-intersecting face pair(s) in the ${noun}${locus}; ${manifoldNote}`;
  } else {
    message =
      `invalid solid — manifold-3d rejected the ${noun} (status ${rejectionStatus ?? 'unknown'}); ` +
      'the surface is not a valid solid (non-manifold or non-finite geometry), ' +
      'though the geometric triangle–triangle scan found no interpenetrating face pair';
  }

  // Boolean gate (no numeric threshold), as before — the pair count lives in
  // the message + the measurement, so value/threshold/unit stay null.
  return {
    gate: SELF_INTERSECTION_GATE_NAME,
    passed,
    acknowledged: false,
    value: null,
    threshold: null,
    unit: null,
    message,
  };
}
