// packages/cad-pipeline/src/stages/bridgeFramework.ts
//
// Phase 6 Task 5 — the BRIDGE FRAMEWORK-vs-FULL-CONTOUR stage. Framework mode
// reduces each unit to a coping/substructure by offsetting its OUTER anatomy
// inward by the profile's `veneeringSpaceMm` (the @dqcad/kernel `frameworkCutback`
// op), leaving room for hand-layered veneering ceramic while the FIT surfaces
// (abutment intaglio, pontic base) and the marginal SEAL survive byte-exact.
// Full-contour mode is the DEFAULT path and a strict pass-through: the unit
// meshes come out byte-identical (so every prior stage's outputs/hashes are
// unchanged — proven by the byte-identity tests).
//
// ## Mode is a JOURNALED design decision (an op)
//
// Framework-vs-full-contour is a clinical choice, so the stage emits ONE
// journaled op (`bridge.framework`) recording the mode + the veneering space +
// the taper band + per-unit cutback stats, EVEN in full-contour (where it
// records the decision but mutates no geometry — outputHashes == inputHashes).
// The whole-bridge thickness gate (Task 6) reads this mode to switch its
// threshold to `frameworkMinThicknessMm` (the falsifiable mode-switched gate).
//
// ## Guard rail (Phase 5 Task 1 pattern) + the outer/fit partition provenance
//
// `assertBridgeContext` at entry (bridge-only stage). Each unit supplies its
// closed mesh, its FIT-vertex mask (construction provenance — a shell knows its
// intaglio vertices from its outer vertices at stitch time; the fixture supplies
// it analytically), and its preserved-region boundary loop (the prep margin for
// an abutment / the base perimeter for a pontic — the taper's zero locus). The
// taper band defaults to the profile's `marginExclusionMm` feather (the P4/P5
// precedent) — so the veneering space is full EXCEPT within that thin band of
// the boundary, where it tapers to 0 to keep the seal closed (disclosed, not
// overclaimed).
import type { FdiTooth, Vec3 } from '@dqcad/shared-types';
import { frameworkCutback, type IndexedMesh } from '@dqcad/kernel';
import type { BridgePipelineContext } from '../pipeline/context.ts';
import { assertBridgeContext } from '../pipeline/context.ts';

/** Framework-vs-full-contour mode — a journaled design decision. */
export type FrameworkMode = 'framework' | 'fullContour';

/** Thrown when the required veneering space is missing/non-finite on the profile
 * — never defaulted here (CLAUDE.md invariant 7). */
export class MissingVeneeringSpaceError extends Error {
  constructor(value: unknown) {
    super(
      `bridgeFramework stage: context.materialProfile.veneeringSpaceMm is missing or non-finite (got ${String(value)}) — ` +
        'it must be resolved from the material profile.',
    );
    this.name = 'MissingVeneeringSpaceError';
  }
}

/** Thrown when no units are supplied. */
export class NoFrameworkUnitsError extends Error {
  constructor() {
    super('bridgeFramework stage: options.units is empty — at least one unit is required.');
    this.name = 'NoFrameworkUnitsError';
  }
}

/** One unit fed to the framework stage. */
export interface FrameworkUnitInput {
  readonly tooth: FdiTooth;
  /** The closed unit solid (outer anatomy + fit surface). */
  readonly mesh: IndexedMesh;
  readonly meshContentHash: string;
  /** Per-vertex fit mask (true = intaglio/base, preserved byte-exact) — length
   * = unit vertex count. Construction provenance (see this file's doc). */
  readonly fitVertexMask: readonly boolean[];
  /** The preserved-region boundary loop (prep margin / base perimeter) — the
   * cutback's taper zero-locus. */
  readonly marginLoop: readonly Vec3[];
}

export interface BridgeFrameworkStageOptions {
  /** The design mode — journaled. */
  readonly mode: FrameworkMode;
  /** The units to process (both abutments + pontics). */
  readonly units: readonly FrameworkUnitInput[];
  /** The taper band width (mm) — default `context.materialProfile.marginExclusionMm`
   * (the feather). Only used in framework mode. */
  readonly marginTaperBandMm?: number;
  /** Content-hash function for a produced mesh — injected by the caller. */
  readonly hashMesh: (mesh: IndexedMesh) => string;
}

/** One unit's framework-stage result. */
export interface FrameworkUnitResult {
  readonly tooth: FdiTooth;
  /** The unit mesh AFTER the stage — cut back (framework) or byte-identical
   * (full-contour). */
  readonly mesh: IndexedMesh;
  readonly meshContentHash: string;
  /** Max applied cutback (mm) — `veneeringSpaceMm` in framework mode, 0 in
   * full-contour. */
  readonly maxAppliedCutbackMm: number;
  /** Mean applied cutback over full-weight vertices (mm) — `veneeringSpaceMm`
   * in framework mode, 0 in full-contour. */
  readonly meanFullWeightCutbackMm: number;
  /** The cutback facet @errorBound (mm) — 0 in full-contour. */
  readonly errorBoundMm: number;
  /** Count of vertices in the near-margin taper band (0 < w < 1) — the extent of
   * the honestly-non-uniform veneering space. 0 in full-contour. */
  readonly taperedVertexCount: number;
  /** Count of preserved (byte-exact) vertices — every vertex in full-contour. */
  readonly preservedVertexCount: number;
  /** The cutback SELF-INTERSECTION flag (from the kernel op's self-validation) —
   * `true` iff the normal displacement folded the mesh (a pathological cutback
   * exceeding the local feature size). FLAG, not block: export QC (Task 6) is the
   * authority — but a folded unit is never silent. `false` in full-contour. */
  readonly selfIntersectionRisk: boolean;
  /** Flipped-triangle count from the op's self-validation (0 in full-contour). */
  readonly flippedTriangleCount: number;
}

export interface BridgeFrameworkStageResult {
  readonly stage: 'framework';
  readonly mode: FrameworkMode;
  readonly units: readonly FrameworkUnitResult[];
  /** `Operation.name`. */
  readonly operationName: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly inputHashes: readonly string[];
  readonly outputHashes: readonly string[];
  /** Max unit error bound (mm) — 0 in full-contour. */
  readonly errorBoundMm: number;
  /** `true` iff ANY unit's cutback folded (self-intersection) — the aggregate of
   * the per-unit flags, surfaced so a caller/QC cannot miss a folded unit.
   * `false` in full-contour. */
  readonly anyUnitSelfIntersectionRisk: boolean;
}

/**
 * Runs the bridge framework/full-contour stage — see this file's doc.
 * Deterministic: same context + options → byte-identical meshes + hashes (the
 * cutback op is pure Float64; full-contour is a reference pass-through).
 *
 * @throws {RestorationTypeMismatchError}/{BridgeContextIncompleteError} via
 * `assertBridgeContext`.
 * @throws {NoFrameworkUnitsError} if no units are supplied.
 * @throws {MissingVeneeringSpaceError} (framework mode) if the profile veneering
 * space is missing/non-finite.
 * @throws propagates `frameworkCutback`'s typed errors.
 */
export function runBridgeFrameworkStage(
  context: BridgePipelineContext,
  options: BridgeFrameworkStageOptions,
): BridgeFrameworkStageResult {
  assertBridgeContext(context); // bridge-only stage — guard rail
  if (options.units.length === 0) throw new NoFrameworkUnitsError();

  const inputHashes = options.units.map((u) => u.meshContentHash);

  if (options.mode === 'fullContour') {
    // Strict pass-through — the unit meshes come out byte-identical (same
    // reference), so every prior stage's output/hash is unchanged.
    const units: FrameworkUnitResult[] = options.units.map((u) => ({
      tooth: u.tooth,
      mesh: u.mesh,
      meshContentHash: u.meshContentHash,
      maxAppliedCutbackMm: 0,
      meanFullWeightCutbackMm: 0,
      errorBoundMm: 0,
      taperedVertexCount: 0,
      preservedVertexCount: u.mesh.positions.length / 3,
      selfIntersectionRisk: false,
      flippedTriangleCount: 0,
    }));
    return {
      stage: 'framework',
      mode: 'fullContour',
      units,
      operationName: 'bridge.framework',
      params: {
        mode: 'fullContour',
        veneeringSpaceMm: null, // not applied
        perUnit: options.units.map((u) => ({ tooth: u.tooth as unknown as number })),
      },
      inputHashes,
      outputHashes: inputHashes, // byte-identical — hashes do not move
      errorBoundMm: 0,
      anyUnitSelfIntersectionRisk: false,
    };
  }

  // Framework mode — resolve the veneering space from the profile (never defaulted).
  const veneeringSpaceMm = context.materialProfile.veneeringSpaceMm;
  if (!Number.isFinite(veneeringSpaceMm)) throw new MissingVeneeringSpaceError(veneeringSpaceMm);
  const marginTaperBandMm = options.marginTaperBandMm ?? context.materialProfile.marginExclusionMm;

  const units: FrameworkUnitResult[] = [];
  const perUnitParams: Record<string, unknown>[] = [];
  let maxErrorBoundMm = 0;
  let anyRisk = false;
  for (const u of options.units) {
    const cut = frameworkCutback(u.mesh, {
      veneeringSpaceMm,
      fitVertexMask: u.fitVertexMask,
      marginLoop: u.marginLoop,
      marginTaperBandMm,
    });
    const meshContentHash = options.hashMesh(cut.mesh);
    maxErrorBoundMm = Math.max(maxErrorBoundMm, cut.errorBoundMm);
    anyRisk = anyRisk || cut.validation.selfIntersectionRisk;
    units.push({
      tooth: u.tooth,
      mesh: cut.mesh,
      meshContentHash,
      maxAppliedCutbackMm: cut.maxAppliedCutbackMm,
      meanFullWeightCutbackMm: cut.meanFullWeightCutbackMm,
      errorBoundMm: cut.errorBoundMm,
      taperedVertexCount: cut.taperedVertexCount,
      preservedVertexCount: cut.preservedVertexCount,
      selfIntersectionRisk: cut.validation.selfIntersectionRisk,
      flippedTriangleCount: cut.validation.flippedTriangleCount,
    });
    perUnitParams.push({
      tooth: u.tooth as unknown as number,
      maxAppliedCutbackMm: cut.maxAppliedCutbackMm,
      meanFullWeightCutbackMm: cut.meanFullWeightCutbackMm,
      errorBoundMm: cut.errorBoundMm,
      fullWeightVertexCount: cut.fullWeightVertexCount,
      taperedVertexCount: cut.taperedVertexCount,
      preservedVertexCount: cut.preservedVertexCount,
      // The cutback's self-validation, journaled — a folded unit is auditable.
      selfIntersectionRisk: cut.validation.selfIntersectionRisk,
      flippedTriangleCount: cut.validation.flippedTriangleCount,
      degenerateTriangleCount: cut.validation.degenerateTriangleCount,
    });
  }

  return {
    stage: 'framework',
    mode: 'framework',
    units,
    operationName: 'bridge.framework',
    params: {
      mode: 'framework',
      veneeringSpaceMm,
      marginTaperBandMm,
      anyUnitSelfIntersectionRisk: anyRisk,
      perUnit: perUnitParams,
    },
    inputHashes,
    outputHashes: units.map((u) => u.meshContentHash),
    errorBoundMm: maxErrorBoundMm,
    anyUnitSelfIntersectionRisk: anyRisk,
  };
}
