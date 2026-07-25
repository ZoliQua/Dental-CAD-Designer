// packages/cad-pipeline/src/gates/marginFit.ts
//
// Phase 4 Task 4: the MARGIN-FIT gate — the ≤10 µm phase acceptance
// criterion (docs/plans/phase-4-crown-design.md Task 4). It measures the max
// distance between the crown inner surface's MARGIN BOUNDARY and the confirmed
// margin spline, and passes iff that is <= `MARGIN_FIT_GATE_THRESHOLD_MM`
// (0.010 mm). The inner surface (`@dqcad/kernel`'s `buildInnerSurface`) is
// constructed so its open boundary loop IS the margin polyline (the skirt's
// bottom rim); this gate independently RE-MEASURES that coincidence from the
// finished mesh (finding the boundary loop topologically, not trusting the
// construction) — so a passing value is a genuine geometric check, not a
// tautology.
//
// ## CHORD-CAP (binding — the Phase 3 carry-in this gate must honour)
//
// The margin currency is the DENSE on-surface `resampledPoints`, NEVER the
// sparse anchor CHORDS (straight secants of a curved surface; measured
// 220-290 µm localized deviation on real fixtures — margin/band.ts's doc).
// Feeding anchor chords here would FALSELY FAIL a genuinely-good fit. This
// gate's input is therefore named `marginResampledPoints` and there is no code
// path that reads anchors.
//
// ## Dual-validation: ZERO DOM/Three/browser deps
//
// Like `runner.ts`, this is a pure `(data) -> QcGateResult` measurement over
// plain Float64 buffers + `@dqcad/kernel` topology utilities (`buildHalfedge`,
// `findBoundaryLoops`, `distanceToClosedPolyline`) — callable identically from
// the client worker and the Node server (invariant 6), never touching a
// renderer.
//
// ## Which boundary loop is "the margin"?
//
// A finished crown inner surface is an OPEN patch. Its MARGIN boundary is the
// marginal seal; but the patch can carry OTHER boundary loops that are NOT the
// margin — most importantly the OCCLUSAL/incisal opening where the intaglio
// will later be capped against the outer anatomy at the margin band (Task 7's
// shell), and, on a cropped ROI, small cut edges. Those are not marginal-seal
// failures, so this gate measures the MARGIN boundary loop specifically: the
// boundary loop whose directed distance TO the margin polyline is smallest (the
// loop that actually lies on the margin). It then reports the count and worst
// offset of any OTHER boundary loops (`extraBoundaryLoopCount`,
// `maxOtherLoopDistanceMm`) so a non-margin opening is surfaced honestly, never
// hidden — but the ≤10 µm PASS/FAIL is on the marginal seal, which is what the
// acceptance criterion is about.
//
// ## The measurement: symmetric directed Hausdorff (both directions)
//
// A one-sided "every margin-loop vertex is near the margin" check would pass a
// loop that covers only HALF the margin (a torn skirt). We take the MAX of BOTH
// directed distances between the chosen margin loop and the margin polyline —
// marginLoop->margin AND margin->marginLoop — so a gap in EITHER direction
// fails. Both use `distanceToClosedPolyline` (exact point-to-closed-polyline,
// Float64) against the dense point set.
import type { IndexedMesh, Vec3 } from '@dqcad/kernel';
import { buildHalfedge, findBoundaryLoops, destinationVertex, distanceToClosedPolyline } from '@dqcad/kernel';
import type { QcGateResult } from '@dqcad/shared-types';

/** The ≤10 µm phase acceptance threshold (mm) for crown margin fit
 * (docs/plans/phase-4-crown-design.md Task 4 / PLAN.md Phase 4 acceptance).
 * This is a QC GATE TOLERANCE (the maximum acceptable marginal-gap deviation
 * between the constructed crown boundary and the confirmed margin), not a
 * clinical DESIGN default (gaps/thicknesses — CLAUDE.md invariant 7, which
 * governs those); it is fixed by the phase acceptance criterion. Overridable
 * per-call for testing a deliberately-tight/loose bar. */
export const MARGIN_FIT_GATE_THRESHOLD_MM = 0.010;

/** The gate name (stable — used in the QcReport, acknowledgment lookup, UI). */
export const MARGIN_FIT_GATE_NAME = 'marginFit';

export interface MarginFitMeasurement {
  /** Symmetric directed-Hausdorff max distance (mm) between the MARGIN boundary
   * loop and the margin polyline — the gate value. */
  readonly maxMm: number;
  /** marginLoop -> margin directed max (mm). */
  readonly boundaryToMarginMm: number;
  /** margin -> marginLoop directed max (mm). */
  readonly marginToBoundaryMm: number;
  /** Total boundary loops on the mesh. */
  readonly boundaryLoopCount: number;
  /** Vertices in the chosen margin boundary loop. */
  readonly marginLoopVertexCount: number;
  /** Boundary loops that are NOT the margin (occlusal opening, ROI cuts) —
   * surfaced for transparency; not a marginal-seal failure. */
  readonly extraBoundaryLoopCount: number;
  /** The largest loop->margin distance among those OTHER loops (mm) — how far
   * the nearest non-margin opening sits from the margin. `0` if none. */
  readonly maxOtherLoopDistanceMm: number;
}

/** Thrown when the margin input is not the dense on-surface polyline the
 * chord-cap rule requires (empty / too few points). */
export class MarginFitInputError extends Error {
  constructor(reason: string) {
    super(`marginFitGate: ${reason} — the margin-fit gate consumes the DENSE resampledPoints (CHORD-CAP), never anchor chords`);
    this.name = 'MarginFitInputError';
  }
}

function boundaryLoopPositions(mesh: IndexedMesh): Vec3[][] {
  const hm = buildHalfedge(mesh);
  return findBoundaryLoops(hm).map((loop) =>
    loop.map((he) => {
      const v = destinationVertex(hm, he);
      return [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!] as Vec3;
    }),
  );
}

/**
 * Measures the margin fit of a finished crown inner surface against the
 * confirmed margin polyline (dense `resampledPoints`). Pure/deterministic.
 *
 * @throws {MarginFitInputError} if `marginResampledPoints` has < 3 points.
 */
export function measureMarginFit(innerSurfaceMesh: IndexedMesh, marginResampledPoints: readonly Vec3[]): MarginFitMeasurement {
  if (!marginResampledPoints || marginResampledPoints.length < 3) {
    throw new MarginFitInputError(`marginResampledPoints has ${marginResampledPoints?.length ?? 0} point(s)`);
  }
  const loops = boundaryLoopPositions(innerSurfaceMesh);
  if (loops.length === 0) {
    // Closed mesh: no margin boundary at all -> fail loudly (+Infinity) rather
    // than silently passing.
    return {
      maxMm: Number.POSITIVE_INFINITY,
      boundaryToMarginMm: 0,
      marginToBoundaryMm: Number.POSITIVE_INFINITY,
      boundaryLoopCount: 0,
      marginLoopVertexCount: 0,
      extraBoundaryLoopCount: 0,
      maxOtherLoopDistanceMm: 0,
    };
  }

  // Per-loop directed distance TO the margin; the MARGIN loop is the closest.
  const loopToMargin = loops.map((loop) => {
    let m = 0;
    for (const p of loop) {
      const d = distanceToClosedPolyline(p, marginResampledPoints);
      if (d > m) m = d;
    }
    return m;
  });
  let marginLoopIdx = 0;
  for (let i = 1; i < loops.length; i++) if (loopToMargin[i]! < loopToMargin[marginLoopIdx]!) marginLoopIdx = i;
  const marginLoop = loops[marginLoopIdx]!;
  const boundaryToMarginMm = loopToMargin[marginLoopIdx]!;

  // margin -> chosen margin loop (coverage: every margin point has a nearby
  // margin-loop vertex).
  let marginToBoundaryMm = 0;
  for (const p of marginResampledPoints) {
    const d = distanceToClosedPolyline(p, marginLoop);
    if (d > marginToBoundaryMm) marginToBoundaryMm = d;
  }

  let maxOtherLoopDistanceMm = 0;
  for (let i = 0; i < loops.length; i++) {
    if (i === marginLoopIdx) continue;
    if (loopToMargin[i]! > maxOtherLoopDistanceMm) maxOtherLoopDistanceMm = loopToMargin[i]!;
  }

  return {
    maxMm: Math.max(boundaryToMarginMm, marginToBoundaryMm),
    boundaryToMarginMm,
    marginToBoundaryMm,
    boundaryLoopCount: loops.length,
    marginLoopVertexCount: marginLoop.length,
    extraBoundaryLoopCount: loops.length - 1,
    maxOtherLoopDistanceMm,
  };
}

export interface MarginFitGateInput {
  readonly innerSurfaceMesh: IndexedMesh;
  /** The confirmed margin's DENSE on-surface polyline (`resampledPoints`) —
   * NEVER anchor chords (CHORD-CAP). */
  readonly marginResampledPoints: readonly Vec3[];
  /** Override the 0.010 mm threshold (testing only — the phase gate is fixed). */
  readonly thresholdMm?: number;
}

/**
 * The margin-fit QC gate — emits a `QcGateResult` with the measured max as
 * `value`, the threshold (default `MARGIN_FIT_GATE_THRESHOLD_MM`) as
 * `threshold`, `'mm'` unit. `passed` iff `value <= threshold`. `acknowledged`
 * is always `false` here (the runner sets it from the user's acknowledgment
 * list — see runner.ts). Pure/deterministic; Node- and worker-callable.
 *
 * @throws {MarginFitInputError} via `measureMarginFit`.
 */
export function marginFitGate(input: MarginFitGateInput): QcGateResult {
  const threshold = input.thresholdMm ?? MARGIN_FIT_GATE_THRESHOLD_MM;
  const m = measureMarginFit(input.innerSurfaceMesh, input.marginResampledPoints);
  const passed = Number.isFinite(m.maxMm) && m.maxMm <= threshold;
  const extras = m.extraBoundaryLoopCount > 0
    ? ` [${m.extraBoundaryLoopCount} non-margin boundary loop(s), nearest ${(m.maxOtherLoopDistanceMm * 1000).toFixed(0)} µm from margin — occlusal opening / ROI cut, capped by the shell (Task 7)]`
    : '';
  const message = passed
    ? `margin fit ${(m.maxMm * 1000).toFixed(2)} µm <= ${(threshold * 1000).toFixed(0)} µm (margin loop ${m.marginLoopVertexCount} verts)${extras}`
    : `margin fit ${Number.isFinite(m.maxMm) ? (m.maxMm * 1000).toFixed(2) + ' µm' : 'UNBOUNDED (no margin boundary loop)'} exceeds ${(threshold * 1000).toFixed(0)} µm ` +
      `(marginLoop->margin ${(m.boundaryToMarginMm * 1000).toFixed(2)} µm, margin->marginLoop ${Number.isFinite(m.marginToBoundaryMm) ? (m.marginToBoundaryMm * 1000).toFixed(2) + ' µm' : '∞'})${extras}`;
  return {
    gate: MARGIN_FIT_GATE_NAME,
    passed,
    acknowledged: false,
    value: Number.isFinite(m.maxMm) ? m.maxMm : null,
    threshold,
    unit: 'mm',
    message,
  };
}
