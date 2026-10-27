// jobs/prepDie.ts — the crown PREPARE-DIE job (Phase 10 Task 2, ADR-023
// Decision 1): @dqcad/kernel's `extractPrepDie` on the case's target scan,
// which is BVH-cache-resident on this worker (jobs/bvh.ts's `requireCachedBvh`
// — the caller runs `buildBvh` first with the same `affinityKey`). See the
// kernel op's module doc for the kept region, the closure, the certificate and
// `@errorBound`.
//
// ## The die is cut from the scan's PERSISTED FORM
//
// The server re-extracts the die from the scan it stores — a binary STL, so
// float32 coordinates re-welded — and refuses an export whose die differs
// from the client's (dual validation, invariant 6). The job therefore runs the
// op on `persistedMeshForm(scan)` (kernel intake/persistedForm.ts), which is
// exactly that reloaded mesh (proven against the real serialize/parse/weld
// jobs in prepDieJob.test.ts) and is idempotent, so a session reopened from
// the stored case cuts the identical die. For a scan imported from STL the
// coordinates are unchanged; otherwise each moves by at most half a float32
// ULP (the form's `@errorBound`).
//
// The op is a synchronous Float64 pass (well under a second on a full arch),
// so progress is coarse (0 → 1) with one cancellation checkpoint up front;
// neither affects any computed value (byte-identical to a direct kernel call
// on the persisted form — prepDieJob.test.ts).
//
// `.ts` extension: reachable from the Node worker entry's import closure — see
// CLAUDE.md's "Import extension convention".
import { extractPrepDie, persistedMeshForm, type PrepDieOptions, type Vec3 } from '@dqcad/kernel';
import { requireCachedBvh } from './bvh.ts';
import { JobCancelledError, type JobContext } from './context.ts';

export interface ExtractPrepDiePayload {
  /** Content hash of the target scan (its BVH must be cached on this worker). */
  contentHash: string;
  /** The confirmed margin loop, flat xyz. */
  marginLoop: Float64Array;
  insertionAxis: Vec3;
  /** Kernel ALGORITHM overrides (defaults applied by the kernel op). */
  options?: PrepDieOptions;
}

export interface ExtractPrepDieResult {
  /** The closed die; its first `keptTriangleCount` triangles are the
   * persisted scan's surface, verbatim. */
  positions: Float64Array;
  indices: Uint32Array;
  keptTriangleCount: number;
  syntheticTriangleCount: number;
  sourceTriangleIndices: Uint32Array;
  rimVertexCount: number;
  foldTrianglesDropped: number;
  /** The certificate (mm); `Infinity` when the scan closes the die itself. */
  clearanceMm: number;
  marginMinHeightMm: number;
  floorHeightMm: number | null;
  volumeMm3: number;
  insertionAxis: Vec3;
  radialSkirtMm: number;
  depthSkirtMm: number;
  protectBandMm: number;
  floorGapMm: number;
  requiredClearanceMm: number;
}

/**
 * `extractPrepDie` worker job.
 *
 * @throws {TypeError} a malformed margin loop (before any work).
 * @throws {BvhNotCachedError} (jobs/bvh.ts) no BVH cached for `contentHash`.
 * @throws {JobCancelledError} if cancelled.
 * @throws propagates the kernel's typed errors (`PrepDieRegionError`,
 * `PrepDieInvalidError`, `PrepDieClearanceError`, `RangeError`).
 */
export const extractPrepDieJob = async (
  payload: ExtractPrepDiePayload,
  ctx: JobContext,
): Promise<ExtractPrepDieResult> => {
  if (!(payload.marginLoop instanceof Float64Array) || payload.marginLoop.length % 3 !== 0) {
    throw new TypeError('extractPrepDie: marginLoop must be a Float64Array of xyz triples');
  }
  ctx.progress(0);
  if (await ctx.cancelled()) throw new JobCancelledError();
  const { mesh } = requireCachedBvh(payload.contentHash);
  const loop: Vec3[] = [];
  for (let i = 0; i < payload.marginLoop.length; i += 3) {
    loop.push([payload.marginLoop[i]!, payload.marginLoop[i + 1]!, payload.marginLoop[i + 2]!]);
  }
  const r = extractPrepDie(persistedMeshForm(mesh), loop, payload.insertionAxis, payload.options ?? {});
  ctx.progress(1);
  return {
    positions: r.mesh.positions,
    indices: r.mesh.indices,
    keptTriangleCount: r.keptTriangleCount,
    syntheticTriangleCount: r.syntheticTriangleCount,
    sourceTriangleIndices: r.sourceTriangleIndices,
    rimVertexCount: r.rimVertexCount,
    foldTrianglesDropped: r.foldTrianglesDropped,
    clearanceMm: r.clearanceMm,
    marginMinHeightMm: r.marginMinHeightMm,
    floorHeightMm: r.floorHeightMm,
    volumeMm3: r.volumeMm3,
    insertionAxis: r.insertionAxis,
    radialSkirtMm: r.radialSkirtMm,
    depthSkirtMm: r.depthSkirtMm,
    protectBandMm: r.protectBandMm,
    floorGapMm: r.floorGapMm,
    requiredClearanceMm: r.requiredClearanceMm,
  };
};
