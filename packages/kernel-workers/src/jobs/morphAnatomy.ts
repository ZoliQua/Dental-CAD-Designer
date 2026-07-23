// jobs/morphAnatomy.ts — the adaptation/morphing worker job (Phase 4 Task 6):
// @dqcad/kernel's `planAnatomyMorph` → `solveAnatomyMorph` (the deterministic
// RBF contact morph — see @dqcad/kernel's anatomy/morph.ts for the φ(r)=r
// biharmonic formulation, the control-point construction and the direct-solve
// determinism). Deforms the placed library tooth so it makes correct proximal +
// antagonist contacts while preserving the marginal seal.
//
// ## Two jobs, one interactive split (the < 500 ms slider path)
//
//   • `morphAnatomy`   — build the geometry-dependent PLAN (BVH builds, contact
//                        selection, anchor picking) + solve at the given
//                        strengths, and CACHE the plan on this worker under
//                        `payload.planId`. This is the heavier first pass.
//   • `resolveMorph`   — re-solve a CACHED plan at new strengths (the sliders).
//                        No BVH rebuild, no contact re-selection — just the
//                        (N+4)³ direct RBF solve + the O(V·N) field apply. This
//                        is the < 500 ms interactive path the brief targets.
//
// The plan cache is a per-worker module-level Map, exactly like jobs/bvh.ts's
// `bvhCache` (same pool-affinity caveat: `resolveMorph` only hits the plan
// `morphAnatomy` built if both land on the SAME worker — pin to a size:1 pool,
// as engine/workers.ts's measurement pool already does for BVH queries).
//
// ## Contact heatmaps (deliverable 2) — reuse `closestPointBatch`
//
// When `payload.computeHeatmaps` is set, per-vertex SIGNED contact distances
// (morphed tooth vertex → each contact surface) are computed with the kernel's
// `closestPointBatch` + the same face-normal sign convention as the P1
// distance-heatmap job — NOT a reinvented distance routine.
//
// `.ts` extension: reachable from the Node worker entry's import closure — see
// CLAUDE.md's "Import extension convention".
import {
  planAnatomyMorph,
  solveAnatomyMorph,
  buildBvh,
  closestPointBatch,
  type AnatomyMorphPlan,
  type IndexedMesh,
  type MorphContactInput,
  type MorphContactKind,
  type MorphOptions,
  type MorphStrengths,
  type Vec3,
} from '@dqcad/kernel';
import { JobCancelledError, type JobContext } from './context.ts';

export interface MorphAnatomyContactPayload {
  kind: MorphContactKind;
  /** The other surface (neighbour crown or antagonist), Float64 flat xyz +
   * triangle indices. Must have triangles + consistent outward winding. */
  positions: Float64Array;
  indices: Uint32Array;
  targetPenetrationMm: number;
}

export interface MorphAnatomyPayload {
  /** Cache key for the plan (so `resolveMorph` can reuse it) — the caller's
   * restoration/session id. */
  planId: string;
  /** Placed library tooth (Task 5 output), Float64 flat xyz + indices. */
  placedPositions: Float64Array;
  placedIndices: Uint32Array;
  /** Confirmed margin loop, Float64 flat xyz (deduplicated by the caller). */
  marginLoop: Float64Array;
  contacts: MorphAnatomyContactPayload[];
  strengths?: MorphStrengths;
  options?: Partial<MorphOptions>;
  /** When true, return per-vertex signed contact-distance heatmaps. */
  computeHeatmaps?: boolean;
}

export interface ResolveMorphPayload {
  planId: string;
  strengths?: MorphStrengths;
  computeHeatmaps?: boolean;
}

export interface MorphContactResultPayload {
  kind: MorphContactKind;
  strength: number;
  targetPenetrationMm: number;
  achievedSignedDistanceMm: number;
  contactResidualMm: number;
  regionMinSignedDistanceMm: number;
  regionMeanSignedDistanceMm: number;
  regionRmsSignedDistanceMm: number;
  facingVertexCount: number;
  regionResidualMm: number;
  /** True if this contact's root-find was CLAMPED (target unachieved) — a QC
   * warning, not a silent success. */
  clampBound: boolean;
}

export interface ContactHeatmapPayload {
  kind: MorphContactKind;
  /** One signed distance per morphed tooth vertex (mm), same vertex order as
   * `positions`. Negative = penetrating the contact surface. */
  distances: Float64Array;
  min: number;
  max: number;
  mean: number;
  rms: number;
}

export interface MorphAnatomyResult {
  positions: Float64Array;
  indices: Uint32Array;
  contacts: MorphContactResultPayload[];
  maxContactResidualMm: number | null;
  /** Conservative downstream @errorBound (contact + region over-penetration). */
  errorBoundMm: number | null;
  /** Kinds of contacts whose target was NOT achieved (clamped) — QC warning. */
  clampedContacts: MorphContactKind[];
  marginSealMaxDeviationMm: number;
  marginSealAtFinishLineMm: number;
  marginSealBetweenPinsMm: number;
  controlPointCount: number;
  heatmaps?: ContactHeatmapPayload[];
}

export class MorphPlanNotCachedError extends Error {
  constructor(planId: string) {
    super(`No morph plan cached for planId "${planId}" on this worker — run morphAnatomy first (see jobs/morphAnatomy.ts's per-worker cache doc)`);
    this.name = 'MorphPlanNotCachedError';
  }
}

interface CachedPlan {
  plan: AnatomyMorphPlan;
  /** The contact surfaces, kept for heatmap re-computation on a re-solve. */
  contactMeshes: { kind: MorphContactKind; mesh: IndexedMesh }[];
}

/** Per-worker plan cache — see this file's module doc (same pattern/caveat as
 * jobs/bvh.ts's `bvhCache`). */
const planCache = new Map<string, CachedPlan>();

function rebuildLoop(flat: Float64Array): Vec3[] {
  const loop: Vec3[] = [];
  for (let i = 0; i < flat.length; i += 3) loop.push([flat[i]!, flat[i + 1]!, flat[i + 2]!]);
  return loop;
}

function faceNormalUnnormalized(mesh: IndexedMesh, tri: number): Vec3 {
  const i0 = mesh.indices[tri * 3]!;
  const i1 = mesh.indices[tri * 3 + 1]!;
  const i2 = mesh.indices[tri * 3 + 2]!;
  const p = mesh.positions;
  const ax = p[i1 * 3]! - p[i0 * 3]!;
  const ay = p[i1 * 3 + 1]! - p[i0 * 3 + 1]!;
  const az = p[i1 * 3 + 2]! - p[i0 * 3 + 2]!;
  const bx = p[i2 * 3]! - p[i0 * 3]!;
  const by = p[i2 * 3 + 1]! - p[i0 * 3 + 1]!;
  const bz = p[i2 * 3 + 2]! - p[i0 * 3 + 2]!;
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

/** Signed distance heatmap of `points` to `mesh` — reuses `closestPointBatch`,
 * sign from the closest triangle's face normal (P1 distance-heatmap convention). */
function contactHeatmap(kind: MorphContactKind, mesh: IndexedMesh, points: Float64Array): ContactHeatmapPayload {
  const bvh = buildBvh(mesh);
  const results = closestPointBatch(mesh, bvh, points);
  const distances = new Float64Array(results.length);
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    let d = r.distance;
    if (d > 0) {
      const n = faceNormalUnnormalized(mesh, r.triangleIndex);
      const dot = (points[i * 3]! - r.point[0]) * n[0] + (points[i * 3 + 1]! - r.point[1]) * n[1] + (points[i * 3 + 2]! - r.point[2]) * n[2];
      if (dot < 0) d = -d;
    }
    distances[i] = d;
    if (d < min) min = d;
    if (d > max) max = d;
    sum += d;
    sumSq += d * d;
  }
  const n = results.length;
  return { kind, distances, min: n ? min : 0, max: n ? max : 0, mean: n ? sum / n : 0, rms: n ? Math.sqrt(sumSq / n) : 0 };
}

function solveAndPackage(
  cached: CachedPlan,
  strengths: MorphStrengths | undefined,
  computeHeatmaps: boolean,
): MorphAnatomyResult {
  const result = solveAnatomyMorph(cached.plan, strengths);
  const out: MorphAnatomyResult = {
    positions: result.mesh.positions,
    indices: result.mesh.indices,
    contacts: result.contacts.map((c) => ({
      kind: c.kind,
      strength: c.strength,
      targetPenetrationMm: c.targetPenetrationMm,
      achievedSignedDistanceMm: c.achievedSignedDistanceMm,
      contactResidualMm: c.contactResidualMm,
      regionMinSignedDistanceMm: c.regionMinSignedDistanceMm,
      regionMeanSignedDistanceMm: c.regionMeanSignedDistanceMm,
      regionRmsSignedDistanceMm: c.regionRmsSignedDistanceMm,
      facingVertexCount: c.facingVertexCount,
      regionResidualMm: c.regionResidualMm,
      clampBound: c.clampBound,
    })),
    maxContactResidualMm: result.maxContactResidualMm,
    errorBoundMm: result.errorBoundMm,
    clampedContacts: [...result.clampedContacts],
    marginSealMaxDeviationMm: result.marginSealMaxDeviationMm,
    marginSealAtFinishLineMm: result.marginSealAtFinishLineMm,
    marginSealBetweenPinsMm: result.marginSealBetweenPinsMm,
    controlPointCount: result.controlPointCount,
  };
  if (computeHeatmaps) {
    out.heatmaps = cached.contactMeshes.map((c) => contactHeatmap(c.kind, c.mesh, result.mesh.positions));
  }
  return out;
}

/**
 * `morphAnatomy` worker job — build + cache the plan, then solve. See this
 * file's module doc. Progress: 0 → plan built (0.6) → solved (1). Cancellation
 * checked up front and between plan and solve.
 *
 * @throws {JobCancelledError} if cancelled.
 * @throws propagates @dqcad/kernel's `MorphContactMeshError` / `MorphNoAnchorsError`.
 */
export const morphAnatomyJob = async (payload: MorphAnatomyPayload, ctx: JobContext): Promise<MorphAnatomyResult> => {
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);

  const placedMesh: IndexedMesh = { positions: payload.placedPositions, indices: payload.placedIndices };
  const contactMeshes = payload.contacts.map((c) => ({
    kind: c.kind,
    mesh: { positions: c.positions, indices: c.indices } as IndexedMesh,
  }));
  const contacts: MorphContactInput[] = payload.contacts.map((c, i) => ({
    kind: c.kind,
    mesh: contactMeshes[i]!.mesh,
    targetPenetrationMm: c.targetPenetrationMm,
  }));

  const plan = planAnatomyMorph({
    placedMesh,
    marginLoop: rebuildLoop(payload.marginLoop),
    contacts,
    options: payload.options,
  });
  ctx.progress(0.6);
  if (await ctx.cancelled()) throw new JobCancelledError();

  const cached: CachedPlan = { plan, contactMeshes };
  planCache.set(payload.planId, cached);

  const out = solveAndPackage(cached, payload.strengths, payload.computeHeatmaps === true);
  ctx.progress(1);
  return out;
};

/**
 * `resolveMorph` worker job — re-solve a CACHED plan at new strengths (the
 * < 500 ms slider path). See this file's module doc.
 *
 * @throws {MorphPlanNotCachedError} if `planId` was never built on this worker.
 * @throws {JobCancelledError} if cancelled.
 */
export const resolveMorphJob = async (payload: ResolveMorphPayload, ctx: JobContext): Promise<MorphAnatomyResult> => {
  if (await ctx.cancelled()) throw new JobCancelledError();
  ctx.progress(0);
  const cached = planCache.get(payload.planId);
  if (!cached) throw new MorphPlanNotCachedError(payload.planId);
  const out = solveAndPackage(cached, payload.strengths, payload.computeHeatmaps === true);
  ctx.progress(1);
  return out;
};
