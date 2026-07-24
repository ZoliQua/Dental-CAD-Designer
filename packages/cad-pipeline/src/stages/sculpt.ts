// packages/cad-pipeline/src/stages/sculpt.ts
//
// Phase 4 Task 8: the FREEFORM SCULPTING stage — the FIFTH crown-design stage
// (docs/plans/phase-4-crown-design.md's 6 fixed-order stages). It applies a
// GESTURE (an ordered sequence of add/remove/smooth brush strokes) to the
// finished crown shell (Task 7) via `@dqcad/kernel`'s `applySculptGesture`,
// with the FIT SURFACE (inner intaglio + margin + margin-band seam) LOCKED by
// default so Task 4's ≤10 µm marginal fit survives sculpting.
//
// ## Coalesced journaling (invariant 3 spirit — the gesture, not the mousemove)
//
// The stage journals ONE `Operation` per GESTURE (mirroring the Phase 3
// margin-edit coalescing): every stroke is recorded in `params.strokes`, in
// application order, so REPLAYING the journal (re-running `applySculptGesture`
// from the same shell + the same strokes) reproduces the sculpted mesh
// BIT-IDENTICALLY (invariant 2). The UI streams per-mousemove strokes to the
// kernel op for interactivity but journals only when the gesture ends.
//
// ## The lock is default-on; unlocking is explicit + journaled (invariant 5)
//
// `computeShellLock` freezes the fit surface. Unlocking it (`unlockFitSurface:
// true`) is an explicit, destructive choice that is journaled
// (`params.unlockFitSurface`) — never silent. With the lock on, the ≤10 µm
// margin fit is preserved because the margin/seam/inner vertices are
// byte-identical before/after (proven in the tests); the stage additionally
// RE-MEASURES the fit after sculpting and records it (`marginFitMaxMm` on the
// closed shell + `innerMarginFitMm` via `measureMarginFit` on the untouched
// inner) so a regression could never pass silently.
//
// ## Watertight re-validated (invariant 4)
//
// `applySculptGesture` re-runs `analyzeMesh` and throws `SculptNotWatertightError`
// unless the result is a watertight single-component solid — a brush that would
// tear the shell is clamped by the kernel's fold guard, never shipped.
import type { FdiTooth } from '@dqcad/shared-types';
import {
  applySculptGesture,
  computeShellLock,
  marginLoopPolyline,
  buildBvh,
  closestPointBatch,
  type IndexedMesh,
  type SculptStroke,
} from '@dqcad/kernel';
import type { PipelineContext, PipelineMeshHandle } from '../pipeline/context.ts';
import type { RestorationStageResult } from '../pipeline/stageResult.ts';
import { measureMarginFit } from '../gates/marginFit.ts';

/** Thrown when the margin loop for the requested tooth is absent — the lock
 * anchors on the confirmed margin (and the fit re-measurement needs it). */
export class MissingMarginLoopError extends Error {
  constructor(tooth: FdiTooth) {
    super(`sculpt stage: no margin loop for tooth ${tooth} in context.marginLoops — a confirmed margin is required for the fit-surface lock`);
    this.name = 'MissingMarginLoopError';
  }
}

/** Thrown when a gesture carries no strokes — a no-op gesture is a caller bug
 * (nothing to journal), a loud failure rather than a silent empty op. */
export class EmptySculptGestureError extends Error {
  constructor() {
    super('sculpt stage: the gesture has no strokes — nothing to sculpt or journal');
    this.name = 'EmptySculptGestureError';
  }
}

export interface SculptStageOptions {
  /** The crown shell (Task 7 output) to sculpt. Immutable (a NEW mesh returned). */
  readonly shellMesh: PipelineMeshHandle;
  /** The inner intaglio surface (Task 4 output) — defines the LOCKED fit
   * surface (distance-to-inner) and is re-measured for margin fit. */
  readonly innerSurfaceMesh: PipelineMeshHandle;
  /** The gesture: an ordered sequence of brush strokes, journaled + replayed
   * as a unit. Applied in this exact order (deterministic). */
  readonly strokes: readonly SculptStroke[];
  /** Explicitly UNLOCK the fit surface (default `false`). Destructive — the
   * inner/margin/seam become sculptable and the ≤10 µm margin fit is no longer
   * guaranteed; journaled (`params.unlockFitSurface`), never silent. */
  readonly unlockFitSurface?: boolean;
  /** Optional lock-band tuning (mm) — margin-polyline lock band + inner epsilon
   * + seam ring growth. Defaults come from the kernel. */
  readonly marginLockBandMm?: number;
  readonly lockInnerEpsilonMm?: number;
  readonly seamRingGrowth?: number;
  /** Content-hash function for the produced mesh — injected by the caller
   * (hashing lives one layer up; same split as the other stages). Deterministic. */
  readonly hashMesh: (mesh: IndexedMesh) => string;
}

/** Max distance (mm) of any confirmed margin point to the (closed) shell
 * surface — the closed-crown margin-fit measure (Task 7). */
function marginFitToShellMm(shell: IndexedMesh, margin: readonly [number, number, number][]): number {
  const bvh = buildBvh(shell);
  const flat = new Float64Array(margin.flatMap((p) => [p[0], p[1], p[2]]));
  const res = closestPointBatch(shell, bvh, flat);
  let mx = 0;
  for (const r of res) if (r.distance > mx) mx = r.distance;
  return mx;
}

/**
 * Runs the freeform sculpting stage for `tooth` — see this file's module doc.
 * Pure function of `(context, tooth, options)`; returns the sculpted shell as a
 * `RestorationStageResult` ready to journal. Deterministic: same context +
 * options → byte-identical mesh + hash (so replaying `params.strokes` reproduces
 * the mesh bit-for-bit).
 *
 * @throws {MissingMarginLoopError} if `tooth` has no margin loop in the context.
 * @throws {EmptySculptGestureError} if `options.strokes` is empty.
 * @throws propagates the kernel's `SculptStrokeParamError` / `SculptNotWatertightError`.
 */
export function runSculptStage(context: PipelineContext, tooth: FdiTooth, options: SculptStageOptions): RestorationStageResult {
  const marginLoopInput = context.marginLoops[tooth];
  if (!marginLoopInput) throw new MissingMarginLoopError(tooth);
  if (options.strokes.length === 0) throw new EmptySculptGestureError();
  const marginLoop = marginLoopPolyline({ closed: marginLoopInput.closed, resampledPoints: marginLoopInput.resampledPoints });

  const shell = options.shellMesh.mesh;
  const inner = options.innerSurfaceMesh.mesh;
  const unlockFitSurface = options.unlockFitSurface === true;

  // --- the lock (default on; unlocking is explicit + journaled) ---
  let locked: Uint8Array;
  let lockedCount: number;
  let outerCount: number;
  if (unlockFitSurface) {
    locked = new Uint8Array(shell.positions.length / 3); // all-zero: nothing locked
    lockedCount = 0;
    outerCount = shell.positions.length / 3;
  } else {
    const lock = computeShellLock(shell, {
      innerMesh: inner,
      marginLoop,
      marginLockBandMm: options.marginLockBandMm,
      lockInnerEpsilonMm: options.lockInnerEpsilonMm,
      seamRingGrowth: options.seamRingGrowth,
    });
    locked = lock.locked;
    lockedCount = lock.lockedCount;
    outerCount = lock.outerCount;
  }

  // --- apply the gesture (re-validates watertight; fold-guard clamps tears) ---
  const result = applySculptGesture(shell, options.strokes, locked);

  // --- re-measure margin fit AFTER sculpting (the acceptance-linked property) ---
  // Closed-shell measure: every confirmed margin point still on the shell surface.
  const marginFitMaxMm = marginFitToShellMm(result.mesh, marginLoopInput.resampledPoints as readonly [number, number, number][]);
  // measureMarginFit on the UNTOUCHED inner (the fit surface the lock preserves
  // byte-for-byte) — its margin-boundary fit is the ≤10 µm baseline, unchanged.
  const innerFit = measureMarginFit(inner, marginLoopInput.resampledPoints);

  const meshContentHash = options.hashMesh(result.mesh);

  const params: Record<string, unknown> = {
    tooth,
    // Coalesced gesture: every stroke, in application order — REPLAY reproduces.
    strokes: options.strokes.map((s) => ({
      center: [s.center[0], s.center[1], s.center[2]],
      radiusMm: s.radiusMm,
      strength: s.strength,
      brush: s.brush,
    })),
    strokeCount: options.strokes.length,
    unlockFitSurface,
    lockedVertexCount: lockedCount,
    sculptableVertexCount: outerCount,
    marginLockBandMm: options.marginLockBandMm ?? 0,
    movedVertexCount: result.movedVertexCount,
    peakDisplacementMm: result.peakDisplacementMm,
    clampedStrokeCount: result.clampedStrokeCount,
    // Fit preserved evidence (both the closed-shell measure AND the untouched
    // inner's measureMarginFit — a regression cannot pass silently).
    marginFitMaxMm,
    innerMarginFitMm: innerFit.maxMm,
    shellWatertight: result.stats.watertight,
    shellComponentCount: result.stats.componentCount,
  };

  return {
    stage: 'freeform',
    mesh: result.mesh,
    meshContentHash,
    operationName: 'freeform.sculpt',
    params,
    inputHashes: [options.shellMesh.contentHash, options.innerSurfaceMesh.contentHash],
    // Sculpting is an EXACT deterministic displacement — no approximation error
    // beyond its inputs. (The fold-guard clamp is reported in params, not an
    // error bound.)
    errorBoundMm: null,
  };
}
