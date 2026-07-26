// packages/cad-pipeline/src/stages/cavityOcclusalPatch.ts
//
// Phase 5 Task 4: the CAVITY OCCLUSAL-PATCH stage — the inlay/onlay OUTER
// surface. It orchestrates the kernel's occlusal anatomy patch
// (`@dqcad/kernel`'s `buildOcclusalPatch`: the cubic-Hermite G1 blend over the
// cavity opening, boundary bit-exact on the cavity outline, G1-continuous into
// the surrounding tooth along the occlusal seam) into a `RestorationStageResult`
// the caller journals, and measures + surfaces the G1 acceptance (max seam
// dihedral < 5°) via the kernel `measureSeamDihedral` instrument.
//
// ## Restoration-type guard rail (Phase 5 Task 1 scaffold)
//
// Calls `assertCavityContext(context)` at entry: runs for an INLAY or ONLAY case
// and throws `RestorationTypeMismatchError` for a crown/bridge (the crown-only
// guard does NOT fire here; the cavity guard DOES). Inlay and onlay share this
// ONE stage unchanged for the standard-outline patch; the onlay cusp-coverage
// EXTENDED outline is Phase 5 Task 7's scope (the outline updates there; this
// stage then runs on the extended outline with no change).
//
// ## The cavity OUTLINE is the shared margin currency (bit-exact ring)
//
// The patch boundary is built to be EXACTLY the dedup'd cavity outline — the
// SAME ring the Task-3 fit surface skirts to — so Task 6 can stitch them into
// the shell. It arrives on `context.marginLoops[tooth].resampledPoints`
// (CHORD-CAP: the dense on-surface polyline, never anchor chords).
//
// ## No approximation error in mm; the bound is a seam DIHEDRAL (deg)
//
// `errorBoundMm` is `0`: the patch boundary lies EXACTLY on the outline (no mm
// offset target is approximated — the patch is a constructed anatomy surface,
// not an offset). The relevant approximation is the seam-dihedral discretization
// residual (deg), journaled in `params.seamDihedralBoundDeg` and MEASURED in
// `params.seamDihedralMaxDeg` (the G1 acceptance evidence). No clinical param is
// read (anatomy cross-segment count is a documented ALGORITHM param, not a
// profile value — CLAUDE.md invariant 7).
import type { FdiTooth } from '@dqcad/shared-types';
import {
  buildOcclusalPatch,
  measureSeamDihedral,
  marginLoopPolyline,
  DEFAULT_PATCH_CROSS_SEGMENTS,
  type IndexedMesh,
  type ProximalFaceBoundary,
  type SeamEdge,
} from '@dqcad/kernel';
import type { PipelineContext } from '../pipeline/context.ts';
import { assertCavityContext } from '../pipeline/context.ts';
import type { RestorationStageResult } from '../pipeline/stageResult.ts';

/** Thrown when the cavity outline for the requested tooth is absent from the
 * context — the occlusal patch is defined relative to a confirmed cavity
 * outline; there is nothing to cap without one. Explicit field + body
 * assignment (NOT a TS constructor parameter property — the Task 1 worker-loader
 * landmine; this file is in the Node worker's strip-only-TS import closure). */
export class MissingCavityOutlineError extends Error {
  readonly tooth: FdiTooth;
  constructor(tooth: FdiTooth) {
    super(`cavityOcclusalPatch stage: no cavity outline for tooth ${tooth} in context.marginLoops — a confirmed cavity outline is required`);
    this.name = 'MissingCavityOutlineError';
    this.tooth = tooth;
  }
}

export interface CavityOcclusalPatchStageOptions {
  /** Buccolingual cross-sweep segments per station — default
   * `DEFAULT_PATCH_CROSS_SEGMENTS` (kernel ALGORITHM default; NOT clinical). */
  readonly crossSegments?: number;
  /** Content-hash function for the produced mesh — injected by the caller
   * (hashing lives one layer up; see stageResult.ts). Deterministic. */
  readonly hashMesh: (mesh: IndexedMesh) => string;
}

export interface CavityOcclusalPatchStageResult extends RestorationStageResult {
  /** The occlusal SEAM edges (for the downstream seam-dihedral gate / Task 6). */
  readonly seamEdges: readonly SeamEdge[];
  /** The proximal FREE (break-through) edges — reported, never in the gate value. */
  readonly freeEdges: readonly SeamEdge[];
  /** Cavity-surface triangle indices to exclude when the gate disambiguates the
   * surrounding triangle across a seam edge. */
  readonly cavityTriangleIndices: Uint32Array;
  /** Measured max seam dihedral (deg) — the G1 acceptance value. */
  readonly seamDihedralMaxDeg: number;
  /** The two proximal break-through faces — the Task-5 box-contact-adaptation
   * currency (see kernel `ProximalFaceBoundary`). */
  readonly proximalFaces: readonly [ProximalFaceBoundary, ProximalFaceBoundary];
}

/**
 * Runs the cavity occlusal-patch stage for `tooth` — see this file's module doc.
 * Pure function of `(context, tooth, options)`; returns the finished occlusal
 * patch as a `CavityOcclusalPatchStageResult` (a `RestorationStageResult` plus
 * the seam/free edge sets + the measured G1 value) ready to journal.
 * Deterministic: same context + options → byte-identical mesh + hash.
 *
 * @throws {RestorationTypeMismatchError} if `context` is not an inlay/onlay case.
 * @throws {MissingCavityOutlineError} if `tooth` has no outline in the context.
 * @throws propagates `buildOcclusalPatch`'s typed errors (axis/outline
 * validation, non-MOD outline, outline not an on-mesh edge ring).
 */
export function runCavityOcclusalPatchStage(
  context: PipelineContext,
  tooth: FdiTooth,
  options: CavityOcclusalPatchStageOptions,
): CavityOcclusalPatchStageResult {
  assertCavityContext(context); // inlay/onlay-only stage — Phase 5 Task 1 guard rail
  const outlineInput = context.marginLoops[tooth];
  if (!outlineInput) {
    throw new MissingCavityOutlineError(tooth);
  }
  const outline = marginLoopPolyline({ closed: outlineInput.closed, resampledPoints: outlineInput.resampledPoints });
  const crossSegments = options.crossSegments ?? DEFAULT_PATCH_CROSS_SEGMENTS;

  // ONE op: the occlusal anatomy patch + G1 seam blend.
  const patch = buildOcclusalPatch(context.targetMesh.mesh, outline, context.insertionAxis, { crossSegments });

  // Measure the G1 acceptance (seam ONLY; free segments excluded by construction).
  const m = measureSeamDihedral(patch.mesh, context.targetMesh.mesh, patch.seamEdges, {
    excludeToothTriangles: new Set(patch.cavityTriangleIndices),
  });

  const meshContentHash = options.hashMesh(patch.mesh);

  return {
    stage: 'anatomyPlacement',
    mesh: patch.mesh,
    meshContentHash,
    operationName: 'cavityOcclusalPatch.build',
    params: {
      tooth,
      restorationType: context.restorationType,
      crossSegments,
      seamSurroundingMaxAngleDeg: patch.seamSurroundingMaxAngleDeg,
      insertionAxis: context.insertionAxis,
      outlinePointCount: outline.length,
      seamEdgeCount: patch.seamEdges.length,
      freeEdgeCount: patch.freeEdges.length,
      patchTriangleCount: patch.patchTriangleCount,
      seamDihedralBoundDeg: patch.seamDihedralBoundDeg,
      seamDihedralMaxDeg: m.maxDeg,
      seamDihedralMeanDeg: m.meanDeg,
    },
    inputHashes: [context.targetMesh.contentHash],
    errorBoundMm: 0, // boundary is bit-exact on the outline; the seam residual is a dihedral (deg), journaled above
    seamEdges: patch.seamEdges,
    freeEdges: patch.freeEdges,
    cavityTriangleIndices: patch.cavityTriangleIndices,
    seamDihedralMaxDeg: m.maxDeg,
    proximalFaces: patch.proximalFaces,
  };
}
