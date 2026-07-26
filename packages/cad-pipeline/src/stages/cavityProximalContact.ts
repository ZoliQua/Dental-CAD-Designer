// packages/cad-pipeline/src/stages/cavityProximalContact.ts
//
// Phase 5 Task 5: the CAVITY PROXIMAL-CONTACT stage — Class II box contact
// adaptation. Orchestrates the kernel's `adaptProximalContacts` (the per-box
// bump adaptation of the Task-4 occlusal patch's proximal faces toward the
// neighbouring teeth — see @dqcad/kernel's cavity/proximalContact.ts for the
// mechanism, the pinned anchor set, and `@errorBound`) into ONE journalable
// `RestorationStageResult`, and RE-MEASURES the seam dihedral AFTER the
// adaptation (the Task-4 G1 instrument) so the journal carries before/after
// evidence that the G1 seam survived.
//
// ## Clinical target comes from the profile via the context — asserted loudly
//
// `proximalContactPenetrationMm` is read from
// `context.materialProfile.restorationParams` (CLAUDE.md invariant 7 — NEVER
// hardcoded here); missing/non-finite → `CavityProximalContactMissingClinical-
// ParamError`.
//
// ## FDI neighbours pair to patch faces GEOMETRICALLY
//
// `identifyNeighbors` (the P4 placement/morphing stage utility, reused) gives
// the mesial/distal FDI split; each of the patch's two proximal faces then
// pairs with the neighbour whose surface is CLOSEST to the face centroid
// (deterministic; kernel closest-point). Both faces resolving to the SAME
// neighbour is a typed `AmbiguousProximalPairingError` (a mis-assembled
// context, e.g. both neighbour meshes on one side) — never a silent
// wrong-side contact.
//
// ## @errorBound
//
// Carried from the kernel op: max over boxes of max(contactResidualMm,
// faceResidualMm) — the GENUINE measured achieved-vs-target deviation
// (closest-point vs the neighbour mesh, never a prescription re-read);
// conservative for a clamped (unreachable) target or a pinned rim penetrated
// by a too-close neighbour. Clamped boxes are journaled
// (`contactClampWarning` — the P4 pattern), never a silent success.
import type { FdiTooth } from '@dqcad/shared-types';
import {
  adaptProximalContacts,
  buildBvh,
  closestPoint,
  measureSeamDihedral,
  type IndexedMesh,
  type ProximalAdaptationInput,
  type ProximalFaceBoundary,
  type SeamEdge,
  type Vec3,
} from '@dqcad/kernel';
import type { PipelineContext, PipelineMeshHandle } from '../pipeline/context.ts';
import { assertCavityContext } from '../pipeline/context.ts';
import type { RestorationStageResult } from '../pipeline/stageResult.ts';
import { identifyNeighbors, InsufficientNeighborsError } from './anatomyPlacement.ts';

/** Thrown when a required clinical param is missing/non-finite on the context
 * profile. Explicit field + body assignment (NOT a TS constructor parameter
 * property — this file is in the Node worker's strip-only-TS import closure). */
export class CavityProximalContactMissingClinicalParamError extends Error {
  readonly paramName: string;
  constructor(paramName: string, value: unknown) {
    super(
      `cavityProximalContact stage: required clinical param "${paramName}" is missing or non-finite (got ${String(value)}) — ` +
        `it must be resolved from the material profile onto context.materialProfile.restorationParams`,
    );
    this.name = 'CavityProximalContactMissingClinicalParamError';
    this.paramName = paramName;
  }
}

/** Both proximal faces resolved to the SAME neighbour (mis-assembled context:
 * e.g. both neighbour meshes on one side of the tooth) — never silently adapt
 * both boxes toward one neighbour. */
export class AmbiguousProximalPairingError extends Error {
  readonly neighborFdi: FdiTooth;
  constructor(neighborFdi: FdiTooth) {
    super(
      `cavityProximalContact stage: BOTH proximal faces are geometrically closest to neighbour ${neighborFdi} — ` +
        `the two neighbours must flank the tooth (one per proximal face); check the context's neighbour meshes`,
    );
    this.name = 'AmbiguousProximalPairingError';
    this.neighborFdi = neighborFdi;
  }
}

export interface CavityProximalContactStageOptions {
  /** The Task-4 occlusal patch (its stage output) — the mesh being adapted. */
  readonly patchMesh: PipelineMeshHandle;
  /** The patch's two proximal faces (`CavityOcclusalPatchStageResult.proximalFaces`). */
  readonly proximalFaces: readonly [ProximalFaceBoundary, ProximalFaceBoundary];
  /** The patch's occlusal seam edges — re-measured AFTER adaptation. */
  readonly seamEdges: readonly SeamEdge[];
  /** Cavity-surface triangle exclusion for the seam measurement. */
  readonly cavityTriangleIndices: Uint32Array;
  /** Kernel ALGORITHM overrides (journaled) — see kernel defaults. */
  readonly maxTravelMm?: number;
  readonly seamAnchorBandMm?: number;
  /** Content-hash function for the adapted mesh — injected by the caller
   * (hashing lives one layer up; the established stage split). */
  readonly hashMesh: (mesh: IndexedMesh) => string;
}

/** Per-box journal params — measured evidence (the contact-gate inputs). */
export interface CavityProximalContactBoxParams {
  readonly side: 'mesial' | 'distal';
  readonly neighborFdi: FdiTooth;
  readonly targetPenetrationMm: number;
  readonly initialSignedDistanceMm: number;
  readonly travelMm: number;
  readonly clampBound: boolean;
  readonly achievedSignedDistanceMm: number;
  readonly contactResidualMm: number;
  readonly faceMinSignedDistanceMm: number;
  readonly faceResidualMm: number;
  readonly movedVertexCount: number;
}

export interface CavityProximalContactStageResult extends RestorationStageResult {
  /** Per-box measured results (also journaled in `params.boxes`). */
  readonly boxes: readonly CavityProximalContactBoxParams[];
  /** Seam G1 evidence: max dihedral BEFORE and AFTER the adaptation (deg). */
  readonly seamDihedralMaxBeforeDeg: number;
  readonly seamDihedralMaxAfterDeg: number;
  /** Sides whose travel was clamped (target unreachable) — QC warning. */
  readonly clampedBoxes: readonly ('mesial' | 'distal')[];
}

function faceCentroid(face: ProximalFaceBoundary): Vec3 {
  let x = 0, y = 0, z = 0, n = 0;
  for (const p of [...face.columnPoints, ...face.freeRunPoints]) {
    x += p[0]; y += p[1]; z += p[2]; n++;
  }
  return [x / n, y / n, z / n];
}

/**
 * Runs the proximal box contact-adaptation stage for `tooth` — see this
 * module's doc. Pure function of `(context, tooth, options)`; deterministic
 * (same inputs → byte-identical adapted mesh + hash). Returns the adapted
 * patch + per-box measured residuals + seam before/after evidence, ready to
 * journal as ONE operation.
 *
 * @throws {RestorationTypeMismatchError} if `context` is not an inlay/onlay case.
 * @throws {InsufficientNeighborsError} without exactly two neighbours.
 * @throws {CavityProximalContactMissingClinicalParamError} missing target.
 * @throws {AmbiguousProximalPairingError} both faces map to one neighbour.
 * @throws propagates the kernel's typed errors (`ProximalColumnNotOnPatchError`,
 * `ProximalNeighborMeshError`, `ProximalBandTooWideError`, ...).
 */
export function runCavityProximalContactStage(
  context: PipelineContext,
  tooth: FdiTooth,
  options: CavityProximalContactStageOptions,
): CavityProximalContactStageResult {
  assertCavityContext(context); // inlay/onlay-only stage — Phase 5 Task 1 guard rail

  const targetPenetrationMm = context.materialProfile.restorationParams.proximalContactPenetrationMm;
  if (!Number.isFinite(targetPenetrationMm)) {
    throw new CavityProximalContactMissingClinicalParamError('proximalContactPenetrationMm', targetPenetrationMm);
  }

  const { mesial, distal } = identifyNeighbors(tooth, context.neighbors);
  const mesialHandle = context.neighbors[mesial];
  const distalHandle = context.neighbors[distal];
  if (!mesialHandle || !distalHandle) {
    throw new InsufficientNeighborsError(tooth, [mesialHandle, distalHandle].filter(Boolean).length);
  }

  // Geometric face ↔ neighbour pairing (deterministic; see module doc).
  const mesialBvh = buildBvh(mesialHandle.mesh);
  const distalBvh = buildBvh(distalHandle.mesh);
  const nearest = (face: ProximalFaceBoundary): 'mesial' | 'distal' => {
    const c = faceCentroid(face);
    const dm = closestPoint(mesialHandle.mesh, mesialBvh, c).distance;
    const dd = closestPoint(distalHandle.mesh, distalBvh, c).distance;
    return dm <= dd ? 'mesial' : 'distal';
  };
  const side0 = nearest(options.proximalFaces[0]);
  const side1 = nearest(options.proximalFaces[1]);
  if (side0 === side1) {
    throw new AmbiguousProximalPairingError(side0 === 'mesial' ? mesial : distal);
  }
  const mesialFace = side0 === 'mesial' ? options.proximalFaces[0] : options.proximalFaces[1];
  const distalFace = side0 === 'mesial' ? options.proximalFaces[1] : options.proximalFaces[0];

  // Seam dihedral BEFORE (the Task-4 value, re-derived on this exact input).
  const seamBefore = measureSeamDihedral(options.patchMesh.mesh, context.targetMesh.mesh, options.seamEdges, {
    excludeToothTriangles: new Set(options.cavityTriangleIndices),
  });

  // ONE op: the per-box adaptation, mesial then distal (deterministic order).
  const adaptations: ProximalAdaptationInput[] = [
    { label: 'mesial', columnPoints: mesialFace.columnPoints, freeRunPoints: mesialFace.freeRunPoints, neighborMesh: mesialHandle.mesh, targetPenetrationMm },
    { label: 'distal', columnPoints: distalFace.columnPoints, freeRunPoints: distalFace.freeRunPoints, neighborMesh: distalHandle.mesh, targetPenetrationMm },
  ];
  const kernelOptions = {
    ...(options.maxTravelMm !== undefined ? { maxTravelMm: options.maxTravelMm } : {}),
    ...(options.seamAnchorBandMm !== undefined ? { seamAnchorBandMm: options.seamAnchorBandMm } : {}),
  };
  const result = adaptProximalContacts(options.patchMesh.mesh, adaptations, kernelOptions);

  // Seam dihedral AFTER — the G1-survival evidence (the hard invariant's
  // genuine re-measurement, not an assumption about the pinned band).
  const seamAfter = measureSeamDihedral(result.mesh, context.targetMesh.mesh, options.seamEdges, {
    excludeToothTriangles: new Set(options.cavityTriangleIndices),
  });

  const boxes: CavityProximalContactBoxParams[] = result.boxes.map((b, i) => ({
    side: b.label as 'mesial' | 'distal',
    neighborFdi: i === 0 ? mesial : distal,
    targetPenetrationMm: b.targetPenetrationMm,
    initialSignedDistanceMm: b.initialSignedDistanceMm,
    travelMm: b.travelMm,
    clampBound: b.clampBound,
    achievedSignedDistanceMm: b.achievedSignedDistanceMm,
    contactResidualMm: b.contactResidualMm,
    faceMinSignedDistanceMm: b.faceMinSignedDistanceMm,
    faceResidualMm: b.faceResidualMm,
    movedVertexCount: b.movedVertexCount,
  }));
  const clampedBoxes = result.clampedBoxes as ('mesial' | 'distal')[];
  const meshContentHash = options.hashMesh(result.mesh);

  return {
    stage: 'morphing',
    mesh: result.mesh,
    meshContentHash,
    operationName: 'cavityProximalContact.adapt',
    params: {
      tooth,
      restorationType: context.restorationType,
      proximalContactPenetrationMm: targetPenetrationMm,
      mesialNeighborFdi: mesial,
      distalNeighborFdi: distal,
      // ALGORITHM parameters actually used (kernel echo — replay currency).
      maxTravelMm: result.maxTravelMm,
      seamAnchorBandMm: result.seamAnchorBandMm,
      // Measured evidence (residuals REPORTED — the contact-gate inputs).
      boxes,
      maxContactResidualMm: boxes.reduce((m, b) => Math.max(m, b.contactResidualMm), 0),
      // QC WARNING: boxes whose target was NOT achieved (travel clamped) —
      // never a silent success downstream (the P4 contactClampWarning pattern).
      clampedBoxes,
      contactClampWarning: clampedBoxes.length > 0,
      // Seam G1 before/after — the survival evidence.
      seamDihedralMaxBeforeDeg: seamBefore.maxDeg,
      seamDihedralMeanBeforeDeg: seamBefore.meanDeg,
      seamDihedralMaxAfterDeg: seamAfter.maxDeg,
      seamDihedralMeanAfterDeg: seamAfter.meanDeg,
      seamEdgeCount: options.seamEdges.length,
    },
    inputHashes: [options.patchMesh.contentHash, mesialHandle.contentHash, distalHandle.contentHash],
    // Conservative @errorBound from the kernel: max over boxes of
    // max(contactResidual, faceResidual) — genuine measured deviation.
    errorBoundMm: result.errorBoundMm,
    boxes,
    seamDihedralMaxBeforeDeg: seamBefore.maxDeg,
    seamDihedralMaxAfterDeg: seamAfter.maxDeg,
    clampedBoxes,
  };
}
