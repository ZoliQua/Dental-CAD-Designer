// packages/cad-pipeline/src/stages/innerSurface.ts
//
// Phase 4 Task 3: the INNER-SURFACE stage — the FIRST real crown-design
// stage (docs/plans/phase-4-crown-design.md's 6 fixed-order stages). It
// orchestrates the kernel's two-zone inner-surface offset
// (`@dqcad/kernel`'s `innerSurfaceOffsetRoi`) into a `RestorationStageResult`
// the caller (engine layer) journals: the kernel does the geometry math, the
// stage supplies it the RESOLVED clinical params (from `PipelineContext`, per
// CLAUDE.md invariant 7 — NEVER hardcoded here), derives the prep ROI, and
// packages the output + error bound + journal fields.
//
// ## Clinical params come from the profile via the context — asserted loudly
//
// `marginalGapMm`, `cementGapMm`, `spacerStartMm` are read from
// `context.materialProfile.restorationParams` (which the caller resolved from
// the material profile). They are REQUIRED — this stage asserts each is a
// finite number and throws `MissingClinicalParamError` otherwise, rather than
// substituting any default (there is no crown fit surface without a real
// cement gap — a missing gap is a caller bug, not something to paper over).
//
// ## The prep ROI (perf, not correctness — see innerSurfaceOffsetRoi's doc)
//
// The offset's SDF grid is restricted to the prep region (the target scan
// ABOVE the margin, along the insertion axis) so a die-scale offset stays in
// the seconds, not ~120 s (the Task 1 `offsetMeshRoi` carry-in). Correctness
// is unaffected: distance queries still run against the FULL target mesh —
// only the sampled grid domain is the ROI. The ROI bbox is the bounding box
// of the margin loop unioned with every target vertex on the occlusal
// (insertion-axis-positive) side of the margin plane; the offset's own band
// padding then extends it far enough below the margin to capture the corner
// rounding. Insertion-axis convention: it points OCCLUSALLY (the crown's
// seating/draw direction — Phase 3's confirmed axis), so "prep region" is the
// margin-plane-positive half.
//
// ## Output: the FULL sealed inner surface (Task 4 — offset + blockout + skirt)
//
// Task 3 shipped this stage producing only the open two-zone offset patch.
// Task 4 completes it: the kernel op is now `buildInnerSurface`, which does the
// two-zone offset + SOLID undercut blockout (draft-close along the insertion
// axis) + SKIRT-TO-MARGIN in ONE journaled op. The output is the finished
// intaglio: an open patch whose single boundary loop == the confirmed margin
// polyline (the marginal seal), undercut-free along the axis. The crown shell
// (Task 7) caps it against the outer anatomy at the margin band. The ≤10 µm
// margin fit is a phase acceptance criterion, re-measured by `gates/marginFit.ts`.
import type { FdiTooth, Vec3 } from '@dqcad/shared-types';
import {
  buildInnerSurface,
  computeMarginLoopFrame,
  marginLoopPolyline,
  INNER_SURFACE_DEFAULT_BLEND_WIDTH_MM,
  type IndexedMesh,
} from '@dqcad/kernel';
import type { PipelineContext } from '../pipeline/context.ts';
import { assertCrownContext } from '../pipeline/context.ts';
import type { RestorationStageResult } from '../pipeline/stageResult.ts';

/** Thrown when the margin loop for the requested tooth is absent from the
 * context — the inner surface is defined relative to a confirmed margin;
 * there is nothing to offset without one. */
export class MissingMarginLoopError extends Error {
  constructor(tooth: FdiTooth) {
    super(`innerSurface stage: no margin loop for tooth ${tooth} in context.marginLoops — a confirmed margin is required`);
    this.name = 'MissingMarginLoopError';
  }
}

/** Thrown when a required clinical gap/spacer param is missing or non-finite
 * — see this file's module doc (never defaulted here; CLAUDE.md invariant 7). */
export class MissingClinicalParamError extends Error {
  constructor(paramName: string, value: unknown) {
    super(
      `innerSurface stage: required clinical param "${paramName}" is missing or non-finite (got ${String(value)}) — ` +
        `it must be resolved from the material profile onto context.materialProfile.restorationParams`,
    );
    this.name = 'MissingClinicalParamError';
  }
}

export interface InnerSurfaceStageOptions {
  /** Voxel pitch, mm — REQUIRED (no default here; the caller passes the
   * clinical `DEFAULT_OFFSET_VOXEL_PITCH_MM` from `@dqcad/clinical-profiles`,
   * which `cad-pipeline` may not import). */
  readonly pitchMm: number;
  /** C1 blend width, mm — default `INNER_SURFACE_DEFAULT_BLEND_WIDTH_MM`
   * (kernel algorithmic default; NOT a clinical gap/thickness). */
  readonly blendWidthMm?: number;
  /** Content-hash function for the produced mesh — injected by the caller
   * (hashing lives one layer up; see stageResult.ts's doc). Deterministic. */
  readonly hashMesh: (mesh: IndexedMesh) => string;
}

function assertFiniteParam(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new MissingClinicalParamError(name, value);
  }
}

/** Arithmetic-mean centroid of the (deduplicated) margin loop — the frame's
 * own centroid (computeMarginLoopFrame), reused so the ROI split plane and
 * any future frame-based stage agree on one reference point. */
function marginCentroid(loop: readonly Vec3[]): Vec3 {
  const frame = computeMarginLoopFrame(loop);
  return frame.centroidMm;
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!(len > 0)) throw new TypeError('innerSurface stage: insertionAxis must be a non-zero vector');
  return [v[0] / len, v[1] / len, v[2] / len];
}

/**
 * The prep-region ROI bbox: the bounding box of the margin loop unioned with
 * every target vertex on the occlusal (insertion-axis-positive) side of the
 * margin plane — see this file's module doc. Pure/deterministic.
 */
export function prepRegionRoiBbox(
  mesh: IndexedMesh,
  loop: readonly Vec3[],
  insertionAxis: Vec3,
): { min: Vec3; max: Vec3 } {
  const centroid = marginCentroid(loop);
  const axis = normalize(insertionAxis);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const grow = (x: number, y: number, z: number): void => {
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  };
  for (const p of loop) grow(p[0], p[1], p[2]);
  const vCount = mesh.positions.length / 3;
  for (let v = 0; v < vCount; v++) {
    const x = mesh.positions[v * 3]!;
    const y = mesh.positions[v * 3 + 1]!;
    const z = mesh.positions[v * 3 + 2]!;
    const side = (x - centroid[0]) * axis[0] + (y - centroid[1]) * axis[1] + (z - centroid[2]) * axis[2];
    if (side >= 0) grow(x, y, z);
  }
  return { min, max };
}

/**
 * Runs the inner-surface stage for `tooth` — see this file's module doc.
 * Pure async function of `(context, tooth, options)`; returns the two-zone
 * offset patch as a `RestorationStageResult` ready to journal. Deterministic:
 * same context + options -> byte-identical mesh + hash.
 *
 * @throws {MissingMarginLoopError} if `tooth` has no margin loop in the context.
 * @throws {MissingClinicalParamError} if a required gap/spacer param is
 * missing/non-finite.
 * @throws propagates `innerSurfaceOffsetRoi`'s typed errors (pitch/gap/blend
 * validation, non-watertight target, empty offset, grid-too-large).
 */
export async function runInnerSurfaceStage(
  context: PipelineContext,
  tooth: FdiTooth,
  options: InnerSurfaceStageOptions,
): Promise<RestorationStageResult> {
  assertCrownContext(context); // crown-only stage — Phase 5 Task 1 guard rail
  const marginLoopInput = context.marginLoops[tooth];
  if (!marginLoopInput) {
    throw new MissingMarginLoopError(tooth);
  }
  // Dedup + CHORD-CAP validation (margin/band.ts): consumes resampledPoints
  // ONLY, never anchor chords — the dense, on-surface currency.
  const loop = marginLoopPolyline({ closed: marginLoopInput.closed, resampledPoints: marginLoopInput.resampledPoints });

  const rp = context.materialProfile.restorationParams;
  assertFiniteParam('marginalGapMm', rp.marginalGapMm);
  assertFiniteParam('cementGapMm', rp.cementGapMm);
  assertFiniteParam('spacerStartMm', rp.spacerStartMm);
  // NOTE on `undercutBlockoutThresholdMm` (profile): this task's SOLID blockout
  // always does a FULL draft-close (fills ALL undercut, i.e. threshold-0
  // semantics), so the profile threshold does not influence the output. It is
  // therefore DELIBERATELY NOT journaled as an op param here — journaling a
  // clinical value the op ignored would be a false audit record. Honouring a
  // RETENTIVE (nonzero) threshold (leaving shallow undercut for retention) is
  // future work; when added, it must be wired to the kernel op AND journaled.

  const blendWidthMm = options.blendWidthMm ?? INNER_SURFACE_DEFAULT_BLEND_WIDTH_MM;

  // ONE op: two-zone offset + solid undercut blockout + skirt-to-margin. The
  // finished intaglio's boundary loop == the margin polyline (the marginal
  // seal); the marginFitGate re-measures that coincidence.
  const result = await buildInnerSurface(context.targetMesh.mesh, {
    marginalGapMm: rp.marginalGapMm,
    cementGapMm: rp.cementGapMm,
    spacerStartMm: rp.spacerStartMm,
    blendWidthMm,
    pitchMm: options.pitchMm,
    marginLoop: loop,
    insertionAxis: context.insertionAxis,
  });

  const meshContentHash = options.hashMesh(result.mesh);

  return {
    stage: 'innerSurface',
    mesh: result.mesh,
    meshContentHash,
    operationName: 'innerSurface.build',
    params: {
      tooth,
      pitchMm: options.pitchMm,
      marginalGapMm: rp.marginalGapMm,
      cementGapMm: rp.cementGapMm,
      spacerStartMm: rp.spacerStartMm,
      blendWidthMm,
      insertionAxis: context.insertionAxis,
      marginLoopPointCount: loop.length,
      patchTriangleCount: result.patchTriangleCount,
      skirtTriangleCount: result.skirtTriangleCount,
      marginVertexCount: result.marginVertexCount,
      errorBoundMm: result.errorBoundMm,
      flatZoneErrorBoundMm: result.flatZoneErrorBoundMm,
    },
    inputHashes: [context.targetMesh.contentHash],
    errorBoundMm: result.errorBoundMm,
  };
}
