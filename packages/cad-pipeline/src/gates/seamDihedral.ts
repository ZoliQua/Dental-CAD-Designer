// packages/cad-pipeline/src/gates/seamDihedral.ts
//
// Phase 5 Task 4: the SEAM-DIHEDRAL (G1-continuity) gate — the < 5° phase
// acceptance criterion (docs/plans/phase-5-inlay-onlay.md Task 4 / PLAN.md
// Phase 5 acceptance: "the boundary blend is G1-continuous: dihedral angle < 5°
// along the seam"). It measures the maximum dihedral angle between the occlusal
// patch's boundary and the surrounding intact tooth along the OCCLUSAL SEAM
// segments, and passes iff that maximum is < `SEAM_DIHEDRAL_GATE_THRESHOLD_DEG`.
//
// ## Seam ONLY — free segments are never in the gate value (false-accuracy trap)
//
// A break-through MOD outline has occlusal SEAM segments (adjacent intact tooth
// exists → G1 is defined) and proximal FREE segments (the tooth is cut through →
// nothing to be continuous with). The G1 acceptance applies to the SEAM ONLY.
// This gate consumes the seam-edge list the patch build produced
// (`OcclusalPatchResult.seamEdges`) and measures across THOSE edges alone; a
// measurement diluted over free segments (or that claimed 5° where blending is
// not even defined) would be a false-accuracy failure (the brief's non-negotiable).
// The kernel measurement reports the per-segment (buccal/lingual) breakdown so a
// localized failure is visible, never averaged away.
//
// ## Empty seam is a FAILURE, never a silent pass
//
// If the seam-edge set is empty (a mis-partitioned outline), `sampleCount === 0`
// and this gate FAILS (`value = null`, `passed = false`) rather than reporting a
// vacuous `max = 0`. A gate that passes because it measured nothing is exactly
// the silent-bypass CLAUDE.md invariant 4 forbids.
//
// ## Dual-validation: ZERO DOM/Three/browser deps
//
// Like `marginFit.ts` / `minWallThickness.ts`, this is a pure
// `(input) -> QcGateResult` over plain Float64 buffers + the `@dqcad/kernel`
// `measureSeamDihedral` instrument — callable identically from the client worker
// and the Node server (invariant 6), never touching a renderer. The threshold is
// a fixed QC GATE TOLERANCE set by the phase acceptance (like marginFit's 10 µm),
// NOT a clinical design default (CLAUDE.md invariant 7) — never weakened to make
// a test pass.
import type { IndexedMesh, SeamEdge, SeamDihedralMeasurement } from '@dqcad/kernel';
import { measureSeamDihedral } from '@dqcad/kernel';
import type { QcGateResult } from '@dqcad/shared-types';

/** The < 5° phase acceptance threshold (deg) for occlusal-patch G1 seam
 * continuity (docs/plans/phase-5-inlay-onlay.md Task 4 / PLAN.md Phase 5). A
 * fixed QC GATE TOLERANCE set by the phase acceptance criterion, NOT a clinical
 * design default. Overridable per-call for testing a deliberately tight/loose
 * bar; the phase gate itself is fixed. */
export const SEAM_DIHEDRAL_GATE_THRESHOLD_DEG = 5;

/** The gate name (stable — used in the QcReport, acknowledgment lookup, UI). */
export const SEAM_DIHEDRAL_GATE_NAME = 'seamDihedral';

export interface SeamDihedralGateInput {
  /** The finished occlusal patch (outer surface) — outward-oriented. */
  readonly patchMesh: IndexedMesh;
  /** The full tooth-with-cavity solid (the surrounding surface). */
  readonly toothMesh: IndexedMesh;
  /** The OCCLUSAL SEAM edges to measure across (from the patch build —
   * `OcclusalPatchResult.seamEdges`). Free proximal edges are NOT included. */
  readonly seamEdges: readonly SeamEdge[];
  /** Cavity-surface triangle indices to exclude when disambiguating the
   * surrounding triangle across each seam edge (from the patch build —
   * `OcclusalPatchResult.cavityTriangleIndices`). */
  readonly cavityTriangleIndices: ReadonlySet<number> | Uint32Array;
  /** Override the 5° threshold (testing only — the phase gate is fixed). */
  readonly thresholdDeg?: number;
}

/**
 * The seam-dihedral (G1) QC gate — emits a `QcGateResult` with the measured max
 * seam dihedral (deg) as `value`, the threshold (default
 * `SEAM_DIHEDRAL_GATE_THRESHOLD_DEG`) as `threshold`, `'deg'` unit. `passed` iff
 * `sampleCount > 0` AND `value < threshold`. Pure/deterministic; Node- and
 * worker-callable. See this module's doc for the seam-only + empty-seam-fails
 * policy.
 *
 * @throws {SeamEdgeNotOnMeshError} (from `measureSeamDihedral`) if a seam edge is
 * not a shared bit-exact edge of both meshes.
 */
export function seamDihedralGate(input: SeamDihedralGateInput): QcGateResult {
  const thresholdDeg = input.thresholdDeg ?? SEAM_DIHEDRAL_GATE_THRESHOLD_DEG;
  const exclude = input.cavityTriangleIndices instanceof Uint32Array ? new Set<number>(input.cavityTriangleIndices) : input.cavityTriangleIndices;
  const m: SeamDihedralMeasurement = measureSeamDihedral(input.patchMesh, input.toothMesh, input.seamEdges, {
    excludeToothTriangles: exclude,
  });

  if (m.sampleCount === 0) {
    return {
      gate: SEAM_DIHEDRAL_GATE_NAME,
      passed: false,
      acknowledged: false,
      value: null,
      threshold: thresholdDeg,
      unit: 'deg',
      message: `seam dihedral UNMEASURED (0 seam edges) — a mis-partitioned outline; treated as a FAILURE, never a silent pass`,
    };
  }

  const passed = m.maxDeg < thresholdDeg;
  const perSeg = Object.keys(m.perSegmentMaxDeg)
    .sort()
    .map((k) => `${k} ${m.perSegmentMaxDeg[k]!.toFixed(2)}°`)
    .join(', ');
  const message = passed
    ? `seam dihedral max ${m.maxDeg.toFixed(3)}° < ${thresholdDeg}° (mean ${m.meanDeg.toFixed(3)}°, n=${m.sampleCount}; ${perSeg})`
    : `seam dihedral max ${m.maxDeg.toFixed(3)}° exceeds ${thresholdDeg}° (mean ${m.meanDeg.toFixed(3)}°, n=${m.sampleCount}; ${perSeg})`;

  return {
    gate: SEAM_DIHEDRAL_GATE_NAME,
    passed,
    acknowledged: false,
    value: m.maxDeg,
    threshold: thresholdDeg,
    unit: 'deg',
    message,
  };
}
