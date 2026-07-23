// packages/cad-pipeline/src/stages/anatomyPlacement.ts
//
// Phase 4 Task 5: the ANATOMY-PLACEMENT stage — the SECOND crown-design stage
// (docs/plans/phase-4-crown-design.md's 6 fixed-order stages). It orchestrates
// the kernel's deterministic placement solve (`@dqcad/kernel`'s
// `solveAnatomyPlacement` → `buildPlacementTransform` → `placeMesh`) into a
// journalable `RestorationStageResult`: the kernel does the transform math (see
// `anatomy/placement.ts`'s module doc for the frame construction, the two scale
// factors and the Kabsch-based alignment), the stage identifies the mesial vs
// distal neighbour (an FDI-numbering decision — NOT geometry), decomposes the
// library tooth asset into the plain geometry the kernel op consumes, applies
// any manual override, and packages the placed mesh + transform + journal
// fields.
//
// ## Why the tooth asset arrives as DATA, not an `@dqcad/tooth-library` import
//
// The layer rule (eslint boundaries) allows `cad-pipeline -> kernel, io,
// shared-types` — NOT `-> tooth-library`. So the library tooth (mesh +
// landmarks + canonical frame) arrives as a plain `PipelineToothAsset` value,
// assembled by a caller one layer up (the engine/worker job that already loaded
// it via `@dqcad/tooth-library`'s `loadToothAssetInProcess`). This is the SAME
// "duplicate the shape rather than cross a forbidden boundary" precedent as
// `PipelineMaterialProfile` (context.ts) mirroring `MaterialProfile`.
//
// ## Mesial vs distal neighbour (FDI numbering, not geometry)
//
// `context.neighbors` is keyed by FDI. Which key is the mesial neighbour and
// which is the distal one is a tooth-numbering fact: the distal neighbour is
// the one FARTHER from the midline (greater position-within-quadrant, `fdi %
// 10`). The kernel solve then orients its mesial-distal axis from the
// mesial→distal centroid line. Placement needs EXACTLY two neighbours (a
// bounded M-D line); fewer is this stage's gate (`InsufficientNeighborsError`),
// like a missing antagonist is the occlusal stages' gate.
//
// Placement introduces NO geometric approximation (it is an exact affine map of
// exact inputs — a deterministic initial-pose heuristic refined by the later
// morphing stage), so `errorBoundMm` is `null`.
import type { FdiTooth, Vec3 } from '@dqcad/shared-types';
import {
  buildPlacementTransform,
  marginLoopPolyline,
  placeMesh,
  rescalePlacement,
  solveAnatomyPlacement,
  solveLandmarkHandleTranslation,
  translatePlacement,
  type CanonicalFrameAxes,
  type IndexedMesh,
  type PlacementFrame,
} from '@dqcad/kernel';
import type { PipelineContext, PipelineMeshHandle } from '../pipeline/context.ts';
import type { RestorationStageResult } from '../pipeline/stageResult.ts';

/** A library tooth asset, as the plain data this stage consumes — structurally
 * mirrors `@dqcad/tooth-library`'s `ToothAsset` (see this module's doc for why
 * it is duplicated, not imported). Only the fields the placement solve needs. */
export interface PipelineToothAsset {
  /** Content hash of `mesh` (the tooth-library asset's `meshChecksum`) — for
   * journal `inputHashes`. */
  readonly contentHash: string;
  /** The watertight library mesh, in the asset's own canonical coordinate
   * space. Immutable — `placeMesh` transforms a COPY. */
  readonly mesh: IndexedMesh;
  /** Named landmark points (asset-space) — handles map to these by name. */
  readonly landmarks: Readonly<Record<string, Vec3>>;
  /** The asset's canonical local frame (origin + orthonormal axes). */
  readonly canonicalFrame: CanonicalFrameAxes;
}

/** A declarative, journalable manual override applied on top of the auto
 * placement — position / scale / anatomical-handle, deterministic and applied
 * in a fixed order (handle → translate → rescale). Omit for pure
 * auto-placement. */
export interface AnatomyPlacementManualOverride {
  /** Pin the named library landmark to a world target (re-solves to a pure
   * translation that lands it exactly). */
  readonly landmarkHandle?: { readonly landmark: string; readonly targetMm: Vec3 };
  /** Additional world-space translation of the whole placement. */
  readonly translationMm?: Vec3;
  /** Multiply the anisotropic scale factors (M-D / B-L / O-G). */
  readonly scale?: { readonly md?: number; readonly bl?: number; readonly og?: number };
}

export interface AnatomyPlacementStageOptions {
  /** The library tooth asset (loaded by the caller — see this module's doc). */
  readonly asset: PipelineToothAsset;
  /** Content-hash function for the placed mesh — injected by the caller
   * (hashing lives one layer up; same split as `innerSurface`). Deterministic. */
  readonly hashMesh: (mesh: IndexedMesh) => string;
  /** Optional manual override; omit for auto-placement. */
  readonly manualOverride?: AnatomyPlacementManualOverride;
}

/** Thrown when the site does not have exactly two adjacent neighbour meshes in
 * the context — the mesial-distal axis is under-determined without both. */
export class InsufficientNeighborsError extends Error {
  constructor(tooth: FdiTooth, found: number) {
    super(
      `anatomyPlacement stage: tooth ${tooth} needs exactly 2 neighbours (mesial + distal) in ` +
        `context.neighbors to derive the mesial-distal axis, found ${found}`,
    );
    this.name = 'InsufficientNeighborsError';
  }
}

/** Thrown when the requested tooth has no confirmed margin loop in the context
 * — placement's target origin is the margin centroid. */
export class MissingMarginLoopError extends Error {
  constructor(tooth: FdiTooth) {
    super(`anatomyPlacement stage: no margin loop for tooth ${tooth} in context.marginLoops — a confirmed margin is required`);
    this.name = 'MissingMarginLoopError';
  }
}

/** Thrown when a manual landmark-handle names a landmark absent from the asset. */
export class UnknownLandmarkError extends Error {
  constructor(landmark: string) {
    super(`anatomyPlacement stage: manual handle references unknown landmark "${landmark}" (not in asset.landmarks)`);
    this.name = 'UnknownLandmarkError';
  }
}

/** Position within the quadrant (1 = most mesial / nearest midline, 8 = most
 * distal) — the distance-from-midline that orders neighbours. */
function positionFromMidline(fdi: FdiTooth): number {
  return fdi % 10;
}

/**
 * Identify the mesial and distal neighbour FDIs among the context's neighbours
 * for `tooth`: the distal neighbour is FARTHER from the midline (greater
 * `fdi % 10`); a tie (never occurs for a genuine mesial+distal pair) is broken
 * deterministically by the larger FDI number.
 */
export function identifyNeighbors(
  tooth: FdiTooth,
  neighbors: Partial<Record<FdiTooth, PipelineMeshHandle>>,
): { mesial: FdiTooth; distal: FdiTooth } {
  const fdis = (Object.keys(neighbors) as unknown[])
    .map((k) => Number(k) as FdiTooth)
    .filter((fdi) => neighbors[fdi] !== undefined);
  if (fdis.length !== 2) {
    throw new InsufficientNeighborsError(tooth, fdis.length);
  }
  const [a, b] = fdis as [FdiTooth, FdiTooth];
  const pa = positionFromMidline(a);
  const pb = positionFromMidline(b);
  let distal: FdiTooth;
  let mesial: FdiTooth;
  if (pa === pb) {
    distal = a > b ? a : b;
    mesial = a > b ? b : a;
  } else if (pa > pb) {
    distal = a;
    mesial = b;
  } else {
    distal = b;
    mesial = a;
  }
  return { mesial, distal };
}

/**
 * Runs the anatomy-placement stage for `tooth` — see this module's doc.
 * Deterministic: same context + asset + options → byte-identical placed mesh +
 * hash. Returns the placed (transformed) library mesh + the 4×4 transform
 * (journaled in `params.transform`).
 *
 * @throws {MissingMarginLoopError} if `tooth` has no margin loop in the context.
 * @throws {InsufficientNeighborsError} if the site lacks exactly two neighbours.
 * @throws {UnknownLandmarkError} if a manual handle names an unknown landmark.
 * @throws propagates `solveAnatomyPlacement`'s `DegeneratePlacementError`.
 */
export function runAnatomyPlacementStage(
  context: PipelineContext,
  tooth: FdiTooth,
  options: AnatomyPlacementStageOptions,
): RestorationStageResult {
  const marginInput = context.marginLoops[tooth];
  if (!marginInput) {
    throw new MissingMarginLoopError(tooth);
  }
  const marginLoop = marginLoopPolyline({ closed: marginInput.closed, resampledPoints: marginInput.resampledPoints });

  const { mesial, distal } = identifyNeighbors(tooth, context.neighbors);
  const mesialHandle = context.neighbors[mesial];
  const distalHandle = context.neighbors[distal];
  if (!mesialHandle || !distalHandle) {
    // Unreachable — identifyNeighbors already guaranteed exactly two present
    // keys — but narrows the types AND reports the RESTORATION tooth (not a
    // neighbour FDI) if a future refactor ever breaks that invariant.
    throw new InsufficientNeighborsError(tooth, [mesialHandle, distalHandle].filter(Boolean).length);
  }

  const { asset } = options;
  const solution = solveAnatomyPlacement({
    canonicalFrame: asset.canonicalFrame,
    libraryMesh: asset.mesh,
    marginLoop,
    insertionAxis: context.insertionAxis,
    mesialNeighborPositions: mesialHandle.mesh.positions,
    distalNeighborPositions: distalHandle.mesh.positions,
    antagonistPositions: context.antagonist ? context.antagonist.mesh.positions : null,
  });

  // Manual override (fixed order: handle → translate → rescale) — each step is
  // a pure PlacementFrame transform re-solved into the final matrix below.
  let frame: PlacementFrame = solution.frame;
  const override = options.manualOverride;
  if (override?.landmarkHandle) {
    const landmarkPoint = asset.landmarks[override.landmarkHandle.landmark];
    if (!landmarkPoint) throw new UnknownLandmarkError(override.landmarkHandle.landmark);
    frame = solveLandmarkHandleTranslation(frame, asset.canonicalFrame, landmarkPoint, override.landmarkHandle.targetMm);
  }
  if (override?.translationMm) {
    frame = translatePlacement(frame, override.translationMm);
  }
  if (override?.scale) {
    frame = rescalePlacement(frame, override.scale);
  }

  const transform = buildPlacementTransform(frame, asset.canonicalFrame);
  const placed = placeMesh(asset.mesh, transform);
  const meshContentHash = options.hashMesh(placed);

  const inputHashes = [asset.contentHash, mesialHandle.contentHash, distalHandle.contentHash];
  if (context.antagonist) inputHashes.push(context.antagonist.contentHash);

  return {
    stage: 'anatomyPlacement',
    mesh: placed,
    meshContentHash,
    operationName: 'anatomyPlacement.place',
    params: {
      tooth,
      mesialNeighborFdi: mesial,
      distalNeighborFdi: distal,
      insertionAxis: context.insertionAxis,
      antagonistPresent: context.antagonist !== null,
      // The solved transform + frame + measurements — replaying with these
      // reproduces `meshContentHash` bit-identically.
      transform,
      originMm: frame.originMm,
      mesialDistalAxis: frame.mesialDistal,
      buccoLingualAxis: frame.buccoLingual,
      occlusoGingivalAxis: frame.occlusoGingival,
      scaleMesialDistal: frame.scaleMesialDistal,
      scaleBuccoLingual: frame.scaleBuccoLingual,
      scaleOcclusoGingival: frame.scaleOcclusoGingival,
      nativeMesialDistalWidthMm: solution.measurements.nativeMesialDistalWidthMm,
      nativeOcclusoGingivalHeightMm: solution.measurements.nativeOcclusoGingivalHeightMm,
      targetMesialDistalWidthMm: solution.measurements.targetMesialDistalWidthMm,
      targetOcclusoGingivalHeightMm: solution.measurements.targetOcclusoGingivalHeightMm,
      usedProximalGap: solution.measurements.usedProximalGap,
      antagonistUsed: solution.measurements.antagonistUsed,
      occlusoGingivalReoriented: solution.measurements.occlusoGingivalReoriented,
      manualOverride: override ?? null,
    },
    inputHashes,
    errorBoundMm: null,
  };
}
