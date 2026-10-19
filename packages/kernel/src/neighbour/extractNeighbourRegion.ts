// packages/kernel/src/neighbour/extractNeighbourRegion.ts
//
// Phase 9 Task 3 (ADR-022 Decision 3): capture a proximal NEIGHBOUR from the
// case's own arch scan. The user picks the neighbour tooth (one click); this
// op cuts the part of the scan that can touch the restoration and returns it
// as a closed solid the contact measurements (anatomy/morph.ts,
// cavity/proximalContact.ts) can sign-test against — they require a
// watertight neighbour for the exact pseudonormal sign.
//
// ## The window (oriented by the restoration, never by world axes)
//
// With c = the margin-loop centroid, a = the insertion axis and s = the pick
// snapped onto the scan:
//
//  - approach direction n = (s − c) made orthogonal to a, normalized: from
//    the restoration toward the picked neighbour (`approach: 'occlusal'`, for
//    the antagonist: n = ±a, toward the pick — rule 2 then does not apply);
//  - separating plane ⟂ n at offset d = max(margin reach along n, ½(s − c)·n)
//    from c: never inside the restoration's own margin footprint, and at the
//    mid-point between restoration and pick when that lies further out;
//
// and a source triangle is CAPTURED iff (whole-triangle tests, all three
// vertices where a vertex test applies):
//
//  1. it lies strictly beyond the separating plane;
//  2. it is not apical to the cervical cut ((v − c)·a ≥ cervicalOffsetMm);
//  3. it lies inside the ball of `radiusMm` around s;
//  4. it FACES the restoration (unit face normal · (−n) ≥ minFacingCos) — a
//     tooth's own proximal wall faces away from its centre, so this alone
//     separates the restoration's proximal surface from the neighbour's at
//     a closed contact;
//  5. it is VISIBLE from the restoration side: a ray from its centroid along
//     −n hits no other triangle passing 1–4 (drops the far tooth hidden
//     behind the neighbour, and folds);
//  6. it belongs to the LARGEST-AREA edge-connected component of 1–5 (the
//     neighbour's facing surface; on a real scan the facing set also holds
//     small fragments — scan noise, a strip of a second tooth peeking past
//     the neighbour's edge), after pruning every triangle at a pinched
//     boundary vertex (so the closure below is a 2-manifold).
//
// ## The closure (synthetic, behind the captured surface)
//
// The captured surface is a height field over the separating plane (rule 5),
// so it closes into a prism-like solid: every vertex is projected along +n
// onto a back plane `closureDepthMm` behind the deepest captured vertex, the
// projected patch is the reversed back cap, and each border edge gets a wall
// quad parallel to n. The whole solid lies on the neighbour side of the
// separating plane. The result is validated (watertight, positive volume, no
// degenerate triangle, no self-intersection, halfedge-valid). The visibility
// rule tests centroids only, so a real scan can keep a small fold whose
// closure faces cross: every captured triangle implicated in such a face is
// dropped and the region rebuilt (`foldTrianglesDropped` reports how many),
// up to a bounded number of rounds; a region still invalid is REFUSED with
// `NeighbourRegionInvalidError` — never returned broken.
//
// @errorBound Zero positional error on the captured surface: scan vertices
// are copied verbatim (never interpolated), so any closest-point query whose
// answer lies on the captured surface is bit-identical to the same query on
// the full scan. The capture can MISS true neighbour surface only (a) outside
// the window (rules 1–6; their parameters are returned with the result), and
// (b) along the window border, by at most `windowBoundaryBandMm`: the longest
// edge of a source triangle dropped across a border edge (whole-triangle
// inclusion — no clipping). Border edges on the scan's own boundary have no
// dropped neighbour and add nothing (the scan holds no surface there). The
// closure (walls + back cap) is synthetic geometry and lies wholly behind the
// captured surface; it is reported via `capturedTriangleCount`.
//
// `.ts` extension: reachable from the Node worker entry's import closure.
import { buildBvh } from '../bvh/build.ts';
import { closestPoint } from '../bvh/closestPoint.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import type { Bvh } from '../bvh/types.ts';
import { raycast } from '../bvh/raycast.ts';
import { buildHalfedge } from '../halfedge/index.ts';
import { analyzeMesh } from '../intake/analyze.ts';
import {
  checkDegenerateTriangle,
  DEGENERATE_CROSS_NORM_SQ_THRESHOLD_MM4,
} from '../intake/degenerate.ts';
import { findSelfIntersections } from '../intersect/selfIntersect.ts';
import type { IndexedMesh } from '../mesh/types.ts';

/** Default ball radius around the pick (mm): reaches the proximal contact of
 * a molar neighbour (≈ 10 mm mesio-distal) picked at its occlusal centre. */
export const NEIGHBOUR_REGION_DEFAULT_RADIUS_MM = 6;
/** Default facing threshold: face normals within ≈ 84° of −n. */
export const NEIGHBOUR_REGION_DEFAULT_MIN_FACING_COS = 0.1;
/** Default cervical cut, relative to the margin centroid along the axis. */
export const NEIGHBOUR_REGION_DEFAULT_CERVICAL_OFFSET_MM = 0;
/** Default closure depth behind the deepest captured vertex (mm). */
export const NEIGHBOUR_REGION_DEFAULT_CLOSURE_DEPTH_MM = 2;
/** Visibility-ray origin offset off the triangle, along −n (mm) — 7 orders
 * of magnitude below the 1 µm clinical resolution. */
const VISIBILITY_RAY_OFFSET_MM = 1e-7;
/** Upper bound on closure fold-repair rounds before the region is refused. */
export const NEIGHBOUR_REGION_MAX_FOLD_REPAIR_ROUNDS = 64;

/** `proximal` (default): a mesial/distal neighbour, approached across the
 * insertion axis. `occlusal`: the antagonist, approached ALONG the axis
 * (toward the pick's side) — the cervical cut does not apply. */
export type NeighbourApproach = 'proximal' | 'occlusal';

export interface NeighbourRegionOptions {
  approach?: NeighbourApproach;
  radiusMm?: number;
  minFacingCos?: number;
  cervicalOffsetMm?: number;
  closureDepthMm?: number;
}

export interface NeighbourRegionResult {
  /** Watertight, outward-wound solid. Its first `capturedTriangleCount`
   * triangles are the captured scan surface (verbatim); the rest is the
   * synthetic closure. */
  mesh: IndexedMesh;
  capturedTriangleCount: number;
  /** Source triangle index of each captured triangle (ascending). */
  sourceTriangleIndices: Uint32Array;
  /** The pick, snapped onto the scan. */
  seedOnSurface: Vec3;
  /** n: unit, ⟂ axis, from the restoration toward the neighbour. */
  approachDirection: Vec3;
  separatingPlane: { point: Vec3; normal: Vec3 };
  capturedAreaMm2: number;
  /** @errorBound of the window border — see the module doc. */
  windowBoundaryBandMm: number;
  /** Captured triangles dropped because their closure faces self-intersected
   * (a fold the centroid visibility test let through) — disclosed. */
  foldTrianglesDropped: number;
  approach: NeighbourApproach;
  radiusMm: number;
  minFacingCos: number;
  cervicalOffsetMm: number;
  closureDepthMm: number;
}

/** The pick does not lie beyond the restoration's own margin footprint, so
 * it cannot be a neighbour. */
export class NeighbourSeedTooCloseError extends Error {
  readonly projectedDistanceMm: number;
  readonly marginReachMm: number;
  constructor(projectedDistanceMm: number, marginReachMm: number) {
    super(
      `extractNeighbourRegion: the pick is ${projectedDistanceMm.toFixed(3)} mm from the margin centroid ` +
        `across the insertion axis, inside the restoration's margin reach (${marginReachMm.toFixed(3)} mm) — pick the neighbour tooth`,
    );
    this.name = 'NeighbourSeedTooCloseError';
    this.projectedDistanceMm = projectedDistanceMm;
    this.marginReachMm = marginReachMm;
  }
}

/** No scan surface survives the window rules at the named stage. */
export class NeighbourRegionEmptyError extends Error {
  readonly stage: 'window' | 'visibility' | 'topology';
  constructor(stage: 'window' | 'visibility' | 'topology') {
    super(
      `extractNeighbourRegion: no scan surface facing the restoration survives the ${stage} rule — pick the neighbour closer to its contact, or widen the window`,
    );
    this.name = 'NeighbourRegionEmptyError';
    this.stage = stage;
  }
}

/** The closed region failed validation — refused, never returned broken. */
export class NeighbourRegionInvalidError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`extractNeighbourRegion: the closed neighbour region is invalid (${reason}) — refused`);
    this.name = 'NeighbourRegionInvalidError';
    this.reason = reason;
  }
}

function vertexOf(positions: Float64Array, v: number): Vec3 {
  return [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!];
}

function dotRel(p: Vec3, c: Vec3, n: Vec3): number {
  return (p[0] - c[0]) * n[0] + (p[1] - c[1]) * n[1] + (p[2] - c[2]) * n[2];
}

function positiveFinite(name: string, value: number): number {
  if (!(Number.isFinite(value) && value > 0)) {
    throw new RangeError(`extractNeighbourRegion: ${name} must be finite and > 0, got ${value}`);
  }
  return value;
}

/**
 * Captures the neighbour picked at `seed` from `mesh` (the arch scan; `bvh`
 * built over it) as a closed solid — see the module doc for the window
 * rules, the closure, and `@errorBound`. Pure and deterministic: every loop
 * runs in source-triangle order and every tie breaks to the lowest index.
 *
 * @throws {RangeError} invalid options, a margin loop with < 3 points, or a
 * zero insertion axis.
 * @throws {NeighbourSeedTooCloseError} the pick is inside the margin reach.
 * @throws {NeighbourRegionEmptyError} nothing survives the window.
 * @throws {NeighbourRegionInvalidError} the closed solid fails validation.
 */
export function extractNeighbourRegion(
  mesh: IndexedMesh,
  bvh: Bvh,
  seed: Vec3,
  marginLoop: readonly Vec3[],
  insertionAxis: Vec3,
  options: NeighbourRegionOptions = {},
): NeighbourRegionResult {
  const radiusMm = positiveFinite(
    'radiusMm',
    options.radiusMm ?? NEIGHBOUR_REGION_DEFAULT_RADIUS_MM,
  );
  const closureDepthMm = positiveFinite(
    'closureDepthMm',
    options.closureDepthMm ?? NEIGHBOUR_REGION_DEFAULT_CLOSURE_DEPTH_MM,
  );
  const minFacingCos = options.minFacingCos ?? NEIGHBOUR_REGION_DEFAULT_MIN_FACING_COS;
  if (!(Number.isFinite(minFacingCos) && minFacingCos >= 0 && minFacingCos < 1)) {
    throw new RangeError(
      `extractNeighbourRegion: minFacingCos must be in [0, 1), got ${minFacingCos}`,
    );
  }
  const approach = options.approach ?? 'proximal';
  if (approach !== 'proximal' && approach !== 'occlusal') {
    throw new RangeError(
      `extractNeighbourRegion: approach must be 'proximal' or 'occlusal', got ${String(approach)}`,
    );
  }
  const cervicalOffsetMm = options.cervicalOffsetMm ?? NEIGHBOUR_REGION_DEFAULT_CERVICAL_OFFSET_MM;
  if (!Number.isFinite(cervicalOffsetMm)) {
    throw new RangeError(
      `extractNeighbourRegion: cervicalOffsetMm must be finite, got ${cervicalOffsetMm}`,
    );
  }
  if (marginLoop.length < 3) {
    throw new RangeError(
      `extractNeighbourRegion: the margin loop needs >= 3 points, got ${marginLoop.length}`,
    );
  }
  const axisLen = Math.hypot(insertionAxis[0], insertionAxis[1], insertionAxis[2]);
  if (!(axisLen > 0) || !Number.isFinite(axisLen)) {
    throw new RangeError(
      'extractNeighbourRegion: the insertion axis must be a finite non-zero vector',
    );
  }
  const a: Vec3 = [
    insertionAxis[0] / axisLen,
    insertionAxis[1] / axisLen,
    insertionAxis[2] / axisLen,
  ];

  const { positions, indices } = mesh;
  const triangleCount = indices.length / 3;
  const vertexCount = positions.length / 3;

  // ---- frame: c, n, separating plane ------------------------------------
  const snapped = closestPoint(mesh, bvh, seed).point;
  const s: Vec3 = [snapped[0], snapped[1], snapped[2]];
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const p of marginLoop) {
    cx += p[0];
    cy += p[1];
    cz += p[2];
  }
  const c: Vec3 = [cx / marginLoop.length, cy / marginLoop.length, cz / marginLoop.length];
  const w: Vec3 = [s[0] - c[0], s[1] - c[1], s[2] - c[2]];
  const wa = w[0] * a[0] + w[1] * a[1] + w[2] * a[2];
  // Proximal: the pick's offset across the axis. Occlusal: along the axis,
  // signed toward the pick.
  const wp: Vec3 =
    approach === 'proximal'
      ? [w[0] - wa * a[0], w[1] - wa * a[1], w[2] - wa * a[2]]
      : [wa * a[0], wa * a[1], wa * a[2]];
  const projected = Math.hypot(wp[0], wp[1], wp[2]);
  let reach = 0;
  if (projected > 0) {
    const nTry: Vec3 = [wp[0] / projected, wp[1] / projected, wp[2] / projected];
    reach = -Infinity;
    for (const p of marginLoop) reach = Math.max(reach, dotRel(p, c, nTry));
  }
  if (!(projected > reach) || !(projected > 0))
    throw new NeighbourSeedTooCloseError(projected, reach);
  const n: Vec3 = [wp[0] / projected, wp[1] / projected, wp[2] / projected];
  const planeOffset = Math.max(reach, projected / 2);
  const planePoint: Vec3 = [
    c[0] + n[0] * planeOffset,
    c[1] + n[1] * planeOffset,
    c[2] + n[2] * planeOffset,
  ];

  // ---- rules 1–4: the window --------------------------------------------
  const radiusSq = radiusMm * radiusMm;
  const vertexInWindow = (v: number): boolean => {
    const p = vertexOf(positions, v);
    if (!(dotRel(p, c, n) > planeOffset)) return false;
    if (approach === 'proximal' && !(dotRel(p, c, a) >= cervicalOffsetMm)) return false;
    const dx = p[0] - s[0];
    const dy = p[1] - s[1];
    const dz = p[2] - s[2];
    return dx * dx + dy * dy + dz * dz <= radiusSq;
  };
  const candidates: number[] = [];
  for (let t = 0; t < triangleCount; t++) {
    const i0 = indices[t * 3]!;
    const i1 = indices[t * 3 + 1]!;
    const i2 = indices[t * 3 + 2]!;
    if (!vertexInWindow(i0) || !vertexInWindow(i1) || !vertexInWindow(i2)) continue;
    const p0 = vertexOf(positions, i0);
    const p1 = vertexOf(positions, i1);
    const p2 = vertexOf(positions, i2);
    const e1: Vec3 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const e2: Vec3 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
    const nx = e1[1] * e2[2] - e1[2] * e2[1];
    const ny = e1[2] * e2[0] - e1[0] * e2[2];
    const nz = e1[0] * e2[1] - e1[1] * e2[0];
    const lenSq = nx * nx + ny * ny + nz * nz;
    if (lenSq <= DEGENERATE_CROSS_NORM_SQ_THRESHOLD_MM4) continue;
    const facing = -(nx * n[0] + ny * n[1] + nz * n[2]) / Math.sqrt(lenSq);
    if (facing >= minFacingCos) candidates.push(t);
  }
  if (candidates.length === 0) throw new NeighbourRegionEmptyError('window');

  // ---- rule 5: visibility from the restoration side ---------------------
  const candidateMesh = compactSubmesh(mesh, candidates).mesh;
  const candidateBvh = buildBvh(candidateMesh);
  const toward: Vec3 = [-n[0], -n[1], -n[2]];
  const inSet = new Uint8Array(triangleCount);
  let visibleCount = 0;
  for (const t of candidates) {
    const g = triangleCentroid(positions, indices, t);
    const origin: Vec3 = [
      g[0] + toward[0] * VISIBILITY_RAY_OFFSET_MM,
      g[1] + toward[1] * VISIBILITY_RAY_OFFSET_MM,
      g[2] + toward[2] * VISIBILITY_RAY_OFFSET_MM,
    ];
    if (raycast(candidateMesh, candidateBvh, origin, toward) === null) {
      inSet[t] = 1;
      visibleCount++;
    }
  }
  if (visibleCount === 0) throw new NeighbourRegionEmptyError('visibility');

  // ---- rule 6 + closure, with fold repair -------------------------------
  // The visibility rule tests triangle centroids only, so a real scan can
  // keep a fold whose closure walls cross the surface. Every captured
  // triangle implicated in a self-intersecting (or degenerate) closure face
  // is dropped and the component / closure rebuilt, to a fixed point; the
  // dropped count is reported, and the dropped triangles border the final
  // window, so the border band covers them.
  let closed: ClosedRegion | null = null;
  let patch: number[] = [];
  let foldTrianglesDropped = 0;
  for (
    let round = 0;
    round <= NEIGHBOUR_REGION_MAX_FOLD_REPAIR_ROUNDS && closed === null;
    round++
  ) {
    patch = largestComponentWithoutPinches(mesh, inSet, candidates, vertexCount);
    if (patch.length === 0) throw new NeighbourRegionEmptyError('topology');
    const attempt = closeRegion(mesh, patch, c, n, closureDepthMm);
    if (attempt.offending.size === 0) {
      closed = attempt;
      break;
    }
    for (const local of attempt.offending) inSet[patch[local]!] = 0;
    foldTrianglesDropped += attempt.offending.size;
  }
  if (closed === null) {
    throw new NeighbourRegionInvalidError(
      `closure still self-intersecting after ${NEIGHBOUR_REGION_MAX_FOLD_REPAIR_ROUNDS} fold-repair rounds`,
    );
  }
  const { solid, remap, borderEdges } = closed;
  const surfaceVertexCount = remap.size;

  // ---- @errorBound: the window-border band ------------------------------
  const sourceVertexOf = new Int32Array(surfaceVertexCount);
  for (const [src, dst] of remap) sourceVertexOf[dst] = src;
  const windowBoundaryBandMm = borderBand(
    mesh,
    patch,
    borderEdges,
    sourceVertexOf,
    s,
    radiusSq,
    vertexCount,
  );

  let capturedAreaMm2 = 0;
  for (const t of patch) capturedAreaMm2 += triangleArea(positions, indices, t);

  return {
    mesh: solid,
    capturedTriangleCount: patch.length,
    sourceTriangleIndices: Uint32Array.from(patch),
    seedOnSurface: s,
    approachDirection: n,
    separatingPlane: { point: planePoint, normal: [n[0], n[1], n[2]] },
    capturedAreaMm2,
    windowBoundaryBandMm,
    foldTrianglesDropped,
    approach,
    radiusMm,
    minFacingCos,
    cervicalOffsetMm,
    closureDepthMm,
  };
}

function triangleCentroid(positions: Float64Array, indices: Uint32Array, t: number): Vec3 {
  const p0 = vertexOf(positions, indices[t * 3]!);
  const p1 = vertexOf(positions, indices[t * 3 + 1]!);
  const p2 = vertexOf(positions, indices[t * 3 + 2]!);
  return [(p0[0] + p1[0] + p2[0]) / 3, (p0[1] + p1[1] + p2[1]) / 3, (p0[2] + p1[2] + p2[2]) / 3];
}

function triangleArea(positions: Float64Array, indices: Uint32Array, t: number): number {
  const p0 = vertexOf(positions, indices[t * 3]!);
  const p1 = vertexOf(positions, indices[t * 3 + 1]!);
  const p2 = vertexOf(positions, indices[t * 3 + 2]!);
  const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
  return (
    Math.hypot(
      e1[1]! * e2[2]! - e1[2]! * e2[1]!,
      e1[2]! * e2[0]! - e1[0]! * e2[2]!,
      e1[0]! * e2[1]! - e1[1]! * e2[0]!,
    ) / 2
  );
}

function longestEdge(positions: Float64Array, indices: Uint32Array, t: number): number {
  let longest = 0;
  for (let k = 0; k < 3; k++) {
    const p = vertexOf(positions, indices[t * 3 + k]!);
    const q = vertexOf(positions, indices[t * 3 + ((k + 1) % 3)]!);
    longest = Math.max(longest, Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]));
  }
  return longest;
}

/** Verbatim submesh of `triangles` (ascending), vertices in first-seen order. */
function compactSubmesh(
  mesh: IndexedMesh,
  triangles: readonly number[],
): { mesh: IndexedMesh; remap: Map<number, number> } {
  const remap = new Map<number, number>();
  const positions: number[] = [];
  const indices = new Uint32Array(triangles.length * 3);
  let w = 0;
  for (const t of triangles) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[t * 3 + k]!;
      let id = remap.get(v);
      if (id === undefined) {
        id = positions.length / 3;
        positions.push(
          mesh.positions[v * 3]!,
          mesh.positions[v * 3 + 1]!,
          mesh.positions[v * 3 + 2]!,
        );
        remap.set(v, id);
      }
      indices[w++] = id;
    }
  }
  return { mesh: { positions: Float64Array.from(positions), indices }, remap };
}

/**
 * The largest-area edge-connected component of `inSet` (ties → the one
 * holding the lowest triangle index), with every triangle at a pinched border
 * vertex (> 1 outgoing border edge) or on an edge shared by > 2 set triangles
 * pruned, iterated to a fixed point. Returns ascending source triangle
 * indices. Mutates `inSet`.
 */
function largestComponentWithoutPinches(
  mesh: IndexedMesh,
  inSet: Uint8Array,
  candidates: readonly number[],
  vertexCount: number,
): number[] {
  const { positions, indices } = mesh;
  for (;;) {
    // Undirected edge → set triangles.
    const byEdge = new Map<number, number[]>();
    const undirected = (u: number, v: number): number =>
      u < v ? u * vertexCount + v : v * vertexCount + u;
    for (const t of candidates) {
      if (inSet[t] !== 1) continue;
      for (let k = 0; k < 3; k++) {
        const key = undirected(indices[t * 3 + k]!, indices[t * 3 + ((k + 1) % 3)]!);
        const list = byEdge.get(key);
        if (list) list.push(t);
        else byEdge.set(key, [t]);
      }
    }
    // Every component, in order of its lowest triangle index.
    const label = new Map<number, number>();
    let bestLabel = -1;
    let bestArea = -1;
    let labelCount = 0;
    for (const seed of candidates) {
      if (inSet[seed] !== 1 || label.has(seed)) continue;
      const id = labelCount++;
      label.set(seed, id);
      const queue = [seed];
      let area = 0;
      for (let head = 0; head < queue.length; head++) {
        const t = queue[head]!;
        area += triangleArea(positions, indices, t);
        for (let k = 0; k < 3; k++) {
          for (const other of byEdge.get(
            undirected(indices[t * 3 + k]!, indices[t * 3 + ((k + 1) % 3)]!),
          ) ?? []) {
            if (!label.has(other)) {
              label.set(other, id);
              queue.push(other);
            }
          }
        }
      }
      if (area > bestArea) {
        bestArea = area;
        bestLabel = id;
      }
    }
    if (bestLabel < 0) return [];
    const inComponent = { has: (t: number): boolean => label.get(t) === bestLabel };
    const component = candidates.filter((t) => inComponent.has(t));

    // Pinches within the component.
    const directed = new Set<number>();
    for (const t of component) {
      for (let k = 0; k < 3; k++)
        directed.add(indices[t * 3 + k]! * vertexCount + indices[t * 3 + ((k + 1) % 3)]!);
    }
    const outgoingBorder = new Map<number, number>();
    const overShared = new Set<number>();
    for (const t of component) {
      for (let k = 0; k < 3; k++) {
        const u = indices[t * 3 + k]!;
        const v = indices[t * 3 + ((k + 1) % 3)]!;
        if ((byEdge.get(undirected(u, v))?.length ?? 0) > 2) overShared.add(t);
        if (!directed.has(v * vertexCount + u))
          outgoingBorder.set(u, (outgoingBorder.get(u) ?? 0) + 1);
      }
    }
    const pinched = new Set<number>();
    for (const [v, count] of outgoingBorder) if (count > 1) pinched.add(v);
    let pruned = false;
    for (const t of component) {
      const touches =
        pinched.has(indices[t * 3]!) ||
        pinched.has(indices[t * 3 + 1]!) ||
        pinched.has(indices[t * 3 + 2]!);
      if (touches || overShared.has(t)) {
        inSet[t] = 0;
        pruned = true;
      }
    }
    if (!pruned) return component;
    // Re-run on the pruned set (other components stay eligible: the nearest
    // component may change once the current one is pruned away entirely).
  }
}

interface ClosedRegion {
  solid: IndexedMesh;
  /** Source vertex → surface-local vertex. */
  remap: Map<number, number>;
  /** Surface-local border edges (u → v, as wound in their patch triangle). */
  borderEdges: Array<[number, number]>;
  /** Patch-local indices of captured triangles whose closure faces
   * self-intersect or are degenerate (empty ⇒ the solid is valid). */
  offending: Set<number>;
}

/**
 * Closes `patch` into a prism-like solid (see the module doc) and validates
 * it. Repairable defects (self-intersecting or degenerate faces) are returned
 * as `offending` patch triangles; anything else is refused.
 */
function closeRegion(
  mesh: IndexedMesh,
  patch: readonly number[],
  c: Vec3,
  n: Vec3,
  closureDepthMm: number,
): ClosedRegion {
  const { mesh: surface, remap } = compactSubmesh(mesh, patch);
  const surfaceVertexCount = surface.positions.length / 3;
  let deepest = -Infinity;
  for (let v = 0; v < surfaceVertexCount; v++)
    deepest = Math.max(deepest, dotRel(vertexOf(surface.positions, v), c, n));
  const backOffset = deepest + closureDepthMm;
  const solidPositions = new Float64Array(surfaceVertexCount * 6);
  solidPositions.set(surface.positions, 0);
  for (let v = 0; v < surfaceVertexCount; v++) {
    const p = vertexOf(surface.positions, v);
    const push = backOffset - dotRel(p, c, n);
    solidPositions[(surfaceVertexCount + v) * 3] = p[0] + n[0] * push;
    solidPositions[(surfaceVertexCount + v) * 3 + 1] = p[1] + n[1] * push;
    solidPositions[(surfaceVertexCount + v) * 3 + 2] = p[2] + n[2] * push;
  }
  const back = (v: number): number => surfaceVertexCount + v;
  const directed = new Set<number>();
  const edgeKey = (u: number, v: number): number => u * surfaceVertexCount + v;
  for (let i = 0; i < surface.indices.length; i += 3) {
    for (let k = 0; k < 3; k++)
      directed.add(edgeKey(surface.indices[i + k]!, surface.indices[i + ((k + 1) % 3)]!));
  }
  const solidIndices: number[] = Array.from(surface.indices);
  // The patch-local triangle each solid face closes (its owner).
  const owner: number[] = [];
  for (let i = 0; i < patch.length; i++) owner.push(i);
  const borderEdges: Array<[number, number]> = [];
  for (let i = 0; i < surface.indices.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const u = surface.indices[i + k]!;
      const v = surface.indices[i + ((k + 1) % 3)]!;
      if (directed.has(edgeKey(v, u))) continue;
      borderEdges.push([u, v]);
      solidIndices.push(v, u, back(u), v, back(u), back(v));
      owner.push(i / 3, i / 3);
    }
  }
  for (let i = 0; i < surface.indices.length; i += 3) {
    solidIndices.push(
      back(surface.indices[i]!),
      back(surface.indices[i + 2]!),
      back(surface.indices[i + 1]!),
    );
    owner.push(i / 3);
  }
  const solid: IndexedMesh = { positions: solidPositions, indices: Uint32Array.from(solidIndices) };

  const stats = analyzeMesh(solid);
  if (!stats.watertight) throw new NeighbourRegionInvalidError('not watertight');
  const offending = new Set<number>();
  if (stats.degenerateCount > 0) {
    for (let t = 0; t < owner.length; t++) {
      if (checkDegenerateTriangle(solid, t).degenerate) offending.add(owner[t]!);
    }
  }
  findSelfIntersections(solid, {
    onIntersectingPair: (a, b) => {
      offending.add(owner[a]!);
      offending.add(owner[b]!);
    },
  });
  if (offending.size > 0) return { solid, remap, borderEdges, offending };
  if (!(stats.signedVolumeMm3 !== null && stats.signedVolumeMm3 > 0)) {
    throw new NeighbourRegionInvalidError('non-positive enclosed volume');
  }
  try {
    buildHalfedge(solid);
  } catch (error) {
    throw new NeighbourRegionInvalidError(`halfedge: ${(error as Error).message}`);
  }
  return { solid, remap, borderEdges, offending };
}

/** Longest edge of any source triangle dropped across a captured border
 * edge (see the module's `@errorBound`). */
function borderBand(
  mesh: IndexedMesh,
  patch: readonly number[],
  borderEdges: ReadonlyArray<readonly [number, number]>,
  sourceVertexOf: Int32Array,
  s: Vec3,
  radiusSq: number,
  vertexCount: number,
): number {
  const { positions, indices } = mesh;
  const triangleCount = indices.length / 3;
  const near = (v: number): boolean => {
    const dx = positions[v * 3]! - s[0];
    const dy = positions[v * 3 + 1]! - s[1];
    const dz = positions[v * 3 + 2]! - s[2];
    return dx * dx + dy * dy + dz * dz <= radiusSq;
  };
  const owner = new Map<number, number>();
  for (let t = 0; t < triangleCount; t++) {
    if (!near(indices[t * 3]!) && !near(indices[t * 3 + 1]!) && !near(indices[t * 3 + 2]!))
      continue;
    for (let k = 0; k < 3; k++) {
      const key = indices[t * 3 + k]! * vertexCount + indices[t * 3 + ((k + 1) % 3)]!;
      if (!owner.has(key)) owner.set(key, t);
    }
  }
  const captured = new Set(patch);
  let band = 0;
  for (const [u, v] of borderEdges) {
    const across = owner.get(sourceVertexOf[v]! * vertexCount + sourceVertexOf[u]!);
    if (across === undefined || captured.has(across)) continue;
    band = Math.max(band, longestEdge(positions, indices, across));
  }
  return band;
}
