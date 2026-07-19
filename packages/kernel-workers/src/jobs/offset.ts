// jobs/offset.ts — offsetMesh (Phase 2 Task 7): @dqcad/kernel's offset/
// module (banded SDF grid -> marching cubes at iso = distance -> weld ->
// manifold cleanup -> stats) — see that package's offsetMesh.ts for the
// pipeline, sign convention, and `@errorBound`, and mcTables.ts for the
// cited marching-cubes table source.
//
// ## Progress & cancellation (per this task's brief: "progress across
// SDF/MC/cleanup stages; cancellation between slices/stages")
//
// This job does NOT call @dqcad/kernel's `offsetMesh` convenience function
// (async but internally non-yielding through the two heavy synchronous
// stages) — it drives the SAME per-slice/per-slab primitives itself
// (`computeSdfGridSlice`, `marchingCubesSlab` — the identical functions
// `offsetMesh` composes, over the identical `offsetGridSpec` grid request),
// awaiting `ctx.cancelled()` and reporting `ctx.progress` between z-slices
// (SDF stage) and z-slabs (MC stage), and once more between each pipeline
// stage. Because both paths run the same primitives in the same order over
// the same inputs, this job's result is byte-identical to a direct
// `offsetMesh` call (pinned by offsetJob.test.ts's hash-equality test).
//
// Progress budget (fractions of 1, approximating measured stage costs at
// die scale where SDF sampling dominates): mesh analysis + BVH +
// pseudonormals 0→0.05, SDF slices 0.05→0.75, MC slabs 0.75→0.90, weld
// 0.90→0.94, manifold cleanup 0.94→0.98, final stats 0.98→1.
//
// `.ts` extension: reachable from the Node worker entry's import closure —
// see CLAUDE.md's "Import extension convention".
import {
  analyzeMesh,
  buildBvh,
  cleanupMesh,
  computePseudonormals,
  computeSdfGridSlice,
  markCandidateCells,
  marchingCubesSlab,
  maxAbsCoordOf,
  offsetErrorBoundMm,
  offsetGridSpec,
  sdfGridDims,
  weldVertices,
  EmptyOffsetResultError,
  type IndexedMesh,
  type MarchingCubesSoup,
  type MeshStats,
  type ScalarGrid,
} from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './context.ts';
import { requireMeshPayload } from './shared.ts';

export interface OffsetMeshPayload {
  positions: Float64Array;
  indices: Uint32Array;
  /** Offset distance, mm: positive = outward (grow), negative = inward
   * (shrink) — see @dqcad/kernel's offsetMesh.ts sign-convention doc. */
  distanceMm: number;
  /** Voxel pitch, mm — required (no job-level default; clinical defaults
   * live only in packages/clinical-profiles, see
   * `DEFAULT_OFFSET_VOXEL_PITCH_MM` there). */
  pitchMm: number;
}

export interface OffsetMeshResult {
  /** The offset mesh's buffers (transferred, not cloned — registry.ts's
   * `transferablesOf`). */
  positions: Float64Array;
  indices: Uint32Array;
  /** `analyzeMesh` over the FINAL cleaned mesh. */
  stats: MeshStats;
  /** Documented approximation bound, mm (PLAN §6.6) — see @dqcad/kernel's
   * offsetMesh.ts `@errorBound`. */
  errorBoundMm: number;
  distanceMm: number;
  pitchMm: number;
}

/**
 * `offsetMesh` worker job — see this file's module doc for the staged
 * progress/cancellation contract and the byte-identity argument vs. the
 * kernel's own `offsetMesh`.
 *
 * @throws {TypeError} for invalid `distanceMm`/`pitchMm` (checked before
 * any heavy work).
 * @throws {NonWatertightMeshError} (@dqcad/kernel) for a non-closed input.
 * @throws {SdfGridTooLargeError} (@dqcad/kernel) if the grid exceeds the
 * memory guard — before any grid allocation.
 * @throws {EmptyOffsetResultError} (@dqcad/kernel) if the offset surface is
 * empty.
 * @throws {NonManifoldInputError} (@dqcad/kernel) if the extracted surface
 * fails manifold validation (marching cubes' documented ambiguity
 * limitation).
 */
export const offsetMeshJob = async (payload: OffsetMeshPayload, ctx: JobContext): Promise<OffsetMeshResult> => {
  const { distanceMm, pitchMm } = payload;
  if (!Number.isFinite(distanceMm)) {
    throw new TypeError(`offsetMesh: distanceMm must be finite, got ${distanceMm}`);
  }
  if (!(Number.isFinite(pitchMm) && pitchMm > 0)) {
    throw new TypeError(`offsetMesh: pitchMm must be finite and > 0, got ${pitchMm}`);
  }
  requireMeshPayload(payload.positions, payload.indices, 'offsetMesh');
  const mesh: IndexedMesh = { positions: payload.positions, indices: payload.indices };

  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);

  // Stage 0: bbox + BVH + pseudonormals (the watertight gate).
  const inputStats = analyzeMesh(mesh);
  const bvh = buildBvh(mesh);
  const pseudonormals = computePseudonormals(mesh);
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0.05);

  // Stage 1: banded SDF grid, per-slice (identical request to the kernel's
  // offsetMesh via the shared offsetGridSpec — see module doc).
  const spec = offsetGridSpec(inputStats.bbox, distanceMm, pitchMm);
  const { dims, origin, cellCount } = sdfGridDims({ bboxMm: spec.bboxMm, pitchMm, padding: spec.padding });
  const [nx, ny, nz] = dims;
  const grid = new Float32Array(cellCount);
  const mask = markCandidateCells(mesh, dims, origin, pitchMm, spec.bandMm);
  for (let z = 0; z < nz; z++) {
    const slice = computeSdfGridSlice(mesh, bvh, pseudonormals, dims, origin, pitchMm, z, mask);
    grid.set(slice, z * ny * nx);
    if (await ctx.cancelled()) throw new JobCancelledError();
    ctx.progress(0.05 + 0.7 * ((z + 1) / nz));
  }

  // Stage 2: marching cubes at iso = distanceMm, per z-slab.
  const scalarGrid: ScalarGrid = { grid, dims, origin, pitchMm };
  const slabs: MarchingCubesSoup[] = [];
  let totalTriangles = 0;
  for (let z = 0; z <= nz - 2; z++) {
    const slab = marchingCubesSlab(scalarGrid, distanceMm, z);
    if (slab.triangleCount > 0) {
      slabs.push(slab);
      totalTriangles += slab.triangleCount;
    }
    if (await ctx.cancelled()) throw new JobCancelledError();
    ctx.progress(0.75 + 0.15 * ((z + 1) / (nz - 1)));
  }
  if (totalTriangles === 0) {
    throw new EmptyOffsetResultError(distanceMm);
  }
  const soupPositions = new Float64Array(totalTriangles * 9);
  let offset = 0;
  for (const slab of slabs) {
    soupPositions.set(slab.positions, offset);
    offset += slab.positions.length;
  }

  // Stage 3: weld, then manifold cleanup (async WASM — validates
  // watertight/manifold, collapses residual slivers).
  const welded = weldVertices({ positions: soupPositions, normals: null, triangleCount: totalTriangles });
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0.94);
  const cleaned = await cleanupMesh(welded);
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0.98);

  // Stage 4: stats over the FINAL mesh.
  const stats = analyzeMesh(cleaned);
  ctx.progress(1);

  return {
    positions: cleaned.positions,
    indices: cleaned.indices,
    stats,
    errorBoundMm: offsetErrorBoundMm(pitchMm, maxAbsCoordOf(inputStats.bbox, spec.padding)),
    distanceMm,
    pitchMm,
  };
};
