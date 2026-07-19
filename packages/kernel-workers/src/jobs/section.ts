// jobs/section.ts — sectionMesh (Task 10): cross-section outline (+
// optional filled cap) of a mesh against a plane — off the UI thread since a
// quarter-million-triangle arch scan's per-triangle classification
// (kernel/src/section/polyline.ts's `sectionMesh`) is real, if bounded, CPU
// work, and the optional manifold-3d cap is async WASM work already.
//
// Split out of the original monolithic jobs.ts (Phase 2 Task 1: "split
// jobs.ts before new jobs" — see jobs/registry.ts's module doc for the full
// rationale and file map). Pure mechanical move (at that time): no
// behavioral change.
//
// ## contentHash, not raw buffers (Phase 3 Task 1 housekeeping: "jobs/
// section.ts stops re-sending buffers")
//
// This job now takes a `contentHash` (jobs/bvh.ts's `requireCachedBvh`),
// same convention as buildBvh/measurePointToSurface/raycastMesh — `buildBvh`
// must have been called for it on THIS worker first. Deliberately NO
// per-worker RESULT cache alongside this, unlike jobs/curvature.ts/jobs/
// offset.ts: a section query still needs to walk the FULL mesh once per
// call regardless (there is no repeated-EXACT-query structure to amortize a
// result cache against — a different plane point/normal is a different
// query every time, unlike curvature's "same mesh, same answer always" or
// offset's "same mesh + same distance/pitch, same answer"), so the only
// actual saving available here is skipping the buffer RE-SEND — which
// reusing the already-cached mesh (`requireCachedBvh(payload.contentHash)
// .mesh`) gets for free, without needing to also memoize section results.
// apps/client/src/engine/section.ts routes this through the shared
// `getPool()` with `affinityKey: contentHash` (mirroring measurePointToSurface's
// call-site convention) so a `buildBvh` call for a mesh and a later
// `sectionMesh` call for the SAME mesh land on the SAME worker.
//
// Cancellation/progress granularity: like buildBvh/the repair jobs
// (jobs/bvh.ts, jobs/repair.ts), this is fundamentally ONE bounded
// synchronous kernel call (the polyline extraction) plus, when requested,
// one bounded async manifold-3d call (the cap) — a single checkpoint before
// starting is this Phase's acceptable granularity (documented rationale
// matches those jobs' own doc comments).
//
// `.ts` extension: reachable from the Node worker entry's import closure —
// see CLAUDE.md's "Import extension convention".
import {
  sectionMesh as computeSectionMesh,
  sectionCap,
  normalizePlane,
  projectPolylinesToPlaneXY,
  NonManifoldInputError,
  type Vec3,
} from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './context.ts';
import { requireCachedBvh } from './bvh.ts';
import type { Vec3Payload } from './shared.ts';

export interface SectionMeshPayload {
  contentHash: string;
  /** A point the cutting plane passes through, Float64 mm world coords. */
  point: Vec3Payload;
  /** The cutting plane's normal (need not be unit length — see kernel
   * `normalizePlane`). */
  normal: Vec3Payload;
  /** Also compute the filled cap via manifold-3d's slice (Task 10's brief:
   * "for CLOSED WATERTIGHT meshes"). Defaults false. A non-watertight mesh
   * with `computeCap: true` does NOT fail the whole job — the cap is
   * silently omitted (`capPositions`/`capIndices` stay `null`) since the
   * outline is still perfectly valid for an open mesh; only a genuinely
   * unexpected error (anything other than `NonManifoldInputError`)
   * propagates. */
  computeCap?: boolean;
}

export interface SectionMeshResult {
  /** Flat xyz (Float64 mm, world/kernel frame) — every polyline's points
   * concatenated in order; split back into individual polylines using
   * `polylineCounts` (point count per polyline, same order). */
  pointsFlat: Float64Array;
  /** Flat xy (Float64 mm, PLANE-LOCAL 2D — see kernel `projectToPlaneXY`) —
   * same per-polyline structure/order as `pointsFlat` (2 components per
   * point instead of 3), ready for `sectionToSvg` without the caller
   * needing any plane-basis math of its own (apps/client/src/engine cannot
   * import `@dqcad/kernel` directly — see eslint.config.js's boundaries
   * policy — so this projection has to happen worker-side). */
  points2dFlat: Float64Array;
  /** Point count per polyline — shared by both flat arrays above. */
  polylineCounts: Uint32Array;
  /** One entry per polyline, same order: 1 = closed loop, 0 = open chain. */
  polylineClosed: Uint8Array;
  /** Present only when `computeCap` was requested AND the mesh was
   * watertight AND the plane actually intersects it — `null` otherwise
   * (display-only; see kernel `sectionCap`'s doc for its Float32-WASM-
   * boundary precision bound). */
  capPositions: Float64Array | null;
  capIndices: Uint32Array | null;
}

export const sectionMeshJob = async (
  payload: SectionMeshPayload,
  ctx: JobContext,
): Promise<SectionMeshResult> => {
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);

  const { mesh } = requireCachedBvh(payload.contentHash);
  const plane = { point: payload.point as Vec3, normal: payload.normal as Vec3 };

  const { polylines } = computeSectionMesh(mesh, plane);
  const basis = normalizePlane(plane);
  const svgPolylines = projectPolylinesToPlaneXY(
    polylines.map((polyline) => ({ points: polyline.points, closed: polyline.closed })),
    basis,
  );

  let totalPoints = 0;
  for (const polyline of polylines) {
    totalPoints += polyline.points.length / 3;
  }
  const pointsFlat = new Float64Array(totalPoints * 3);
  const points2dFlat = new Float64Array(totalPoints * 2);
  const polylineCounts = new Uint32Array(polylines.length);
  const polylineClosed = new Uint8Array(polylines.length);
  let offset3 = 0;
  let offset2 = 0;
  for (let i = 0; i < polylines.length; i++) {
    const polyline = polylines[i]!;
    const svgPolyline = svgPolylines[i]!;
    const count = polyline.points.length / 3;
    polylineCounts[i] = count;
    polylineClosed[i] = polyline.closed ? 1 : 0;
    pointsFlat.set(polyline.points, offset3);
    points2dFlat.set(svgPolyline.points, offset2);
    offset3 += polyline.points.length;
    offset2 += svgPolyline.points.length;
  }

  ctx.progress(payload.computeCap ? 0.5 : 1);

  let capPositions: Float64Array | null = null;
  let capIndices: Uint32Array | null = null;
  if (payload.computeCap) {
    try {
      const cap = await sectionCap(mesh, plane);
      if (cap) {
        capPositions = cap.positions;
        capIndices = cap.indices;
      }
    } catch (error) {
      if (!(error instanceof NonManifoldInputError)) {
        throw error;
      }
      // Not watertight — cap silently omitted, outline is still valid. See
      // SectionMeshPayload.computeCap's doc.
    }
  }

  ctx.progress(1);
  return { pointsFlat, points2dFlat, polylineCounts, polylineClosed, capPositions, capIndices };
};
