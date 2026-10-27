// packages/kernel/src/die/extractPrepDie.ts
//
// Phase 10 Task 1 (ADR-023 Decision 1): a CLOSED prep die extracted from the
// case's own scan, which is usually an OPEN intraoral surface. Two crown steps
// need a closed die, and they need the prep alone:
//
//  - the intaglio's signed-distance field (sdf/pseudonormals.ts refuses any
//    boundary edge);
//  - the seating gate's `crown ∩ die` (the manifold wrapper needs closed
//    operands; with the whole arch it would also count the proximal contacts).
//
// ## The kept scan surface (verbatim)
//
// In the insertion-axis frame (axis = +h, the "height"), with M the margin
// polygon projected along the axis and H the lowest margin height, a scan
// triangle is a CANDIDATE iff all three vertices
//
//  1. project inside M or within `radialSkirtMm` of it (the footprint follows
//     the margin, not a circle, so the neighbours stay out), and
//  2. lie at height ≥ H − `depthSkirtMm`.
//
// The die surface is the largest-area edge-connected component of the
// candidates, with every triangle at a pinched rim vertex pruned (so the rim is
// a 2-manifold boundary). It must be bounded by exactly ONE loop, and every
// margin point must lie on it. Kept triangles are copied verbatim, never
// clipped or moved: any query answered on the kept surface is bit-identical
// to the same query on the scan.
//
// ## The synthetic closure
//
// Each rim vertex is dropped along −axis onto the FLOOR plane, `floorGapMm`
// below the lowest kept vertex. Each rim edge gets a wall quad (two
// triangles) and the dropped rim polygon is ear-clipped into a planar floor
// cap.
//
// A scan that is ALREADY CLOSED within the skirts (a die scanned on its own,
// trimmed close below the margin — the Phase 4 dies) has no rim: the kept
// surface is the die, unchanged, with no synthetic part (`floorHeightMm` is
// `null` and the certificate is `Infinity`). It is still validated; a
// degenerate or self-intersecting closed scan is refused, never cut open.
//
// A real scan can FOLD at the rim (the surface turns under itself along the
// axis — arch-case-01 tooth 12 does): the rim then does not project to a
// simple polygon, or a wall crosses the kept surface. Every kept triangle
// implicated (owning a crossing rim edge, or a face of a degenerate or
// self-intersecting closure pair) is dropped and the region rebuilt, to a
// fixed point within `PREP_DIE_MAX_FOLD_REPAIR_ROUNDS`; the count is
// returned (`foldTrianglesDropped`). The certificate is measured on the final
// rim, so it covers the dropped triangles. The solid is then validated: watertight, edge-manifold, one component,
// no degenerate triangle, no self-intersection (the geometric scan), positive
// volume, halfedge-valid. Any failure throws `PrepDieInvalidError`; a broken
// die is never returned.
//
// ## The clearance certificate
//
// The PROTECTED prism P is every point whose projection lies inside M or
// within `protectBandMm` of it, at height ≥ H. The intaglio reads the die only
// from cells inside P (its footprint mask is M plus its crop band, which the
// caller keeps ≤ `protectBandMm`, above the margin). The certificate is a
// LOWER BOUND on the distance from every synthetic triangle to P:
//
//  - a wall quad over rim edge (u, v): its points project onto the 2-D segment
//    uv and sit no higher than max(h_u, h_v). With L = the exact 2-D distance
//    from uv to M (0 if they meet or uv is inside), minus `protectBandMm`,
//    floored at 0, and V = max(0, H − max(h_u, h_v)), every wall point is at
//    least √(L² + V²) from P;
//  - the floor: every point is H − floor below P.
//
// Any cell of P closer to the die than the certificate therefore has its
// closest feature on the kept scan surface, so the intaglio near its iso
// surface is a function of the patient's scan alone. The die is a genuine
// closed solid, so the sign of every cell, deep inside or not, is right by
// construction. The caller states the clearance it needs
// (`requiredClearanceMm`); a smaller certificate throws
// `PrepDieClearanceError` with the measured value.
//
// @errorBound Zero positional error on the kept surface (verbatim scan
// vertices). The kept region can miss scan surface only outside the skirts,
// whose values are returned. The closure is synthetic geometry, provably at
// least `clearanceMm` (a lower bound, exact for the closed-form fixture) from
// the protected prism.
//
// `.ts` extension: reachable from the Node worker entry's import closure.
import { buildBvh } from '../bvh/build.ts';
import { closestPoint } from '../bvh/closestPoint.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import { buildHalfedge } from '../halfedge/build.ts';
import { destinationVertex, findBoundaryLoops } from '../halfedge/iterate.ts';
import { analyzeMesh } from '../intake/analyze.ts';
import { checkDegenerateTriangle, DEGENERATE_CROSS_NORM_SQ_THRESHOLD_MM4 } from '../intake/degenerate.ts';
import { findSelfIntersections } from '../intersect/selfIntersect.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import {
  compactSubmesh,
  largestComponentWithoutPinches,
} from '../neighbour/extractNeighbourRegion.ts';
import {
  applyR,
  axisFrame,
  dedupLoop,
  distSqToPolyline2d,
  innerSurfaceCropBandMm,
  MARGIN_DEDUP_EPSILON_MM,
  pointInPolygon2d,
} from '../offset/innerSurfaceSolid.ts';

/** Default radial skirt beyond the margin polygon (mm): the shoulder or
 * chamfer, the sulcus and some gingiva — enough for a wall clear of the
 * protect band, short of a neighbour (an interproximal space is rarely
 * narrower than ~1.5 mm at the margin level). An ALGORITHMIC default. */
export const PREP_DIE_DEFAULT_RADIAL_SKIRT_MM = 1.5;
/** Default depth below the lowest margin point (mm). */
export const PREP_DIE_DEFAULT_DEPTH_SKIRT_MM = 1.0;
/** Default lateral band of the protected prism around the margin polygon
 * (mm): the intaglio's crop band is the larger gap plus three pitches, so
 * 0.5 mm covers every pitch up to 0.15 mm with a 50 µm gap. */
export const PREP_DIE_DEFAULT_PROTECT_BAND_MM = 0.5;
/** Default floor drop below the lowest kept vertex (mm). */
export const PREP_DIE_DEFAULT_FLOOR_GAP_MM = 0.5;
/** Default required clearance (mm): the larger gap (50 µm) plus four
 * pitches of 50 µm. A caller with other values passes its own. */
export const PREP_DIE_DEFAULT_REQUIRED_CLEARANCE_MM = 0.25;
/** A margin point lies on the kept surface when it is within this distance of
 * it (mm): 0.1 µm, an order of magnitude below the 1 µm display resolution
 * and far above the Float64 noise of a point computed on a scan triangle. */
export const PREP_DIE_MARGIN_ON_SURFACE_TOLERANCE_MM = 1e-4;

export interface PrepDieOptions {
  radialSkirtMm?: number;
  depthSkirtMm?: number;
  protectBandMm?: number;
  floorGapMm?: number;
  requiredClearanceMm?: number;
}

export interface PrepDieResult {
  /** The closed, outward-wound die. Its first `keptTriangleCount` triangles
   * are the scan surface (verbatim); the rest is the synthetic closure. */
  mesh: IndexedMesh;
  keptTriangleCount: number;
  syntheticTriangleCount: number;
  /** Source scan triangle of each kept triangle (ascending). */
  sourceTriangleIndices: Uint32Array;
  rimVertexCount: number;
  /** Kept triangles dropped at a rim fold (see the module doc) — disclosed. */
  foldTrianglesDropped: number;
  /** The certificate: a lower bound on the distance from the synthetic
   * closure to the protected prism (mm) — see the module doc. */
  clearanceMm: number;
  /** Heights are measured along the unit insertion axis from the origin.
   * `floorHeightMm` is `null` when the kept surface is already closed (see
   * the module doc) — then `clearanceMm` is `Infinity`. */
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

/** The kept region is unusable: `reason` names the rule. */
export class PrepDieRegionError extends Error {
  readonly reason: 'empty' | 'margin-off-region' | 'rim-loops';
  constructor(reason: 'empty' | 'margin-off-region' | 'rim-loops', detail: string) {
    super(`extractPrepDie: ${detail}`);
    this.name = 'PrepDieRegionError';
    this.reason = reason;
  }
}

/** The closed die failed validation — refused, never returned broken. */
export class PrepDieInvalidError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`extractPrepDie: the closed die is invalid (${reason}) — refused`);
    this.name = 'PrepDieInvalidError';
    this.reason = reason;
  }
}

/** The synthetic closure is not provably clear of the protected prism. */
export class PrepDieClearanceError extends Error {
  readonly clearanceMm: number;
  readonly requiredMm: number;
  constructor(clearanceMm: number, requiredMm: number) {
    super(
      `extractPrepDie: the die's synthetic closure is only ${clearanceMm.toFixed(4)} mm from the region the ` +
        `intaglio reads (required ${requiredMm.toFixed(4)} mm) — the scan does not cover enough surface around the margin`,
    );
    this.name = 'PrepDieClearanceError';
    this.clearanceMm = clearanceMm;
    this.requiredMm = requiredMm;
  }
}

/** The die's certificate does not cover the intaglio about to be built on it:
 * its clearance is short of the need (`'clearance'`), or its protected prism
 * is narrower than the intaglio's crop band (`'protect-band'`). */
export class PrepDieCoverageError extends Error {
  readonly reason: 'clearance' | 'protect-band';
  readonly measuredMm: number;
  readonly requiredMm: number;
  constructor(reason: 'clearance' | 'protect-band', measuredMm: number, requiredMm: number) {
    super(
      reason === 'clearance'
        ? `extractPrepDie: the die's certified clearance ${measuredMm.toFixed(4)} mm is short of the ` +
            `${requiredMm.toFixed(4)} mm this intaglio needs (the larger gap plus four pitches) — use a finer pitch or a wider skirt`
        : `extractPrepDie: the die's protected band ${measuredMm.toFixed(4)} mm is narrower than this intaglio's ` +
            `crop band ${requiredMm.toFixed(4)} mm — use a finer pitch`,
    );
    this.name = 'PrepDieCoverageError';
    this.reason = reason;
    this.measuredMm = measuredMm;
    this.requiredMm = requiredMm;
  }
}

/**
 * What an intaglio with these gaps, at this pitch, needs of the die it is
 * built on (see the module doc's certificate):
 *
 *  - `cropBandMm`: its field is sampled within the crop band of the margin
 *    polygon (`innerSurfaceCropBandMm`), so the protected prism must be at
 *    least that wide;
 *  - `requiredClearanceMm`: the larger gap plus four pitches. The iso
 *    surface lies at most the larger gap from the die, and a marching-cubes
 *    corner that takes part in it is within √3 pitches of the iso surface;
 *    the blockout's running minimum only carries values down a column that
 *    are already that close. Every such corner is therefore nearer the die
 *    than the larger gap plus two pitches, and a clearance beyond that makes
 *    its closest feature a kept scan feature. Four pitches leave a margin of
 *    two.
 */
export function prepDieInnerSurfaceNeeds(
  gaps: { readonly marginalGapMm: number; readonly cementGapMm: number },
  pitchMm: number,
): { cropBandMm: number; requiredClearanceMm: number } {
  const maxGapMm = Math.max(gaps.marginalGapMm, gaps.cementGapMm);
  return { cropBandMm: innerSurfaceCropBandMm(maxGapMm, pitchMm), requiredClearanceMm: maxGapMm + 4 * pitchMm };
}

/**
 * Refuses an intaglio the die's certificate does not cover — see
 * `prepDieInnerSurfaceNeeds`. A die with no synthetic part (clearance
 * `Infinity`) covers every intaglio laterally too: nothing synthetic exists to
 * be read.
 *
 * @throws {PrepDieCoverageError} with the measured and the required value.
 */
export function assertPrepDieCoversInnerSurface(
  certificate: { readonly clearanceMm: number; readonly protectBandMm: number },
  gaps: { readonly marginalGapMm: number; readonly cementGapMm: number },
  pitchMm: number,
): void {
  const needs = prepDieInnerSurfaceNeeds(gaps, pitchMm);
  if (certificate.clearanceMm === Infinity) return;
  if (!(certificate.clearanceMm >= needs.requiredClearanceMm)) {
    throw new PrepDieCoverageError('clearance', certificate.clearanceMm, needs.requiredClearanceMm);
  }
  if (!(certificate.protectBandMm >= needs.cropBandMm)) {
    throw new PrepDieCoverageError('protect-band', certificate.protectBandMm, needs.cropBandMm);
  }
}

function positiveFinite(name: string, value: number): number {
  if (!(Number.isFinite(value) && value > 0)) {
    throw new RangeError(`extractPrepDie: ${name} must be finite and > 0, got ${value}`);
  }
  return value;
}

type P2 = [number, number];

/** Squared distance (mm²) within which a polygon vertex blocks a floor-cap
 * ear: 1 nm, the kernel's coplanarity scale (intersect/triangleTriangle.ts). */
const EAR_BLOCK_DISTANCE_SQ_MM2 = 1e-6 * 1e-6;

function cross2(o: P2, a: P2, b: P2): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function segmentsIntersect2d(a: P2, b: P2, c: P2, d: P2): boolean {
  const d1 = cross2(c, d, a);
  const d2 = cross2(c, d, b);
  const d3 = cross2(a, b, c);
  const d4 = cross2(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const onSeg = (p: P2, q: P2, r: P2): boolean =>
    Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  return (
    (d1 === 0 && onSeg(c, d, a)) ||
    (d2 === 0 && onSeg(c, d, b)) ||
    (d3 === 0 && onSeg(a, b, c)) ||
    (d4 === 0 && onSeg(a, b, d))
  );
}

function pointSegmentDistSq2d(p: P2, a: P2, b: P2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const ex = a[0] + t * dx - p[0];
  const ey = a[1] + t * dy - p[1];
  return ex * ex + ey * ey;
}

/** Exact 2-D distance from segment ab to the polygon region (0 when ab
 * touches or lies inside it). */
function segmentPolygonDistance2d(a: P2, b: P2, poly: readonly P2[]): number {
  if (pointInPolygon2d(a[0], a[1], poly) || pointInPolygon2d(b[0], b[1], poly)) return 0;
  let best = Infinity;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const c = poly[i]!;
    const d = poly[(i + 1) % n]!;
    if (segmentsIntersect2d(a, b, c, d)) return 0;
    best = Math.min(
      best,
      pointSegmentDistSq2d(a, c, d),
      pointSegmentDistSq2d(b, c, d),
      pointSegmentDistSq2d(c, a, b),
      pointSegmentDistSq2d(d, a, b),
    );
  }
  return Math.sqrt(best);
}

/**
 * Ear-clips a simple 2-D polygon (either winding) into triangles of positive
 * area in the polygon's own winding order. Strict: a vertex on a candidate
 * ear blocks it, a sliver ear (cross² ≤ the intake degenerate threshold) is
 * never cut, and a stall throws — the floor cap is refused, never faked.
 */
function earClipStrict(points: readonly P2[]): Array<[number, number, number]> {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const q = points[(i + 1) % points.length]!;
    area += p[0] * q[1] - q[0] * p[1];
  }
  const ccw = area > 0;
  const idx = points.map((_, i) => i);
  if (!ccw) idx.reverse();
  const out: Array<[number, number, number]> = [];
  const isEar = (a: number, b: number, c: number): boolean => {
    const pa = points[a]!;
    const pb = points[b]!;
    const pc = points[c]!;
    const cr = cross2(pa, pb, pc);
    if (!(cr > 0) || cr * cr <= DEGENERATE_CROSS_NORM_SQ_THRESHOLD_MM4) return false;
    for (const j of idx) {
      if (j === a || j === b || j === c) continue;
      const p = points[j]!;
      if (cross2(pa, pb, p) >= 0 && cross2(pb, pc, p) >= 0 && cross2(pc, pa, p) >= 0) return false;
      // A vertex just outside the ear, on (or a hair off) its diagonal, also
      // blocks it: cutting that ear would leave the vertex as a sliver.
      if (
        Math.min(pointSegmentDistSq2d(p, pa, pb), pointSegmentDistSq2d(p, pb, pc), pointSegmentDistSq2d(p, pc, pa)) <=
        EAR_BLOCK_DISTANCE_SQ_MM2
      ) {
        return false;
      }
    }
    return true;
  };
  let i = 0;
  let sinceCut = 0;
  while (idx.length > 3) {
    const len = idx.length;
    const a = idx[(i + len - 1) % len]!;
    const b = idx[i % len]!;
    const c = idx[(i + 1) % len]!;
    if (isEar(a, b, c)) {
      out.push(ccw ? [a, b, c] : [a, c, b]);
      idx.splice(i % len, 1);
      sinceCut = 0;
      if (i >= idx.length) i = 0;
      continue;
    }
    i = (i + 1) % len;
    if (++sinceCut > len) throw new PrepDieInvalidError('the floor cap cannot be triangulated (the rim does not project to a simple polygon)');
  }
  const [a, b, c] = idx as [number, number, number];
  const cr = cross2(points[a]!, points[b]!, points[c]!);
  if (!(cr > 0) || cr * cr <= DEGENERATE_CROSS_NORM_SQ_THRESHOLD_MM4) {
    throw new PrepDieInvalidError('the floor cap cannot be triangulated (degenerate last ear)');
  }
  out.push(ccw ? [a, b, c] : [a, c, b]);
  return out;
}

/** Upper bound on rim fold-repair rounds before the die is refused. */
export const PREP_DIE_MAX_FOLD_REPAIR_ROUNDS = 64;

interface ClosedDie {
  mesh: IndexedMesh;
  surface: IndexedMesh;
  /** Surface-local rim edges (u → v, as wound in their kept triangle). */
  rimEdges: Array<[number, number]>;
  rimVertexCount: number;
  /** Surface-local vertex → scan vertex. */
  sourceOf: Int32Array;
  /** `null` when the kept surface is already closed (no floor). */
  floorHeightMm: number | null;
  /** Patch-local kept triangles implicated in a fold (empty ⇒ valid). */
  offending: Set<number>;
}

/**
 * Closes the kept `patch` (walls down to the floor plane, ear-clipped floor
 * cap) and checks it. Repairable defects — rim edges crossing in projection,
 * degenerate or self-intersecting faces — are returned as `offending` kept
 * triangles; anything else throws.
 */
function closeDie(
  scan: IndexedMesh,
  patch: readonly number[],
  rot: Float64Array,
  axis: Vec3,
  floorGapMm: number,
): ClosedDie {
  const { mesh: surface, remap } = compactSubmesh(scan, patch);
  const hm = buildHalfedge(surface);
  const heLoops = findBoundaryLoops(hm);
  const surfaceVertexCount = surface.positions.length / 3;
  const sourceOf = new Int32Array(surfaceVertexCount);
  for (const [src, dst] of remap) sourceOf[dst] = src;
  if (heLoops.length === 0) {
    // Already closed within the skirts (a die scanned on its own): the kept
    // surface IS the die. Nothing synthetic, so nothing to repair — a scan
    // defect here is refused, never cut open.
    const stats = analyzeMesh(surface);
    if (stats.degenerateCount > 0) throw new PrepDieInvalidError(`${stats.degenerateCount} degenerate triangle(s) in the closed scan`);
    let pairs = 0;
    findSelfIntersections(surface, { onIntersectingPair: () => void pairs++ });
    if (pairs > 0) throw new PrepDieInvalidError(`${pairs} self-intersecting triangle pair(s) in the closed scan`);
    return { mesh: surface, surface, rimEdges: [], rimVertexCount: 0, sourceOf, floorHeightMm: null, offending: new Set() };
  }
  if (heLoops.length !== 1) {
    throw new PrepDieRegionError(
      'rim-loops',
      `the kept scan surface is bounded by ${heLoops.length} loops, not one (a hole in the scan near the prep?)`,
    );
  }
  const heLoop = heLoops[0]!;
  const rim = heLoop.map((he) => destinationVertex(hm, he));
  const heightOf = (local: number): number => rot[sourceOf[local]! * 3 + 2]!;
  let lowest = Infinity;
  for (let v = 0; v < surfaceVertexCount; v++) lowest = Math.min(lowest, heightOf(v));
  const floorHeightMm = lowest - floorGapMm;
  const offending = new Set<number>();

  // Rim edges crossing in projection (edge i runs rim[i − 1] → rim[i]).
  const rim2d: P2[] = rim.map((v) => [rot[sourceOf[v]! * 3]!, rot[sourceOf[v]! * 3 + 1]!]);
  const n = rim.length;
  for (let i = 0; i < n; i++) {
    const a = rim2d[(i + n - 1) % n]!;
    const b = rim2d[i]!;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsIntersect2d(a, b, rim2d[(j + n - 1) % n]!, rim2d[j]!)) {
        offending.add(hm.face[heLoop[i]!]!);
        offending.add(hm.face[heLoop[j]!]!);
      }
    }
  }
  if (offending.size > 0) {
    return { mesh: surface, surface, rimEdges: [], rimVertexCount: n, sourceOf, floorHeightMm, offending };
  }

  const back = new Int32Array(surfaceVertexCount).fill(-1);
  const solidPositions: number[] = Array.from(surface.positions);
  for (const v of rim) {
    const drop = heightOf(v) - floorHeightMm;
    back[v] = solidPositions.length / 3;
    solidPositions.push(
      surface.positions[v * 3]! - axis[0] * drop,
      surface.positions[v * 3 + 1]! - axis[1] * drop,
      surface.positions[v * 3 + 2]! - axis[2] * drop,
    );
  }
  const solidIndices: number[] = Array.from(surface.indices);
  // The kept triangle each solid face belongs to (−1: the floor).
  const owner: number[] = [];
  for (let i = 0; i < patch.length; i++) owner.push(i);
  const directed = new Set<number>();
  for (let i = 0; i < surface.indices.length; i += 3) {
    for (let k = 0; k < 3; k++) directed.add(surface.indices[i + k]! * surfaceVertexCount + surface.indices[i + ((k + 1) % 3)]!);
  }
  const rimEdges: Array<[number, number]> = [];
  for (let i = 0; i < surface.indices.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const u = surface.indices[i + k]!;
      const v = surface.indices[i + ((k + 1) % 3)]!;
      if (directed.has(v * surfaceVertexCount + u)) continue;
      rimEdges.push([u, v]);
      solidIndices.push(v, u, back[u]!, v, back[u]!, back[v]!);
      owner.push(i / 3, i / 3);
    }
  }
  const floorTris = earClipStrict(rim2d);
  // The frame is right-handed (u × v = w), so a 2-D CCW triangle faces +axis;
  // the (coplanar) floor must face −axis.
  const [f0, f1, f2] = floorTris[0]!;
  const facesUp = cross2(rim2d[f0]!, rim2d[f1]!, rim2d[f2]!) > 0;
  for (const [a, b, c] of floorTris) {
    if (facesUp) solidIndices.push(back[rim[a]!]!, back[rim[c]!]!, back[rim[b]!]!);
    else solidIndices.push(back[rim[a]!]!, back[rim[b]!]!, back[rim[c]!]!);
    owner.push(-1);
  }
  const mesh: IndexedMesh = { positions: Float64Array.from(solidPositions), indices: Uint32Array.from(solidIndices) };

  const blame = (t: number): void => {
    if (owner[t]! >= 0) offending.add(owner[t]!);
  };
  const stats = analyzeMesh(mesh);
  if (stats.degenerateCount > 0) {
    for (let t = 0; t < owner.length; t++) if (checkDegenerateTriangle(mesh, t).degenerate) blame(t);
  }
  let unblamed = 0;
  findSelfIntersections(mesh, {
    onIntersectingPair: (a, b) => {
      if (owner[a]! < 0 && owner[b]! < 0) unblamed++;
      blame(a);
      blame(b);
    },
  });
  if (unblamed > 0) throw new PrepDieInvalidError(`${unblamed} self-intersecting floor face pair(s)`);
  if (stats.degenerateCount > 0 && offending.size === 0) {
    throw new PrepDieInvalidError(`${stats.degenerateCount} degenerate floor triangle(s)`);
  }
  return { mesh, surface, rimEdges, rimVertexCount: n, sourceOf, floorHeightMm, offending };
}

/**
 * Extracts the closed prep die for `marginLoop` from `scan` — see the module
 * doc for the region, the closure and the certificate. Pure and
 * deterministic: every loop runs in source order, ties break to the lowest
 * index.
 *
 * @throws {RangeError} invalid options, a margin loop with < 3 distinct
 * points, or a zero insertion axis.
 * @throws {PrepDieRegionError} nothing kept, the margin is not on the kept
 * surface, or the kept surface is not bounded by one loop.
 * @throws {PrepDieInvalidError} the closed die fails validation.
 * @throws {PrepDieClearanceError} the certificate is below the required
 * clearance.
 */
export function extractPrepDie(
  scan: IndexedMesh,
  marginLoop: readonly Vec3[],
  insertionAxis: Vec3,
  options: PrepDieOptions = {},
): PrepDieResult {
  const radialSkirtMm = positiveFinite('radialSkirtMm', options.radialSkirtMm ?? PREP_DIE_DEFAULT_RADIAL_SKIRT_MM);
  const depthSkirtMm = positiveFinite('depthSkirtMm', options.depthSkirtMm ?? PREP_DIE_DEFAULT_DEPTH_SKIRT_MM);
  const protectBandMm = positiveFinite('protectBandMm', options.protectBandMm ?? PREP_DIE_DEFAULT_PROTECT_BAND_MM);
  const floorGapMm = positiveFinite('floorGapMm', options.floorGapMm ?? PREP_DIE_DEFAULT_FLOOR_GAP_MM);
  const requiredClearanceMm = options.requiredClearanceMm ?? PREP_DIE_DEFAULT_REQUIRED_CLEARANCE_MM;
  if (!(Number.isFinite(requiredClearanceMm) && requiredClearanceMm >= 0)) {
    throw new RangeError(`extractPrepDie: requiredClearanceMm must be finite and >= 0, got ${requiredClearanceMm}`);
  }
  const axisLen = Math.hypot(insertionAxis[0], insertionAxis[1], insertionAxis[2]);
  if (!(Number.isFinite(axisLen) && axisLen > 0)) {
    throw new RangeError('extractPrepDie: the insertion axis must be a finite non-zero vector');
  }
  const loop = marginLoop.length >= 3 ? dedupLoop(marginLoop, MARGIN_DEDUP_EPSILON_MM) : [];
  if (loop.length < 3) {
    throw new RangeError(`extractPrepDie: the margin loop needs >= 3 distinct points, got ${loop.length}`);
  }
  const axis: Vec3 = [insertionAxis[0] / axisLen, insertionAxis[1] / axisLen, insertionAxis[2] / axisLen];
  const frame = axisFrame(axis);

  // ---- the margin polygon, in the axis frame -----------------------------
  const poly: P2[] = [];
  let marginMinHeightMm = Infinity;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of loop) {
    const q = applyR(frame, p);
    poly.push([q[0], q[1]]);
    marginMinHeightMm = Math.min(marginMinHeightMm, q[2]);
    minX = Math.min(minX, q[0]);
    minY = Math.min(minY, q[1]);
    maxX = Math.max(maxX, q[0]);
    maxY = Math.max(maxY, q[1]);
  }

  // ---- rules 1–2: candidate triangles ------------------------------------
  const { positions, indices } = scan;
  const vertexCount = positions.length / 3;
  const triangleCount = indices.length / 3;
  const rot = new Float64Array(positions.length);
  const eligible = new Uint8Array(vertexCount);
  const floorCut = marginMinHeightMm - depthSkirtMm;
  const skirtSq = radialSkirtMm * radialSkirtMm;
  for (let v = 0; v < vertexCount; v++) {
    const q = applyR(frame, [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!]);
    rot[v * 3] = q[0];
    rot[v * 3 + 1] = q[1];
    rot[v * 3 + 2] = q[2];
    if (q[2] < floorCut) continue;
    if (q[0] < minX - radialSkirtMm || q[0] > maxX + radialSkirtMm) continue;
    if (q[1] < minY - radialSkirtMm || q[1] > maxY + radialSkirtMm) continue;
    if (pointInPolygon2d(q[0], q[1], poly) || distSqToPolyline2d(q[0], q[1], poly) <= skirtSq) eligible[v] = 1;
  }
  const candidates: number[] = [];
  for (let t = 0; t < triangleCount; t++) {
    if (eligible[indices[t * 3]!] && eligible[indices[t * 3 + 1]!] && eligible[indices[t * 3 + 2]!]) candidates.push(t);
  }
  if (candidates.length === 0) {
    throw new PrepDieRegionError('empty', 'no scan surface lies inside the margin footprint and its skirts');
  }
  const inSet = new Uint8Array(triangleCount);
  for (const t of candidates) inSet[t] = 1;

  // ---- region + closure, with fold repair --------------------------------
  // A real scan can fold at the rim (the surface turns under itself along the
  // axis), so the rim does not project to a simple polygon, or a wall crosses
  // the kept surface. Every kept triangle implicated (owning a crossing rim
  // edge, or a face of an intersecting pair) is dropped and the region
  // rebuilt, to a fixed point; the count is reported. The dropped triangles
  // are rim triangles, so the certificate below — measured on the final rim —
  // covers them.
  let closed: ClosedDie | null = null;
  let patch: number[] = [];
  let foldTrianglesDropped = 0;
  for (let round = 0; round <= PREP_DIE_MAX_FOLD_REPAIR_ROUNDS; round++) {
    patch = largestComponentWithoutPinches(scan, inSet, candidates, vertexCount);
    if (patch.length === 0) {
      throw new PrepDieRegionError('empty', 'no 2-manifold scan surface survives inside the margin footprint');
    }
    const attempt = closeDie(scan, patch, rot, axis, floorGapMm);
    if (attempt.offending.size === 0) {
      closed = attempt;
      break;
    }
    for (const local of attempt.offending) inSet[patch[local]!] = 0;
    foldTrianglesDropped += attempt.offending.size;
  }
  if (closed === null) {
    throw new PrepDieInvalidError(
      `the rim still folds after ${PREP_DIE_MAX_FOLD_REPAIR_ROUNDS} repair rounds`,
    );
  }
  const { mesh, surface, rimEdges, rimVertexCount, sourceOf, floorHeightMm } = closed;
  const heightOf = (local: number): number => rot[sourceOf[local]! * 3 + 2]!;

  // ---- the margin lies on the kept surface -------------------------------
  const surfaceBvh = buildBvh(surface);
  let worstMarginMm = 0;
  for (const p of loop) worstMarginMm = Math.max(worstMarginMm, closestPoint(surface, surfaceBvh, p).distance);
  if (!(worstMarginMm <= PREP_DIE_MARGIN_ON_SURFACE_TOLERANCE_MM)) {
    throw new PrepDieRegionError(
      'margin-off-region',
      `the margin is not on the kept scan surface (worst point ${worstMarginMm.toFixed(4)} mm off it) — confirm the margin on this scan`,
    );
  }

  // ---- validation --------------------------------------------------------
  const stats = analyzeMesh(mesh);
  if (!stats.watertight) throw new PrepDieInvalidError('not watertight');
  if (!stats.manifoldEdges) throw new PrepDieInvalidError('not edge-manifold');
  if (stats.componentCount !== 1) throw new PrepDieInvalidError(`${stats.componentCount} components`);
  if (!(stats.signedVolumeMm3 !== null && stats.signedVolumeMm3 > 0)) {
    throw new PrepDieInvalidError('non-positive enclosed volume');
  }
  try {
    buildHalfedge(mesh);
  } catch (error) {
    throw new PrepDieInvalidError(`halfedge: ${(error as Error).message}`);
  }

  // ---- the certificate ---------------------------------------------------
  // A die closed by the scan itself has no synthetic part: nothing is
  // closer to the prism than "infinitely far".
  let clearanceMm = floorHeightMm === null ? Infinity : marginMinHeightMm - floorHeightMm;
  for (const [u, v] of rimEdges) {
    const a: P2 = [rot[sourceOf[u]! * 3]!, rot[sourceOf[u]! * 3 + 1]!];
    const b: P2 = [rot[sourceOf[v]! * 3]!, rot[sourceOf[v]! * 3 + 1]!];
    const lateral = Math.max(0, segmentPolygonDistance2d(a, b, poly) - protectBandMm);
    const vertical = Math.max(0, marginMinHeightMm - Math.max(heightOf(u), heightOf(v)));
    clearanceMm = Math.min(clearanceMm, Math.hypot(lateral, vertical));
  }
  if (clearanceMm < requiredClearanceMm) throw new PrepDieClearanceError(clearanceMm, requiredClearanceMm);

  return {
    mesh,
    keptTriangleCount: patch.length,
    syntheticTriangleCount: mesh.indices.length / 3 - patch.length,
    sourceTriangleIndices: Uint32Array.from(patch),
    rimVertexCount,
    foldTrianglesDropped,
    clearanceMm,
    marginMinHeightMm,
    floorHeightMm,
    volumeMm3: stats.signedVolumeMm3,
    insertionAxis: axis,
    radialSkirtMm,
    depthSkirtMm,
    protectBandMm,
    floorGapMm,
    requiredClearanceMm,
  };
}
