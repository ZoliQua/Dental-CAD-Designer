// jobs/cavityOcclusalPatch.ts — the INLAY/ONLAY OUTER surface stage (Phase 5
// Task 4): @dqcad/kernel's `buildOcclusalPatch` — the occlusal anatomy patch +
// cubic-Hermite G1 seam blend over the cavity opening, boundary bit-exact on the
// cavity outline, plus the G1 acceptance measurement (`measureSeamDihedral`, max
// seam dihedral < 5°). See @dqcad/kernel's cavity/occlusalPatch.ts for the
// seam/free partition, the blend method, and `@errorBound`.
//
// ## Progress, cancellation & byte-identity
//
// `buildOcclusalPatch` is a fast SYNCHRONOUS Float64 op (no internal yield
// points), so the job reports COARSE progress around its phases (0 → build →
// measure → 1) and checks cancellation BEFORE the build (the heavier phase —
// `classifyCavityRegions`' O(mesh) edge map). The progress/cancel hooks affect
// NO computed value, so the job's mesh is BYTE-IDENTICAL to a direct
// `buildOcclusalPatch` call (pinned by cavityOcclusalPatchJob.test.ts).
//
// ## Per-worker result cache
//
// Takes a `contentHash` (NOT raw buffers) and requires `buildBvh` to have run
// for it on THIS worker (jobs/bvh.ts's `requireCachedBvh`) — reusing only the
// cached MESH (the kernel op builds its own internals). Keyed by `contentHash`
// then a `paramKey` (axis + crossSegments + outline).
//
// `.ts` extension: reachable from the Node worker entry's import closure — see
// CLAUDE.md's "Import extension convention". NOTE: no TypeScript constructor
// parameter properties anywhere in this file (the Task 1 worker-loader landmine)
// — there are no classes here; the payload/result are plain interfaces.
import {
  buildOcclusalPatch,
  measureSeamDihedral,
  type MeshStats,
  type SeamEdge,
  type Vec3,
} from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './context.ts';
import { onBvhRelease, requireCachedBvh } from './bvh.ts';

export interface CavityOcclusalPatchPayload {
  contentHash: string;
  /** The dense on-surface cavity outline, flat xyz (transferable) — rebuilt into
   * Vec3[] inside the job. */
  cavityOutline: Float64Array;
  /** Insertion axis (the inlay's lift-out direction). */
  insertionAxis: Vec3;
  /** Buccolingual cross-sweep segments per station (kernel default applied by
   * the caller/stage when absent). */
  crossSegments?: number;
}

export interface CavityOcclusalPatchResult {
  positions: Float64Array;
  indices: Uint32Array;
  stats: MeshStats;
  seamEdges: SeamEdge[];
  freeEdges: SeamEdge[];
  cavityTriangleIndices: Uint32Array;
  seamDihedralMaxDeg: number;
  seamDihedralMeanDeg: number;
  seamDihedralBoundDeg: number;
  patchTriangleCount: number;
  crossSegments: number;
  seamSurroundingMaxAngleDeg: number;
}

const patchCache = new Map<string, Map<string, CavityOcclusalPatchResult>>();

function paramKey(p: CavityOcclusalPatchPayload): string {
  return JSON.stringify({
    insertionAxis: p.insertionAxis,
    crossSegments: p.crossSegments ?? null,
    cavityOutline: Array.from(p.cavityOutline),
  });
}

onBvhRelease((contentHash) => {
  patchCache.delete(contentHash);
});

function cloneSeamEdges(edges: readonly SeamEdge[]): SeamEdge[] {
  return edges.map((e) => ({ a: [e.a[0], e.a[1], e.a[2]] as Vec3, b: [e.b[0], e.b[1], e.b[2]] as Vec3, segment: e.segment }));
}

function cloneCachedResult(r: CavityOcclusalPatchResult): CavityOcclusalPatchResult {
  return {
    positions: r.positions.slice(),
    indices: r.indices.slice(),
    stats: r.stats,
    seamEdges: cloneSeamEdges(r.seamEdges),
    freeEdges: cloneSeamEdges(r.freeEdges),
    cavityTriangleIndices: r.cavityTriangleIndices.slice(),
    seamDihedralMaxDeg: r.seamDihedralMaxDeg,
    seamDihedralMeanDeg: r.seamDihedralMeanDeg,
    seamDihedralBoundDeg: r.seamDihedralBoundDeg,
    patchTriangleCount: r.patchTriangleCount,
    crossSegments: r.crossSegments,
    seamSurroundingMaxAngleDeg: r.seamSurroundingMaxAngleDeg,
  };
}

function rebuildLoop(flat: Float64Array): Vec3[] {
  const loop: Vec3[] = [];
  for (let i = 0; i < flat.length; i += 3) loop.push([flat[i]!, flat[i + 1]!, flat[i + 2]!]);
  return loop;
}

/**
 * `cavityOcclusalPatch` worker job — see this file's module doc for the coarse
 * progress/cancellation contract, the per-worker cache, and the byte-identity
 * argument vs. `buildOcclusalPatch`. `buildBvh` must have been called for
 * `payload.contentHash` on THIS worker first (its cached MESH is used).
 *
 * @throws {BvhNotCachedError} (jobs/bvh.ts) on a cache MISS if BVH was never built.
 * @throws {TypeError} for invalid outline/axis/crossSegments (before heavy work).
 * @throws propagates @dqcad/kernel's typed errors (non-MOD outline, outline not
 * an on-mesh edge ring, axis perpendicular).
 */
export const cavityOcclusalPatchJob = async (payload: CavityOcclusalPatchPayload, ctx: JobContext): Promise<CavityOcclusalPatchResult> => {
  const { contentHash, insertionAxis, crossSegments } = payload;
  if (!payload.cavityOutline || payload.cavityOutline.length < 9) {
    throw new TypeError(`cavityOcclusalPatch: cavityOutline must have >= 3 points (>= 9 flat coords)`);
  }
  const axisLen = Math.hypot(insertionAxis[0], insertionAxis[1], insertionAxis[2]);
  if (!(axisLen > 0)) {
    throw new TypeError('cavityOcclusalPatch: insertionAxis must be a non-zero vector');
  }
  if (crossSegments !== undefined && !(Number.isInteger(crossSegments) && crossSegments >= 2)) {
    throw new TypeError(`cavityOcclusalPatch: crossSegments must be an integer >= 2, got ${crossSegments}`);
  }

  ctx.progress(0);
  const cached = patchCache.get(contentHash)?.get(paramKey(payload));
  if (cached) {
    ctx.progress(1);
    return cloneCachedResult(cached);
  }

  if (await ctx.cancelled()) throw new JobCancelledError();
  const { mesh } = requireCachedBvh(contentHash);
  const cavityOutline = rebuildLoop(payload.cavityOutline);

  const patch = buildOcclusalPatch(mesh, cavityOutline, insertionAxis, crossSegments !== undefined ? { crossSegments } : {});
  ctx.progress(0.7);

  const m = measureSeamDihedral(patch.mesh, mesh, patch.seamEdges, {
    excludeToothTriangles: new Set(patch.cavityTriangleIndices),
  });
  ctx.progress(1);

  const jobResult: CavityOcclusalPatchResult = {
    positions: patch.mesh.positions,
    indices: patch.mesh.indices,
    stats: patch.stats,
    seamEdges: cloneSeamEdges(patch.seamEdges),
    freeEdges: cloneSeamEdges(patch.freeEdges),
    cavityTriangleIndices: patch.cavityTriangleIndices,
    seamDihedralMaxDeg: m.maxDeg,
    seamDihedralMeanDeg: m.meanDeg,
    seamDihedralBoundDeg: patch.seamDihedralBoundDeg,
    patchTriangleCount: patch.patchTriangleCount,
    crossSegments: patch.crossSegments,
    seamSurroundingMaxAngleDeg: patch.seamSurroundingMaxAngleDeg,
  };

  let byParams = patchCache.get(contentHash);
  if (!byParams) {
    byParams = new Map();
    patchCache.set(contentHash, byParams);
  }
  byParams.set(paramKey(payload), jobResult);

  return cloneCachedResult(jobResult);
};
