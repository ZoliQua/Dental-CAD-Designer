// jobs/bridgeFramework.ts — the BRIDGE FRAMEWORK CUTBACK worker job (Phase 6
// Task 5): for each unit, apply the framework cutback (@dqcad/kernel's
// `frameworkCutback`) — offset the OUTER anatomy inward by the veneering space,
// fit surfaces + margin preserved byte-exact. A thin driver over the kernel op;
// it computes NO value the op doesn't, so a payload yields byte-identical
// cut-back meshes + stats vs a direct kernel call (pinned by
// bridgeFrameworkJob.test.ts).
//
// ## Progress / cancellation
//
// One unit is a single O(V + V·loop) pass, so progress is PER-UNIT (unit i of N
// → i/N) with a cooperative cancel check before each unit; `checkCancel` throws
// `JobCancelledError`. The job also checks cancellation up front.
//
// `.ts` extension: reachable from the Node worker entry's import closure — see
// CLAUDE.md's "Import extension convention".
import { frameworkCutback, type IndexedMesh, type Vec3 } from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './context.ts';

/** One unit's serialized inputs — transferable flat buffers (the P5-T8 lesson:
 * serialized kernel-built assets, never a ported client construction). */
export interface BridgeFrameworkUnitPayload {
  positions: Float64Array;
  indices: Uint32Array;
  /** Per-vertex fit mask (1 = preserved fit vertex). Length = vertex count. */
  fitMask: Uint8Array;
  /** Flat (x,y,z) triples of the preserved-region boundary loop. */
  marginLoopFlat: Float64Array;
}

export interface BridgeFrameworkPayload {
  units: readonly BridgeFrameworkUnitPayload[];
  veneeringSpaceMm: number;
  marginTaperBandMm: number;
}

export interface BridgeFrameworkUnitResultPayload {
  positions: Float64Array;
  indices: Uint32Array;
  maxAppliedCutbackMm: number;
  meanFullWeightCutbackMm: number;
  errorBoundMm: number;
  fullWeightVertexCount: number;
  taperedVertexCount: number;
  preservedVertexCount: number;
}

export interface BridgeFrameworkResult {
  units: readonly BridgeFrameworkUnitResultPayload[];
}

function rebuildLoop(flat: Float64Array): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < flat.length; i += 3) out.push([flat[i]!, flat[i + 1]!, flat[i + 2]!]);
  return out;
}

function validate(payload: BridgeFrameworkPayload): void {
  if (payload.units.length === 0) throw new TypeError('bridgeFramework: at least one unit is required');
  if (!(payload.veneeringSpaceMm >= 0)) throw new TypeError(`bridgeFramework: veneeringSpaceMm must be >= 0, got ${payload.veneeringSpaceMm}`);
  if (!(payload.marginTaperBandMm > 0)) throw new TypeError(`bridgeFramework: marginTaperBandMm must be > 0, got ${payload.marginTaperBandMm}`);
  for (const u of payload.units) {
    if (u.fitMask.length !== u.positions.length / 3) {
      throw new TypeError('bridgeFramework: fitMask length must equal the unit vertex count');
    }
    if (u.marginLoopFlat.length < 6) throw new TypeError('bridgeFramework: marginLoopFlat needs >= 2 points (>= 6 coords)');
  }
}

/**
 * `bridgeFramework` worker job — see this file's module doc. Cuts back every
 * unit; byte-identical to direct kernel calls.
 *
 * @throws {TypeError} for empty/invalid inputs (before heavy work).
 * @throws {JobCancelledError} on cooperative cancellation.
 * @throws propagates `frameworkCutback`'s typed errors (@dqcad/kernel).
 */
export const bridgeFrameworkJob = async (
  payload: BridgeFrameworkPayload,
  ctx: JobContext,
): Promise<BridgeFrameworkResult> => {
  validate(payload);
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);

  const n = payload.units.length;
  const units: BridgeFrameworkUnitResultPayload[] = [];
  for (let i = 0; i < n; i++) {
    if (await ctx.cancelled()) throw new JobCancelledError();
    const u = payload.units[i]!;
    const mesh: IndexedMesh = { positions: u.positions, indices: u.indices };
    const fitVertexMask: boolean[] = Array.from(u.fitMask, (v) => v === 1);
    const cut = frameworkCutback(mesh, {
      veneeringSpaceMm: payload.veneeringSpaceMm,
      fitVertexMask,
      marginLoop: rebuildLoop(u.marginLoopFlat),
      marginTaperBandMm: payload.marginTaperBandMm,
    });
    units.push({
      positions: cut.mesh.positions,
      indices: cut.mesh.indices,
      maxAppliedCutbackMm: cut.maxAppliedCutbackMm,
      meanFullWeightCutbackMm: cut.meanFullWeightCutbackMm,
      errorBoundMm: cut.errorBoundMm,
      fullWeightVertexCount: cut.fullWeightVertexCount,
      taperedVertexCount: cut.taperedVertexCount,
      preservedVertexCount: cut.preservedVertexCount,
    });
    ctx.progress((i + 1) / n);
  }

  ctx.progress(1);
  return { units };
};
