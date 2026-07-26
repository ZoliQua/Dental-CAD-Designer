// packages/cad-pipeline/src/gates/selfIntersection.ts
//
// Phase 4 Task 9: the SELF-INTERSECTION QC gate — the §6 "no self-intersections"
// gate. Per the plan it is evaluated "via manifold status": a mesh that
// constructs a valid `Manifold` through the `boolean/manifold.ts` wrapper is
// non-self-intersecting *per manifold-3d's definition of a valid solid*.
//
// ## @errorBound — this is a PROXY, and its limitation is stated honestly
//
// `@dqcad/kernel`'s `analyzeMesh` (`intake/analyze.ts`) deliberately does NOT
// test geometric self-intersection — its own doc says a dedicated
// self-intersection gate is later (this) work, and that the available check is
// manifold-3d construction. So this gate uses manifold-3d construction (via the
// wrapper's `volume`, which builds a `Manifold` and rejects invalid input with
// `NonManifoldInputError`) as the PROXY, and documents the limitation:
//
//   - manifold-3d's constructor validates 2-manifold TOPOLOGY (every edge shared
//     by exactly two faces, consistent halfedge structure), finite vertices, and
//     an orientable/consistent solid. It rejects the classes it can detect
//     (`NotManifold`, `NonFiniteVertex`, `InvalidConstruction`, …).
//   - It does NOT run a full triangle–triangle intersection test. A mesh that is
//     topologically 2-manifold and watertight but whose faces pass THROUGH each
//     other geometrically can still construct a `Manifold` and therefore PASS
//     this proxy. That geometric blind spot is the documented error bound of this
//     gate; a dedicated exact triangle-intersection test is deferred future work.
//
// Because the proxy is a NECESSARY (not sufficient) condition, a FAIL here is
// always a genuine defect (manifold-3d could not accept the solid); a PASS means
// "manifold-3d accepts this as a valid solid", not "provably free of every
// geometric self-intersection". The gate message says so.
//
// ## Pure split (async measure + sync gate), like `seating.ts`
//
// The manifold-3d construction is WASM and async, so the measurement
// (`measureSelfIntersection`) is an async function done ONCE by the report
// assembly; the gate itself (`selfIntersectionGate`) is a pure synchronous
// `(measurement) => QcGateResult` the deterministic runner can call. DOM/Three-
// free (invariant 6); WASM determinism = same manifold-3d version.
import { volume, NonManifoldInputError, type IndexedMesh } from '@dqcad/kernel';
import type { QcGateResult } from '@dqcad/shared-types';

/** Stable gate name (QcReport, acknowledgment lookup, UI). */
export const SELF_INTERSECTION_GATE_NAME = 'selfIntersection';

export interface SelfIntersectionMeasurement {
  /** True iff manifold-3d accepted the mesh as a valid solid (the proxy). */
  readonly manifoldValid: boolean;
  /** The manifold-3d `ErrorStatus` string when construction FAILED, else null.
   * Typed loosely (`string`) to avoid importing manifold-3d into cad-pipeline. */
  readonly rejectionStatus: string | null;
  /** The constructed solid's volume (mm³) when valid — surfaced for the report;
   * null when construction failed. */
  readonly volumeMm3: number | null;
}

/**
 * Probes whether `mesh` constructs a valid manifold-3d solid (the
 * self-intersection proxy — see this file's module doc). Async (WASM);
 * deterministic for a fixed manifold-3d version. Never throws for a clinical
 * failure — a rejected mesh returns `{ manifoldValid: false, rejectionStatus }`.
 * The construction is `repair-before-boolean`-clean: the caller passes the
 * finished, intake/cleanup-repaired crown solid (the same one the other gates
 * see); a non-watertight input is simply reported as invalid here (fail-safe).
 */
export async function measureSelfIntersection(mesh: IndexedMesh): Promise<SelfIntersectionMeasurement> {
  try {
    const v = await volume(mesh);
    return { manifoldValid: true, rejectionStatus: null, volumeMm3: v };
  } catch (error) {
    if (error instanceof NonManifoldInputError) {
      return { manifoldValid: false, rejectionStatus: error.status, volumeMm3: null };
    }
    throw error;
  }
}

export interface SelfIntersectionGateInput {
  readonly measurement: SelfIntersectionMeasurement;
  /** The restoration noun for the message ('crown' / 'inlay' / 'onlay'). The
   * gate is shared by `runCrownQc` and `runInlayQc`; the crown path omits it
   * (defaults to 'crown', keeping the crown message byte-identical), while the
   * cavity path passes its restoration type so the message no longer says "the
   * crown" for an inlay/onlay (the T6-review copy-artifact fix). */
  readonly restorationLabel?: string;
}

/**
 * The self-intersection QC gate — passes iff manifold-3d accepted the
 * restoration solid as a valid `Manifold` (the documented proxy). Boolean gate
 * (no threshold). Pure/deterministic; Node- and worker-callable.
 */
export function selfIntersectionGate(input: SelfIntersectionGateInput): QcGateResult {
  const { manifoldValid, rejectionStatus } = input.measurement;
  const noun = input.restorationLabel ?? 'crown';
  return {
    gate: SELF_INTERSECTION_GATE_NAME,
    passed: manifoldValid,
    acknowledged: false,
    value: null,
    threshold: null,
    unit: null,
    message: manifoldValid
      ? `no self-intersection detected — manifold-3d accepts the ${noun} as a valid solid ` +
        '(PROXY: manifold-3d validates 2-manifold topology + finite geometry, not a full triangle–triangle test; ' +
        'a topologically-manifold but geometrically self-intersecting mesh could still pass — see gate @errorBound)'
      : `self-intersection / invalid-solid — manifold-3d rejected the ${noun} (status ${rejectionStatus ?? 'unknown'}); ` +
        'the surface is not a valid solid (non-manifold, self-intersecting, or non-finite geometry)',
  };
}
