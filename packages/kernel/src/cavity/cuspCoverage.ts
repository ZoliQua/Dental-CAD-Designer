// packages/kernel/src/cavity/cuspCoverage.ts
//
// Phase 5 Task 7 — the ONLAY cusp-coverage kernel op: identify cusp regions on
// a tooth and, for a chosen coverage selection, EXTEND the restoration outline
// over the covered cusp(s). The extended outline then feeds the WHOLE T3–T6
// cavity pipeline unchanged (region extraction / fit surface / occlusal patch /
// proximal contacts / shell) — an onlay is an inlay on the extended outline.
//
// ## `identifyCuspRegions` — geometric cusp detection
//
// A cusp is a LOCAL MAXIMUM of the along-axis height field `h(v) = pos(v)·â` on
// the tooth's OCCLUSAL (axis-facing) surface. `identifyCuspRegions`:
//   1. classifies each triangle as OCCLUSAL (outward normal·â ≥ cos(occlusalMax))
//      — the upward-facing surface a cusp lives on;
//   2. finds every occlusal-surface VERTEX that is a strict local height maximum
//      over its occlusal one-ring (a cusp tip candidate);
//   3. grows a connected cusp REGION down from each tip over the occlusal
//      surface, including a triangle while it keeps DESCENDING away from the tip
//      (a watershed to the surrounding valleys/crests) — so the region is the
//      cusp's own occlusal slope, bounded by the ridges/grooves around it.
// Returns the cusps sorted by tip height DESCENDING (deterministic). On the MOD
// onlay fixture this is exactly two cusps — the intact LINGUAL cusp (tip at
// `lingualCuspTipZ`) and the reduced BUCCAL cusp whose occlusal crest is the
// coverage-margin ridge (`covMarginZ`) — closed-form checkable.
//
// ## `extendOutlineOverCusp` — the outline extension (the design crux)
//
// The covered cusp's occlusal surface is added to the restoration. The extended
// outline is the BOUNDARY LOOP of `cavityRegion ∪ coveredCuspRegions` on the
// mesh — the exact ring separating "under the restoration" from "sound tooth
// past the cusp". Geometrically the covered cusp's occlusal slope is bounded on
// its outer side by the cusp CREST (the coverage margin lands there, "on sound
// structure past the cusp" — the brief), so the union's outer boundary IS that
// crest; where the cusp meets the cavity the shared edges are INTERIOR to the
// union (they vanish from the boundary), splicing the cavity outline and the
// cusp crest into one closed ring. Deterministic; the boundary edges are ordered
// into a single loop by vertex adjacency (a typed error if the union is not a
// disk). Verified closed-form: on the fixture it reproduces `onlayOutline`
// (buccal run = the coverage-margin crest) EXACTLY.
//
// ## Region-scoped coverage footprint
//
// The op also returns `coveredCuspTriangleIndices` (the covered cusp surface) —
// the currency the T7 region-scoped `cuspCoverageMinThicknessMm` gate uses to
// classify a wall-thickness sample as covered-cusp (1.5 mm e.max) vs onlay body
// (1.0 mm): a sample whose fit-surface footpoint sits over this region is
// coverage. The op reports the covered-cusp buccolingual footprint extent for
// the closed-form region-split test.
//
// @errorBound Exact (Float64) — every step is a direct comparison of exact
// triangle/vertex quantities (unit-normal dot products, along-axis heights)
// against documented thresholds, or a topological boundary-edge extraction; no
// interpolation or approximation of a continuous quantity. Determinism: a pure
// function of (mesh bytes, outline, axis, options); all traversals ascending,
// outputs sorted.
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import { dot, triangleUnitNormal, triangleVertexPositions } from '../axis/vec.ts';
import { classifyCavityRegions } from './regions.ts';

// ---------------------------------------------------------------------------
// Documented algorithm parameters (NOT clinical values)
// ---------------------------------------------------------------------------

/** Max angle (deg) between a triangle's outward normal and the insertion axis
 * for the triangle to count as OCCLUSAL (axis-facing) surface a cusp lives on.
 * 70: a cusp's occlusal slopes and reduction table sit well within 70° of the
 * axis on any machined/anatomic tooth (the fixture's are 0–45°), while the
 * axial walls / gingival surfaces sit near 90°. An ALGORITHM parameter. */
export const CUSP_OCCLUSAL_MAX_ANGLE_DEG = 70;

/** Minimum prominence (mm, along the axis) a local height maximum must have over
 * the LOWEST vertex of its grown region to count as a genuine cusp (not
 * tessellation noise). 0.3: far above float/curvature noise, far below any real
 * cusp's occlusogingival relief. An ALGORITHM parameter. */
export const CUSP_MIN_PROMINENCE_MM = 0.3;

// ---------------------------------------------------------------------------
// Typed errors — explicit fields only (NO TS constructor parameter properties:
// this module is inside the Node worker's strip-only-TS loader closure).
// ---------------------------------------------------------------------------

/** No cusp local-maximum was found on the occlusal surface (a flat/degenerate
 * tooth, or an axis with no axis-facing surface). */
export class NoCuspFoundError extends Error {
  constructor() {
    super('identifyCuspRegions: no occlusal-surface local height maximum found — is this a tooth with cusps under this axis?');
    this.name = 'NoCuspFoundError';
  }
}

/** The union of the cavity + covered-cusp regions did not have a single simple
 * boundary loop (a non-disk union — disconnected or holed). */
export class CoverageBoundaryError extends Error {
  readonly loopCount: number;
  constructor(loopCount: number) {
    super(`extendOutlineOverCusp: cavity ∪ covered-cusp union has ${loopCount} boundary loop(s), expected exactly 1 (a simple extended outline)`);
    this.name = 'CoverageBoundaryError';
    this.loopCount = loopCount;
  }
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface CuspRegion {
  /** The cusp tip (local height maximum) vertex position. */
  readonly tipPositionMm: Vec3;
  /** Along-axis height of the tip (`pos·â`). */
  readonly tipHeightMm: number;
  /** The occlusal-surface triangle indices of this cusp's slope (sorted). */
  readonly triangleIndices: Uint32Array;
}

export interface IdentifyCuspRegionsOptions {
  readonly occlusalMaxAngleDeg?: number;
  readonly minProminenceMm?: number;
}

export interface CuspRegionsResult {
  /** The unit insertion axis used. */
  readonly axisUnit: Vec3;
  /** Cusps, sorted by tip height DESCENDING (deterministic). */
  readonly cusps: readonly CuspRegion[];
  readonly occlusalMaxAngleDeg: number;
  readonly minProminenceMm: number;
}

export interface ExtendOutlineOverCuspResult {
  /** The extended (onlay) outline — a closed on-mesh vertex ring. */
  readonly extendedOutline: Vec3[];
  /** The covered-cusp surface triangle indices (union'd across selections),
   * sorted — the region-scoped `cuspCoverageMinThicknessMm` footprint. THIS is
   * the region-split currency a min-wall gate must use to classify covered-cusp
   * (1.5 mm) vs body (1.0 mm) samples. */
  readonly coveredCuspTriangleIndices: Uint32Array;
  /** A 0/1 FLAG: `1` iff at least one covered-cusp surface triangle was found
   * (`covered.size > 0`), else `0`. NOT a coverage extent or footprint measure —
   * it says only WHETHER any cusp was covered; the actual covered surface is
   * `coveredCuspTriangleIndices`. */
  readonly coveredCuspCount: number;
}

// ---------------------------------------------------------------------------
// Internals — adjacency by shared mesh vertex indices
// ---------------------------------------------------------------------------

function vertexPos(mesh: IndexedMesh, v: number): Vec3 {
  return [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!];
}

function normalizeAxis(axis: Vec3, name: string): Vec3 {
  const len = Math.hypot(axis[0], axis[1], axis[2]);
  if (!(len > 0)) throw new TypeError(`${name}: insertionAxis must be a non-zero vector`);
  return [axis[0] / len, axis[1] / len, axis[2] / len];
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a},${b}` : `${b},${a}`;
}

/** Map every undirected mesh edge (by vertex indices) → incident triangle list. */
function buildEdgeTriMap(mesh: IndexedMesh): Map<string, number[]> {
  const map = new Map<string, number[]>();
  const triCount = mesh.indices.length / 3;
  for (let t = 0; t < triCount; t++) {
    const i0 = mesh.indices[t * 3]!, i1 = mesh.indices[t * 3 + 1]!, i2 = mesh.indices[t * 3 + 2]!;
    for (const k of [edgeKey(i0, i1), edgeKey(i1, i2), edgeKey(i2, i0)]) {
      let arr = map.get(k);
      if (!arr) { arr = []; map.set(k, arr); }
      arr.push(t);
    }
  }
  return map;
}

/** Occlusal (axis-facing) triangle mask. */
function occlusalMask(mesh: IndexedMesh, axisUnit: Vec3, minDot: number): Uint8Array {
  const triCount = mesh.indices.length / 3;
  const mask = new Uint8Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const [a, b, c] = triangleVertexPositions(mesh, t);
    if (dot(triangleUnitNormal(a, b, c), axisUnit) >= minDot) mask[t] = 1;
  }
  return mask;
}

/** One-ring vertex neighbours restricted to occlusal-triangle edges. */
function occlusalVertexNeighbours(mesh: IndexedMesh, occlusal: Uint8Array): Map<number, Set<number>> {
  const nb = new Map<number, Set<number>>();
  const add = (a: number, b: number): void => {
    let s = nb.get(a);
    if (!s) { s = new Set(); nb.set(a, s); }
    s.add(b);
  };
  const triCount = mesh.indices.length / 3;
  for (let t = 0; t < triCount; t++) {
    if (occlusal[t] !== 1) continue;
    const i0 = mesh.indices[t * 3]!, i1 = mesh.indices[t * 3 + 1]!, i2 = mesh.indices[t * 3 + 2]!;
    add(i0, i1); add(i1, i0); add(i1, i2); add(i2, i1); add(i2, i0); add(i0, i2);
  }
  return nb;
}

// ---------------------------------------------------------------------------
// identifyCuspRegions
// ---------------------------------------------------------------------------

/**
 * Identifies cusp regions on `mesh` relative to `insertionAxis` — see this
 * module's doc. Deterministic, Float64.
 *
 * @throws {TypeError} zero-length axis.
 * @throws {NoCuspFoundError} no occlusal local maximum.
 */
export function identifyCuspRegions(mesh: IndexedMesh, insertionAxis: Vec3, options: IdentifyCuspRegionsOptions = {}): CuspRegionsResult {
  const axisUnit = normalizeAxis(insertionAxis, 'identifyCuspRegions');
  const occlusalMaxAngleDeg = options.occlusalMaxAngleDeg ?? CUSP_OCCLUSAL_MAX_ANGLE_DEG;
  const minProminenceMm = options.minProminenceMm ?? CUSP_MIN_PROMINENCE_MM;
  const minDot = Math.cos((occlusalMaxAngleDeg * Math.PI) / 180);

  const occlusal = occlusalMask(mesh, axisUnit, minDot);
  const nb = occlusalVertexNeighbours(mesh, occlusal);
  const vertexCount = mesh.positions.length / 3;
  const height = new Float64Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) height[v] = dot(vertexPos(mesh, v), axisUnit);

  // Local maxima over the occlusal one-ring (strictly ≥ all neighbours, strictly
  // > at least one — a plateau's smallest-index vertex represents it).
  const isLocalMax: boolean[] = new Array(vertexCount).fill(false);
  for (const [v, neigh] of nb) {
    let geAll = true;
    let plateauRep = true;
    for (const w of neigh) {
      if (height[w]! > height[v]!) { geAll = false; break; }
      if (height[w]! === height[v]! && w < v) plateauRep = false; // the smallest-index plateau vertex represents a flat ridge
    }
    if (geAll && plateauRep) isLocalMax[v] = true;
  }

  // Grow each local-max into a cusp region: flood over occlusal triangles from
  // the tip, INCLUDING a triangle only while the flood keeps DESCENDING (its max
  // vertex height ≤ the height at which we entered it), so the region is the
  // cusp's own slope down to the surrounding ridges/grooves. Assign each occlusal
  // triangle to the HIGHEST tip whose descending flood reaches it (deterministic).
  const edgeTris = buildEdgeTriMap(mesh);
  const triHeight = (t: number): number => {
    const i0 = mesh.indices[t * 3]!, i1 = mesh.indices[t * 3 + 1]!, i2 = mesh.indices[t * 3 + 2]!;
    return Math.max(height[i0]!, height[i1]!, height[i2]!);
  };
  const triHasVertex = (t: number, v: number): boolean => {
    return mesh.indices[t * 3] === v || mesh.indices[t * 3 + 1] === v || mesh.indices[t * 3 + 2] === v;
  };

  interface Draft { tip: number; tipHeight: number; tris: number[]; minHeight: number }
  const tips: number[] = [];
  for (let v = 0; v < vertexCount; v++) if (isLocalMax[v]) tips.push(v);
  // sort tips by height desc so the highest claims shared slope first
  tips.sort((a, b) => height[b]! - height[a]! || a - b);

  const claimedBy = new Int32Array(mesh.indices.length / 3).fill(-1);
  const drafts: Draft[] = [];
  for (const tip of tips) {
    // seed with occlusal triangles incident to the tip that are not yet claimed
    const seeds: number[] = [];
    for (const [k, arr] of edgeTris) {
      void k;
      for (const t of arr) if (occlusal[t] === 1 && triHasVertex(t, tip) && claimedBy[t] === -1) seeds.push(t);
    }
    if (seeds.length === 0) continue;
    const tris: number[] = [];
    let minH = height[tip]!;
    // BFS with a monotone-descent gate: entryHeight per triangle
    const entryH = new Map<number, number>();
    const queue: number[] = [];
    for (const s of seeds) { if (!entryH.has(s)) { entryH.set(s, height[tip]!); queue.push(s); } }
    let qi = 0;
    while (qi < queue.length) {
      const t = queue[qi++]!;
      if (claimedBy[t] !== -1) continue;
      claimedBy[t] = tip;
      tris.push(t);
      const i0 = mesh.indices[t * 3]!, i1 = mesh.indices[t * 3 + 1]!, i2 = mesh.indices[t * 3 + 2]!;
      for (const vv of [i0, i1, i2]) if (height[vv]! < minH) minH = height[vv]!;
      const myEntry = entryH.get(t)!;
      for (const k of [edgeKey(i0, i1), edgeKey(i1, i2), edgeKey(i2, i0)]) {
        for (const other of edgeTris.get(k) ?? []) {
          if (other === t || occlusal[other] !== 1 || claimedBy[other] !== -1 || entryH.has(other)) continue;
          // descend gate: only cross into a triangle no higher than where we are
          if (triHeight(other) <= myEntry + 1e-9) {
            entryH.set(other, Math.min(myEntry, triHeight(other)));
            queue.push(other);
          }
        }
      }
    }
    if (tris.length > 0) drafts.push({ tip, tipHeight: height[tip]!, tris, minHeight: minH });
  }

  const cusps: CuspRegion[] = drafts
    .filter((d) => d.tipHeight - d.minHeight >= minProminenceMm)
    .map((d) => ({
      tipPositionMm: vertexPos(mesh, d.tip),
      tipHeightMm: d.tipHeight,
      triangleIndices: Uint32Array.from([...d.tris].sort((a, b) => a - b)),
    }))
    .sort((a, b) => b.tipHeightMm - a.tipHeightMm || a.triangleIndices[0]! - b.triangleIndices[0]!);

  if (cusps.length === 0) throw new NoCuspFoundError();
  return { axisUnit, cusps, occlusalMaxAngleDeg, minProminenceMm };
}

// ---------------------------------------------------------------------------
// extendOutlineOverCusp
// ---------------------------------------------------------------------------

/** Order a set of boundary edges (undirected vertex pairs) into loops. */
function orderBoundaryLoops(edges: [number, number][]): number[][] {
  const adj = new Map<number, number[]>();
  for (const [a, b] of edges) {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }
  const used = new Set<string>();
  const loops: number[][] = [];
  for (const [start] of adj) {
    if ([...adj.get(start)!].every((w) => used.has(edgeKey(start, w)))) continue;
    const loop: number[] = [start];
    let prev = -1;
    let cur = start;
    let guard = 0;
    while (guard++ < edges.length + 5) {
      const cands = adj.get(cur)!;
      let next = -1;
      for (const w of cands) {
        if (w === prev) continue;
        if (used.has(edgeKey(cur, w))) continue;
        next = w;
        break;
      }
      if (next === -1) break;
      used.add(edgeKey(cur, next));
      if (next === start) break;
      loop.push(next);
      prev = cur;
      cur = next;
    }
    loops.push(loop);
  }
  return loops;
}

/**
 * Extends `baseOutline` over a covered cusp — see this module's doc. The
 * coverage SELECTION is the covered-cusp surface `coveredCuspTriangleIndices`
 * (a design decision — the tooth surface the restoration caps; identified from
 * `identifyCuspRegions` + a documented coverage-margin rule, or supplied
 * directly). The extended outline is the single BOUNDARY LOOP of `cavityRegion ∪
 * coveredCuspRegion`. Deterministic, Float64.
 *
 * @throws {TypeError} zero-length axis.
 * @throws {CoverageBoundaryError} the union is not a single-boundary disk (the
 * covered selection is not a clean cap adjacent to the cavity).
 */
export function extendOutlineOverCusp(
  mesh: IndexedMesh,
  baseOutline: readonly Vec3[],
  insertionAxis: Vec3,
  coveredCuspTriangleIndices: Uint32Array | readonly number[],
): ExtendOutlineOverCuspResult {
  const axisUnit = normalizeAxis(insertionAxis, 'extendOutlineOverCusp');
  const regions = classifyCavityRegions(mesh, baseOutline, axisUnit);
  const cavitySet = new Set<number>(regions.cavity.triangleIndices);

  // Union region = cavity ∪ covered cusp.
  const union = new Set<number>(cavitySet);
  const covered = new Set<number>();
  for (const t of coveredCuspTriangleIndices) { union.add(t); covered.add(t); }

  // Boundary edges: undirected mesh edges with exactly one incident union
  // triangle (union side ≠ outside) — the extended cavosurface ring.
  const edgeTris = buildEdgeTriMap(mesh);
  const boundaryEdges: [number, number][] = [];
  for (const [k, tris] of edgeTris) {
    let inCount = 0;
    for (const t of tris) if (union.has(t)) inCount++;
    if (inCount === 1) {
      const [a, b] = k.split(',').map((s) => Number(s)) as [number, number];
      boundaryEdges.push([a, b]);
    }
  }
  const loops = orderBoundaryLoops(boundaryEdges);
  const closed = loops.filter((l) => l.length >= 3);
  if (closed.length !== 1) throw new CoverageBoundaryError(closed.length);

  const extendedOutline: Vec3[] = closed[0]!.map((v) => vertexPos(mesh, v));

  return {
    extendedOutline,
    coveredCuspTriangleIndices: Uint32Array.from([...covered].sort((a, b) => a - b)),
    coveredCuspCount: covered.size > 0 ? 1 : 0,
  };
}
