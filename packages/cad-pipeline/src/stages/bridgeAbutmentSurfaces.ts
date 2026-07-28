// packages/cad-pipeline/src/stages/bridgeAbutmentSurfaces.ts
//
// Phase 6 Task 2: the BRIDGE abutment fit-surfaces stage — the multi-unit
// analogue of the crown `runInnerSurfaceStage` (stages/innerSurface.ts). A
// bridge seats as ONE rigid piece along ONE SHARED insertion axis, so EVERY
// abutment's intaglio is built against `context.insertionAxis` (the confirmed
// shared axis — NOT each die's own axis). The kernel op is the SAME P4
// `buildInnerSurface` a crown uses (a bridge abutment's fit surface IS a crown
// fit surface); the only bridge-specific choice is the axis, which is shared.
//
// ## Guard rail (Phase 5 Task 1 pattern)
//
// `assertBridgeContext` at entry — this stage runs ONLY on a bridge context
// (bridge guards fire; the crown/cavity guards would reject a bridge, and this
// bridge guard rejects a crown/cavity). It also narrows to `BridgePipelineContext`
// so `ponticSites` is present (used to exclude pontic sites from the abutment
// set).
//
// ## Abutments = the margin-bearing units (pontic sites excluded)
//
// The abutment teeth are the keys of `context.marginLoops` (a prep has a
// confirmed margin; a pontic does not) MINUS any `ponticSites` entry (defensive
// — a pontic never carries a margin loop, but excluding explicitly makes the
// intent auditable). Processed in ascending FDI order for determinism.
//
// ## Journaling: ONE multi-unit op (decided + documented)
//
// A bridge is designed as ONE coupled unit — the shared axis is what MAKES it a
// bridge (every abutment's blockout is draft-closed to the SAME direction). So
// this stage emits ONE journaled operation (`bridge.abutmentSurfaces`) whose
// `params` carry the shared axis + every abutment's sub-params, and whose
// `outputHashes` list every abutment mesh hash in abutment order. Replaying it
// rebuilds ALL abutments deterministically from those params → identical output
// hashes (the reproducibility invariant). One-op-per-abutment was the
// alternative; it would fragment the shared-axis coupling across independent
// entries and lose the "these surfaces were built together, under one axis"
// audit fact — so the multi-unit op is the honest record.
//
// The per-abutment margin-fit gate (≤10 µm — the acceptance) is NOT run here:
// like the crown stage, gates live in the QC report assemblers / the caller
// (gates/marginFit.ts's `marginFitGate`), which re-measure the coincidence from
// the finished mesh. This stage produces the geometry + the journal record.
import type { FdiTooth, Vec3 } from '@dqcad/shared-types';
import { buildInnerSurface, marginLoopPolyline, INNER_SURFACE_DEFAULT_BLEND_WIDTH_MM, type IndexedMesh } from '@dqcad/kernel';
import type { BridgePipelineContext } from '../pipeline/context.ts';
import { assertBridgeContext } from '../pipeline/context.ts';

/** Thrown when a bridge context carries no abutment margin loops — a bridge
 * needs at least one prepped abutment to build a fit surface for. */
export class NoAbutmentMarginsError extends Error {
  constructor() {
    super(
      'bridgeAbutmentSurfaces stage: the bridge context has no abutment margin loops in context.marginLoops — ' +
        'at least one prepped abutment (with a confirmed margin) is required.',
    );
    this.name = 'NoAbutmentMarginsError';
  }
}

/** Thrown when a required clinical gap/spacer param is missing/non-finite —
 * never defaulted here (CLAUDE.md invariant 7), same as the crown stage. */
export class MissingClinicalParamError extends Error {
  constructor(paramName: string, value: unknown) {
    super(
      `bridgeAbutmentSurfaces stage: required clinical param "${paramName}" is missing or non-finite (got ${String(value)}) — ` +
        `it must be resolved from the material profile onto context.materialProfile.restorationParams`,
    );
    this.name = 'MissingClinicalParamError';
  }
}

export interface BridgeAbutmentSurfacesStageOptions {
  /** Voxel pitch, mm — REQUIRED (the caller passes the clinical
   * `DEFAULT_OFFSET_VOXEL_PITCH_MM` from `@dqcad/clinical-profiles`). */
  readonly pitchMm: number;
  /** C1 blend width, mm — default `INNER_SURFACE_DEFAULT_BLEND_WIDTH_MM`. */
  readonly blendWidthMm?: number;
  /** Content-hash function for a produced mesh — injected by the caller
   * (hashing lives one layer up; same split as the crown stage). Deterministic. */
  readonly hashMesh: (mesh: IndexedMesh) => string;
}

/** One built abutment fit surface. */
export interface BridgeAbutmentSurface {
  readonly tooth: FdiTooth;
  readonly mesh: IndexedMesh;
  readonly meshContentHash: string;
  readonly errorBoundMm: number;
  readonly flatZoneErrorBoundMm: number;
  readonly marginLoopPointCount: number;
  readonly patchTriangleCount: number;
  readonly skirtTriangleCount: number;
  readonly marginVertexCount: number;
}

/** The bridge abutment-surfaces stage output — the per-abutment fit surfaces +
 * the ONE journaled multi-unit op fields (see this file's doc). Mirrors
 * `RestorationStageResult` but carries MULTIPLE meshes/hashes (one per
 * abutment). */
export interface BridgeAbutmentSurfacesStageResult {
  readonly stage: 'innerSurface';
  readonly abutments: readonly BridgeAbutmentSurface[];
  /** `Operation.name` — ONE multi-unit op for the whole coupled build. */
  readonly operationName: string;
  /** `Operation.params` — the shared axis + every abutment's sub-params; replay
   * reproduces every `outputHashes` entry bit-identically. */
  readonly params: Readonly<Record<string, unknown>>;
  /** `Operation.inputHashes` — the (single) prep/arch mesh every abutment reads. */
  readonly inputHashes: readonly string[];
  /** `Operation.outputHashes` — one per abutment, in `abutments` order. */
  readonly outputHashes: readonly string[];
  /** Max abutment error bound (mm). */
  readonly errorBoundMm: number;
}

function assertFiniteParam(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new MissingClinicalParamError(name, value);
  }
}

/** The abutment teeth: `marginLoops` keys minus `ponticSites`, ascending FDI. */
function abutmentTeeth(context: BridgePipelineContext): FdiTooth[] {
  const pontics = new Set<number>(context.ponticSites as readonly number[]);
  return (Object.keys(context.marginLoops) as unknown as string[])
    .map((k) => Number(k))
    .filter((t) => !pontics.has(t))
    .sort((a, b) => a - b) as unknown as FdiTooth[];
}

/**
 * Runs the bridge abutment fit-surfaces stage — see this file's doc. Builds
 * every abutment's intaglio against the SHARED `context.insertionAxis` (the P4
 * `buildInnerSurface` per abutment), returning them plus ONE journaled
 * multi-unit op. Pure async function of `(context, options)`; deterministic
 * (same context + options → byte-identical meshes + hashes).
 *
 * @throws {RestorationTypeMismatchError} / {BridgeContextIncompleteError} via
 * `assertBridgeContext` (wrong restoration type / incomplete bridge context).
 * @throws {NoAbutmentMarginsError} if there are no abutment margin loops.
 * @throws {MissingClinicalParamError} if a required gap/spacer param is missing.
 * @throws propagates `buildInnerSurface`'s typed errors.
 */
export async function runBridgeAbutmentSurfacesStage(
  context: BridgePipelineContext,
  options: BridgeAbutmentSurfacesStageOptions,
): Promise<BridgeAbutmentSurfacesStageResult> {
  assertBridgeContext(context); // bridge-only stage — guard rail

  const teeth = abutmentTeeth(context);
  if (teeth.length === 0) {
    throw new NoAbutmentMarginsError();
  }

  const rp = context.materialProfile.restorationParams;
  assertFiniteParam('marginalGapMm', rp.marginalGapMm);
  assertFiniteParam('cementGapMm', rp.cementGapMm);
  assertFiniteParam('spacerStartMm', rp.spacerStartMm);
  const blendWidthMm = options.blendWidthMm ?? INNER_SURFACE_DEFAULT_BLEND_WIDTH_MM;
  const sharedAxis: Vec3 = context.insertionAxis;

  const abutments: BridgeAbutmentSurface[] = [];
  const perAbutmentParams: Record<string, unknown>[] = [];
  for (const tooth of teeth) {
    const marginLoopInput = context.marginLoops[tooth];
    if (!marginLoopInput) {
      // abutmentTeeth() derives `teeth` FROM marginLoops keys, so this is
      // unreachable — defensive only.
      throw new NoAbutmentMarginsError();
    }
    // CHORD-CAP: dense resampledPoints only, never anchor chords.
    const loop = marginLoopPolyline({ closed: marginLoopInput.closed, resampledPoints: marginLoopInput.resampledPoints });

    const result = await buildInnerSurface(context.targetMesh.mesh, {
      marginalGapMm: rp.marginalGapMm,
      cementGapMm: rp.cementGapMm,
      spacerStartMm: rp.spacerStartMm,
      blendWidthMm,
      pitchMm: options.pitchMm,
      marginLoop: loop,
      insertionAxis: sharedAxis, // THE SHARED AXIS — every abutment, not each die's own
    });
    const meshContentHash = options.hashMesh(result.mesh);

    abutments.push({
      tooth,
      mesh: result.mesh,
      meshContentHash,
      errorBoundMm: result.errorBoundMm,
      flatZoneErrorBoundMm: result.flatZoneErrorBoundMm,
      marginLoopPointCount: loop.length,
      patchTriangleCount: result.patchTriangleCount,
      skirtTriangleCount: result.skirtTriangleCount,
      marginVertexCount: result.marginVertexCount,
    });
    perAbutmentParams.push({
      tooth,
      marginLoopPointCount: loop.length,
      patchTriangleCount: result.patchTriangleCount,
      skirtTriangleCount: result.skirtTriangleCount,
      marginVertexCount: result.marginVertexCount,
      errorBoundMm: result.errorBoundMm,
      flatZoneErrorBoundMm: result.flatZoneErrorBoundMm,
    });
  }

  const errorBoundMm = abutments.reduce((m, a) => Math.max(m, a.errorBoundMm), 0);

  return {
    stage: 'innerSurface',
    abutments,
    operationName: 'bridge.abutmentSurfaces',
    params: {
      abutmentTeeth: teeth as unknown as number[],
      sharedInsertionAxis: sharedAxis,
      pitchMm: options.pitchMm,
      marginalGapMm: rp.marginalGapMm,
      cementGapMm: rp.cementGapMm,
      spacerStartMm: rp.spacerStartMm,
      blendWidthMm,
      perAbutment: perAbutmentParams,
    },
    inputHashes: [context.targetMesh.contentHash],
    outputHashes: abutments.map((a) => a.meshContentHash),
    errorBoundMm,
  };
}
