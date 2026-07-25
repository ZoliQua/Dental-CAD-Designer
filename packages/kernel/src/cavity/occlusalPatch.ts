// packages/kernel/src/cavity/occlusalPatch.ts
//
// Phase 5 Task 4: the inlay/onlay OUTER surface — an occlusal anatomy patch that
// restores the surface over the cavity opening, boundary EXACTLY on the cavity
// outline (the bit-exact ring the Task-3 fit surface shares, so Task 6 can
// stitch them into the shell), blended with G1 continuity into the surrounding
// intact tooth along the SEAM segments. ACCEPTANCE-CRITICAL: max seam dihedral
// < 5° (PLAN.md Phase 5 acceptance) — MEASURED by seamDihedral.ts, which is
// validated independently of this construction.
//
// ## THE SEAM/FREE PARTITION (resolved and documented first — the design crux)
//
// A break-through MOD outline has TWO qualitatively different boundary regimes,
// and conflating them is a false-accuracy failure:
//
//   - OCCLUSAL SEAM segments (the buccal & lingual occlusal margins): adjacent
//     intact tooth surface EXISTS (the cusp inner inclines). Here G1 blending is
//     DEFINED — the patch must leave the seam with the surrounding tooth's
//     surface normal. These are the ONLY segments the G1 gate applies to.
//   - PROXIMAL BREAK-THROUGH segments (the U-drops on the proximal faces): the
//     tooth is cut clean through — there is NO surrounding occlusal surface to
//     be continuous with (the only adjacent non-cavity surface is the proximal
//     cut face, ~perpendicular to the insertion axis). These are FREE
//     boundaries: the restoration's proximal face, which Task 5 later adapts to
//     the neighbour. The G1 gate does NOT apply here; this module builds the
//     free boundary as the proximal face descending from the occlusal marginal
//     ridge down to the exact outline U (a documented free-boundary
//     construction), and reports these edges SEPARATELY, never in the gate value.
//
// The partition is computed GEOMETRICALLY (and matches the fixture's closed-form
// segment labels — asserted in the tests): for each outline edge, find the
// SURROUNDING (non-cavity) tooth triangle across it (the cavity triangle set
// comes from `classifyCavityRegions`, Task 2) and project its outward normal on
// the insertion axis. `normal · axis >= cos(SEAM_SURROUNDING_MAX_ANGLE_DEG)` ⇒
// a SEAM edge (the cusp inclines read ~0.9 on the fixture); otherwise ⇒ FREE
// (the proximal cut faces read ~0). This is the same style of documented
// geometric classifier as `classifyCavityRegions`' floor/wall angle — an
// ALGORITHM parameter, not a clinical value.
//
// ## THE BLEND METHOD (chosen, documented + @errorBound below)
//
// A per-mesiodistal-station CUBIC-HERMITE buccolingual cross-sweep (the plan's
// "Hermite/Coons boundary strip blended into an interior anatomy height field"
// candidate). The two occlusal seam runs give, in outline order, paired buccal
// and lingual station points `B_i` / `L_i` (same count — a fixture contract,
// checked). For each station the patch cross-section from `B_i` to `L_i` is a
// cubic Hermite along the insertion axis whose ENDPOINT POSITIONS are exactly
// `B_i`, `L_i` (on the outline — bit-exact) and whose ENDPOINT TANGENTS match
// the surrounding tooth's surface tangent there (recovered from the surrounding
// facet normal). Because the endpoint tangents equal the tooth tangents, the
// cross-section is G1-continuous with the surrounding tooth AT the seam BY
// CONSTRUCTION (analytically, in the continuous limit). The interior of the
// cross-section is the occlusal anatomy: the cubic dips between the two cusp
// inclines, forming a mesiodistally-running central groove — a MODEST,
// PROCEDURAL placeholder (like the tooth library), NOT patient anatomy;
// provenance documented honestly. On the fixture's ruled (mesiodistally-uniform)
// cusp inclines the cross-section is uniform along the arch → a clean central
// groove with buccal/lingual cusp slopes.
//
// WHY THIS over the alternatives: a boundary-constrained RBF with normal
// constraints would fit the SAME G1 conditions but through an (N+4)×(N+4) dense
// solve whose interior is harder to reason about and whose seam tangent is only
// satisfied in a least-squares/interpolation sense at the control points; the
// Hermite cross-sweep satisfies the seam tangent EXACTLY and analytically at
// every station, is O(stations × cross-segments) with no solve, and makes the
// bit-exact outline boundary trivial (the seam rows ARE the outline points). A
// normal-field-blended SDF would reintroduce a marching-cubes chord error at the
// seam (the very thing the acceptance measures) for no benefit on a height-field
// restoration.
//
// The proximal FREE boundary: the grid's mesial/distal cross-section column is
// zipped (monotone arc-length) down to the exact outline U — forming the
// proximal face from the occlusal marginal ridge to the gingival outline. No G1
// constraint (there is nothing to be continuous with); just a watertight,
// non-degenerate strip whose rim is the exact outline.
//
// ## @errorBound
//
// SEAM G1: EXACT in the continuous limit — the cubic-Hermite endpoint tangent is
// set equal to the surrounding tooth facet's surface tangent at each seam
// station, so the patch and tooth share a tangent plane there analytically. The
// only residual in the MEASURED seam dihedral is DISCRETIZATION: the patch's
// boundary triangle spans the first cross-segment (Δt = 1/`crossSegments`), so
// its chord slope differs from the analytic seam tangent by O(‖ζ″‖ · Δt) — a
// bound this module also computes explicitly as `seamDihedralBoundDeg` (the max
// over stations of the angle between the first-cell chord and the analytic seam
// tangent) and the caller MEASURES via `measureSeamDihedral`. Refining
// `crossSegments` drives it → 0. A curvature term enters only if the SURROUNDING
// surface is doubly-curved (the per-station tangent is averaged from the
// incident seam facets); it is 0 on a ruled surrounding surface (the fixture's
// cusp inclines). The proximal FREE boundary adds NO seam-fit error (it is not a
// seam) and its rim vertices ARE the outline points (bit-exact).
//
// Determinism: same tooth mesh + outline + axis + options ⇒ byte-identical
// patch. Pure Float64; no randomness/time; fixed iteration order; coordinate-key
// dedup with the first-seen index; all traversals ascending. Pinned by a
// committed sha256 in occlusalPatch.test.ts (the pure-Float64 op precedent
// cavity/regions.ts + innerSurface.ts follow — no test-fixtures/golden entry).
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import { add, cross, dot, normalizeOrZero, scale, sub, triangleUnitNormal, triangleVertexPositions } from '../axis/vec.ts';
import { orientNormalsConsistently } from '../intake/orient.ts';
import { analyzeMesh } from '../intake/analyze.ts';
import { marginLoopPolyline } from '../margin/band.ts';
import { dedupLoop, MARGIN_DEDUP_EPSILON_MM } from '../offset/innerSurfaceSolid.ts';
import { classifyCavityRegions } from './regions.ts';
import type { SeamEdge } from './seamDihedral.ts';

// ---------------------------------------------------------------------------
// Documented algorithm parameters (NOT clinical values)
// ---------------------------------------------------------------------------

/** Max angle (deg) between the SURROUNDING (non-cavity) tooth triangle's outward
 * normal and the insertion axis for an outline edge to classify as an OCCLUSAL
 * SEAM (vs a proximal FREE boundary). 60: the fixture's cusp inclines sit ~24.8°
 * from the axis (`normal·axis ≈ 0.91`) and its proximal cut faces sit ~90°
 * (`≈ 0`), so 60° (`cos = 0.5`) has > 25° clearance to BOTH populations — the
 * same wide-separation argument as `CAVITY_FLOOR_MAX_ANGLE_DEG`. An ALGORITHM
 * parameter (echoed for journaling), not a clinical value. */
export const SEAM_SURROUNDING_MAX_ANGLE_DEG = 60;

/** Default buccolingual cross-sweep segment count per station. 48: the seam
 * dihedral residual is O(‖ζ″‖/`crossSegments`); 48 puts it well below 1° on the
 * fixture (measured ~0.5°) with margin against the 5° gate, at trivial cost. An
 * ALGORITHM parameter (echoed for journaling). */
export const DEFAULT_PATCH_CROSS_SEGMENTS = 48;

// ---------------------------------------------------------------------------
// Typed errors — explicit fields only (NO TS constructor parameter properties:
// this module is inside the Node worker's strip-only-TS loader closure).
// ---------------------------------------------------------------------------

/** The outline did not partition into exactly two occlusal SEAM runs separated
 * by two proximal FREE runs — the break-through MOD contract this op builds on
 * (a non-MOD or degenerate outline needs a different construction). */
export class OcclusalSeamPartitionError extends Error {
  readonly seamRunCount: number;
  readonly freeRunCount: number;
  constructor(seamRunCount: number, freeRunCount: number) {
    super(
      `buildOcclusalPatch: expected 2 occlusal SEAM runs + 2 proximal FREE runs on the outline, got ` +
        `${seamRunCount} seam run(s) / ${freeRunCount} free run(s) — is this a break-through MOD outline?`,
    );
    this.name = 'OcclusalSeamPartitionError';
    this.seamRunCount = seamRunCount;
    this.freeRunCount = freeRunCount;
  }
}

/** The two occlusal seam runs have different vertex counts, so buccal/lingual
 * stations cannot be paired index-to-index (the fixture contract: dense,
 * matched occlusal margins). A real-scan outline that violates this needs a
 * resample-and-pair extension — a loud boundary, not a silent approximation. */
export class SeamChainLengthMismatchError extends Error {
  readonly buccalCount: number;
  readonly lingualCount: number;
  constructor(buccalCount: number, lingualCount: number) {
    super(
      `buildOcclusalPatch: the two occlusal seam runs have ${buccalCount} and ${lingualCount} vertices — they must ` +
        `match to pair buccal/lingual stations index-to-index (dense, matched occlusal margins)`,
    );
    this.name = 'SeamChainLengthMismatchError';
    this.buccalCount = buccalCount;
    this.lingualCount = lingualCount;
  }
}

/** A surrounding tooth triangle could not be resolved to exactly one across an
 * outline edge (the outline is not a clean cavity/outer boundary on the mesh). */
export class SurroundingTriangleError extends Error {
  readonly outlineEdgeIndex: number;
  readonly surroundingCount: number;
  constructor(outlineEdgeIndex: number, surroundingCount: number) {
    super(
      `buildOcclusalPatch: outline edge ${outlineEdgeIndex} has ${surroundingCount} surrounding (non-cavity) tooth ` +
        `triangle(s), expected exactly 1 — is the outline a clean cavity boundary on the mesh?`,
    );
    this.name = 'SurroundingTriangleError';
    this.outlineEdgeIndex = outlineEdgeIndex;
    this.surroundingCount = surroundingCount;
  }
}

// ---------------------------------------------------------------------------
// Options / result
// ---------------------------------------------------------------------------

export interface OcclusalPatchOptions {
  /** Buccolingual cross-sweep segments per station. Default
   * `DEFAULT_PATCH_CROSS_SEGMENTS`. */
  readonly crossSegments?: number;
  /** Partition threshold (deg). Default `SEAM_SURROUNDING_MAX_ANGLE_DEG`. */
  readonly seamSurroundingMaxAngleDeg?: number;
}

/** One proximal (break-through) face of the patch — the Task-5 adaptation
 * currency. `columnPoints` is the proximal cross-section column (the face's
 * occlusal top rim, B→L order, `crossSegments + 1` points): its ENDPOINTS are
 * outline vertices (pinned) and its INTERIOR is the only non-outline vertex
 * set of the face — the rim Task 5's `adaptProximalContacts` displaces.
 * `freeRunPoints` is the outline U (every point an outline vertex — pinned),
 * sharing the column's endpoints (the zip contract). NO mesial/distal claim is
 * made here (the two faces are reported in patch-internal order); pairing a
 * face with an actual FDI neighbour is the consuming stage's job (geometric). */
export interface ProximalFaceBoundary {
  readonly columnPoints: readonly Vec3[];
  readonly freeRunPoints: readonly Vec3[];
}

export interface OcclusalPatchResult {
  /** The finished occlusal patch (world frame): an OPEN surface whose single
   * boundary loop == the cavity-outline ring, oriented outward (facing +axis). */
  readonly mesh: IndexedMesh;
  readonly stats: ReturnType<typeof analyzeMesh>;
  /** The SEAM edges to measure the G1 gate on (in outline order; `segment` is
   * `'buccal'`/`'lingual'` for the two occlusal margin runs). */
  readonly seamEdges: readonly SeamEdge[];
  /** The proximal FREE (break-through) edges — reported for transparency, NEVER
   * part of the G1 gate value. */
  readonly freeEdges: readonly SeamEdge[];
  /** Tooth triangle indices to EXCLUDE when the gate disambiguates the
   * surrounding triangle across a seam edge (the cavity surface). */
  readonly cavityTriangleIndices: Uint32Array;
  /** The two proximal break-through faces (Task-5 adaptation currency) — see
   * `ProximalFaceBoundary`. */
  readonly proximalFaces: readonly [ProximalFaceBoundary, ProximalFaceBoundary];
  /** A-priori bound (deg) on the patch's contribution to the measured seam
   * dihedral — the discretization residual (see @errorBound). */
  readonly seamDihedralBoundDeg: number;
  /** Echo of the algorithm parameters used (journaling currency). */
  readonly crossSegments: number;
  readonly seamSurroundingMaxAngleDeg: number;
  readonly patchTriangleCount: number;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function coordKey(p: Vec3): string {
  return `${p[0]}|${p[1]}|${p[2]}`;
}
function undirEdgeKey(a: Vec3, b: Vec3): string {
  const ka = coordKey(a);
  const kb = coordKey(b);
  return ka < kb ? `${ka}#${kb}` : `${kb}#${ka}`;
}

function buildEdgeTriangleMap(mesh: IndexedMesh): Map<string, number[]> {
  const map = new Map<string, number[]>();
  const triCount = mesh.indices.length / 3;
  for (let t = 0; t < triCount; t++) {
    const [a, b, c] = triangleVertexPositions(mesh, t);
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const k = undirEdgeKey(p, q);
      let arr = map.get(k);
      if (!arr) {
        arr = [];
        map.set(k, arr);
      }
      arr.push(t);
    }
  }
  return map;
}

/** Cubic-Hermite (zero endpoint VALUES) basis: ζ(t) = h10(t)·m0 + h11(t)·m1,
 * where m0 = ζ'(0), m1 = ζ'(1). h10 = t − 2t² + t³, h11 = −t² + t³. */
function hermiteZeroValue(t: number, m0: number, m1: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return m0 * (t - 2 * t2 + t3) + m1 * (-t2 + t3);
}

interface Partition {
  cavitySet: Set<number>;
  cavityTriangleIndices: Uint32Array;
  /** outline edges labelled seam/free, aligned with outline order. */
  labels: ('seam' | 'free')[];
  /** surrounding facet normal per outline edge (only meaningful for seam). */
  surroundingNormal: Vec3[];
  outline: Vec3[];
}

function partition(mesh: IndexedMesh, outlineIn: readonly Vec3[], axisUnit: Vec3, seamCos: number): Partition {
  // Dedup outline the SAME way the Task-3 fit surface does, so both share the ring.
  const outline = dedupLoop(marginLoopPolyline({ closed: true, resampledPoints: outlineIn }), MARGIN_DEDUP_EPSILON_MM);
  const regions = classifyCavityRegions(mesh, outlineIn, axisUnit);
  const cavitySet = new Set<number>(regions.cavity.triangleIndices);
  const edgeMap = buildEdgeTriangleMap(mesh);

  const n = outline.length;
  const labels: ('seam' | 'free')[] = new Array(n);
  const surroundingNormal: Vec3[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = outline[i]!;
    const b = outline[(i + 1) % n]!;
    const tris = (edgeMap.get(undirEdgeKey(a, b)) ?? []).filter((t) => !cavitySet.has(t));
    if (tris.length !== 1) {
      throw new SurroundingTriangleError(i, tris.length);
    }
    const [ta, tb, tc] = triangleVertexPositions(mesh, tris[0]!);
    const nrm = triangleUnitNormal(ta, tb, tc);
    surroundingNormal[i] = nrm;
    labels[i] = dot(nrm, axisUnit) >= seamCos ? 'seam' : 'free';
  }
  return { cavitySet, cavityTriangleIndices: Uint32Array.from([...cavitySet].sort((x, y) => x - y)), labels, surroundingNormal, outline };
}

/** Maximal contiguous runs of a given label around the closed edge-ring, each as
 * a start edge-index + length. Deterministic (starts at the first label change). */
function runs(labels: readonly ('seam' | 'free')[], want: 'seam' | 'free'): { start: number; len: number }[] {
  const n = labels.length;
  // find a boundary (an index whose predecessor differs) to start cleanly
  let startIdx = 0;
  let found = false;
  for (let i = 0; i < n; i++) {
    if (labels[i] !== labels[(i + n - 1) % n]) {
      startIdx = i;
      found = true;
      break;
    }
  }
  const out: { start: number; len: number }[] = [];
  if (!found) {
    // all one label
    if (labels[0] === want) out.push({ start: 0, len: n });
    return out;
  }
  let i = 0;
  while (i < n) {
    const e = (startIdx + i) % n;
    if (labels[e] === want) {
      const runStart = e;
      let len = 0;
      while (i < n && labels[(startIdx + i) % n] === want) {
        len++;
        i++;
      }
      out.push({ start: runStart, len });
    } else {
      i++;
    }
  }
  return out;
}

/** Vertex chain (len+1 points) of an edge-run starting at edge `start`. */
function runChain(outline: readonly Vec3[], start: number, len: number): Vec3[] {
  const n = outline.length;
  const chain: Vec3[] = [];
  for (let k = 0; k <= len; k++) chain.push(outline[(start + k) % n]!);
  return chain;
}

/** Per-station averaged surrounding normal: average the surrounding facet
 * normals of the (up to 2) seam edges incident to outline vertex `vIdx`. */
function stationNormal(surroundingNormal: readonly Vec3[], labels: readonly ('seam' | 'free')[], vIdx: number, n: number): Vec3 {
  const inEdge = (vIdx + n - 1) % n; // edge ending at vIdx
  const outEdge = vIdx; // edge starting at vIdx
  let sx = 0, sy = 0, sz = 0;
  if (labels[inEdge] === 'seam') {
    sx += surroundingNormal[inEdge]![0];
    sy += surroundingNormal[inEdge]![1];
    sz += surroundingNormal[inEdge]![2];
  }
  if (labels[outEdge] === 'seam') {
    sx += surroundingNormal[outEdge]![0];
    sy += surroundingNormal[outEdge]![1];
    sz += surroundingNormal[outEdge]![2];
  }
  return normalizeOrZero([sx, sy, sz]);
}

// ---------------------------------------------------------------------------
// The op
// ---------------------------------------------------------------------------

/**
 * Builds the occlusal anatomy patch over the cavity opening — see this module's
 * doc for the seam/free partition, the cubic-Hermite blend method, and
 * @errorBound. `mesh` is the FULL closed tooth-with-cavity solid; `cavityOutline`
 * is the dense on-mesh ring; `insertionAxis` is normalized internally. Returns
 * an OPEN patch whose boundary loop == the outline, plus the seam/free edge sets
 * and the cavity-triangle exclusion for the G1 gate. Deterministic, Float64.
 *
 * @throws {TypeError} zero-length axis / short outline.
 * @throws {OcclusalSeamPartitionError} / {SeamChainLengthMismatchError} /
 * {SurroundingTriangleError} — malformed / non-MOD outline.
 * @throws propagates `classifyCavityRegions`' typed errors (outline not on mesh
 * / not an edge ring / does not split the mesh / axis perpendicular).
 */
export function buildOcclusalPatch(
  mesh: IndexedMesh,
  cavityOutline: readonly Vec3[],
  insertionAxis: Vec3,
  options: OcclusalPatchOptions = {},
): OcclusalPatchResult {
  const axisLen = Math.hypot(insertionAxis[0], insertionAxis[1], insertionAxis[2]);
  if (!(axisLen > 0)) {
    throw new TypeError('buildOcclusalPatch: insertionAxis must be a non-zero vector');
  }
  const axisUnit: Vec3 = [insertionAxis[0] / axisLen, insertionAxis[1] / axisLen, insertionAxis[2] / axisLen];
  if (!cavityOutline || cavityOutline.length < 3) {
    throw new TypeError(`buildOcclusalPatch: cavityOutline must have >= 3 points, got ${cavityOutline?.length ?? 0}`);
  }
  const crossSegments = options.crossSegments ?? DEFAULT_PATCH_CROSS_SEGMENTS;
  if (!(Number.isInteger(crossSegments) && crossSegments >= 2)) {
    throw new TypeError(`buildOcclusalPatch: crossSegments must be an integer >= 2, got ${crossSegments}`);
  }
  const seamAngleDeg = options.seamSurroundingMaxAngleDeg ?? SEAM_SURROUNDING_MAX_ANGLE_DEG;
  const seamCos = Math.cos((seamAngleDeg * Math.PI) / 180);

  const part = partition(mesh, cavityOutline, axisUnit, seamCos);
  const { labels, surroundingNormal, outline } = part;
  const n = outline.length;

  const seamRuns = runs(labels, 'seam');
  const freeRuns = runs(labels, 'free');
  if (seamRuns.length !== 2 || freeRuns.length !== 2) {
    throw new OcclusalSeamPartitionError(seamRuns.length, freeRuns.length);
  }

  // Two occlusal margin chains. Pair B_i (chain0[i]) with L_i (chain1 reversed).
  const chain0 = runChain(outline, seamRuns[0]!.start, seamRuns[0]!.len); // buccal, M+1 pts
  const chain1 = runChain(outline, seamRuns[1]!.start, seamRuns[1]!.len); // lingual (outline order)
  const M = seamRuns[0]!.len; // edges; chain length = M+1
  if (chain0.length !== chain1.length) {
    throw new SeamChainLengthMismatchError(chain0.length, chain1.length);
  }
  // B_i = chain0[i]; L_i = chain1[M - i] (see module doc: the free runs join
  // chain0-end↔chain1-start and chain1-end↔chain0-start).
  const B: Vec3[] = chain0.slice();
  const L: Vec3[] = [];
  for (let i = 0; i <= M; i++) L.push(chain1[M - i]!);

  // Station vertex indices in the outline (for the per-station surrounding
  // normal). chain0 vertices are outline[(seamRuns[0].start + k) % n].
  const bOutlineIdx: number[] = [];
  for (let k = 0; k <= M; k++) bOutlineIdx.push((seamRuns[0]!.start + k) % n);
  const lOutlineIdx: number[] = [];
  for (let k = 0; k <= M; k++) lOutlineIdx.push((seamRuns[1]!.start + (M - k)) % n);

  // Free runs, oriented B_0→L_0 (mesial) and B_M→L_M (distal). One free run goes
  // chain1-end (L_0 = chain1[M]) → chain0-start (B_0 = chain0[0]); the other goes
  // chain0-end (B_M = chain0[M]) → chain1-start (L_M = chain1[0]).
  const freeA = runChain(outline, freeRuns[0]!.start, freeRuns[0]!.len);
  const freeB = runChain(outline, freeRuns[1]!.start, freeRuns[1]!.len);
  const sameKey = (p: Vec3, q: Vec3): boolean => coordKey(p) === coordKey(q);
  // Identify which free run is mesial (ends at B_0) vs distal (ends at L_M).
  let mesialFree: Vec3[];
  let distalFree: Vec3[];
  const endsAt = (run: Vec3[], v: Vec3): boolean => sameKey(run[run.length - 1]!, v) || sameKey(run[0]!, v);
  if (endsAt(freeA, B[0]!) && (sameKey(freeA[0]!, L[0]!) || sameKey(freeA[freeA.length - 1]!, L[0]!))) {
    mesialFree = sameKey(freeA[0]!, B[0]!) ? freeA.slice() : freeA.slice().reverse();
    distalFree = sameKey(freeB[0]!, B[M]!) ? freeB.slice() : freeB.slice().reverse();
  } else {
    mesialFree = sameKey(freeB[0]!, B[0]!) ? freeB.slice() : freeB.slice().reverse();
    distalFree = sameKey(freeA[0]!, B[M]!) ? freeA.slice() : freeA.slice().reverse();
  }
  void endsAt; // (used above for readability of the branch condition)

  // --- assemble via coordinate-dedup vertex table ---
  const vertexIndex = new Map<string, number>();
  const positions: number[] = [];
  const vid = (p: Vec3): number => {
    const key = coordKey(p);
    const e = vertexIndex.get(key);
    if (e !== undefined) return e;
    const idx = positions.length / 3;
    positions.push(p[0], p[1], p[2]);
    vertexIndex.set(key, idx);
    return idx;
  };
  const triangles: [number, number, number][] = [];
  const tri = (a: number, b: number, c: number): void => {
    if (a === b || b === c || a === c) return;
    triangles.push([a, b, c]);
  };

  // --- cross-sweep grid G[i][j] (i=0..M, j=0..crossSegments) ---
  let seamDihedralBoundDeg = 0;
  const grid: number[][] = [];
  const colPoints: Vec3[][] = []; // keep Vec3 for the proximal zip
  for (let i = 0; i <= M; i++) {
    const Bi = B[i]!;
    const Li = L[i]!;
    const Di = sub(Li, Bi);
    const dAlong = dot(Di, axisUnit);
    const Dperp = sub(Di, scale(axisUnit, dAlong));
    const dPerpLen = Math.hypot(Dperp[0], Dperp[1], Dperp[2]);
    const ehat = dPerpLen > 0 ? scale(Dperp, 1 / dPerpLen) : ([0, 0, 0] as Vec3);

    const nB = stationNormal(surroundingNormal, labels, bOutlineIdx[i]!, n);
    const nL = stationNormal(surroundingNormal, labels, lOutlineIdx[i]!, n);
    // tooth along-axis slope per unit in-plane: k = -(ehat·nrm)/(axis·nrm).
    const denomB = dot(axisUnit, nB);
    const denomL = dot(axisUnit, nL);
    const kB = denomB !== 0 ? -dot(ehat, nB) / denomB : 0;
    const kL = denomL !== 0 ? -dot(ehat, nL) / denomL : 0;
    // ζ'(0) = kB·|Dperp| − dAlong ; ζ'(1) = kL·|Dperp| − dAlong.
    const m0 = kB * dPerpLen - dAlong;
    const m1 = kL * dPerpLen - dAlong;

    const col: number[] = [];
    const colPts: Vec3[] = [];
    for (let j = 0; j <= crossSegments; j++) {
      let p: Vec3;
      if (j === 0) p = Bi; // bit-exact outline point
      else if (j === crossSegments) p = Li; // bit-exact outline point
      else {
        const t = j / crossSegments;
        const zeta = hermiteZeroValue(t, m0, m1);
        p = add(add(Bi, scale(Di, t)), scale(axisUnit, zeta));
      }
      col.push(vid(p));
      colPts.push(p);
    }
    grid.push(col);
    colPoints.push(colPts);

    // a-priori seam-dihedral bound: angle between the analytic seam tangent
    // (Di + m0·axis) and the first cross-cell chord (colPts[1] − colPts[0]).
    const tangent0 = add(Di, scale(axisUnit, m0));
    const chord0 = sub(colPts[1]!, colPts[0]!);
    const bnd0 = angleDeg(tangent0, chord0);
    const tangent1 = add(Di, scale(axisUnit, m1));
    const chord1 = sub(colPts[crossSegments - 1]!, colPts[crossSegments]!); // toward interior from Li
    const bnd1 = angleDeg(tangent1, scale(chord1, -1));
    seamDihedralBoundDeg = Math.max(seamDihedralBoundDeg, bnd0, bnd1);
  }

  for (let i = 0; i < M; i++) {
    for (let j = 0; j < crossSegments; j++) {
      const a = grid[i]![j]!;
      const b = grid[i + 1]![j]!;
      const c = grid[i + 1]![j + 1]!;
      const d = grid[i]![j + 1]!;
      tri(a, b, c);
      tri(a, c, d);
    }
  }

  // --- proximal free strips: zip a grid column to the outline U ---
  const zipStrip = (colPts: Vec3[], freeRun: Vec3[]): void => {
    // both start at colPts[0]==freeRun[0], end at colPts[last]==freeRun[last]
    const P = colPts;
    const Q = freeRun;
    const cum = (arr: Vec3[]): number[] => {
      const s = [0];
      for (let i = 1; i < arr.length; i++) s.push(s[i - 1]! + Math.hypot(arr[i]![0] - arr[i - 1]![0], arr[i]![1] - arr[i - 1]![1], arr[i]![2] - arr[i - 1]![2]));
      const tot = s[s.length - 1]! || 1;
      return s.map((x) => x / tot);
    };
    const sP = cum(P);
    const sQ = cum(Q);
    let i = 0;
    let j = 0;
    while (i < P.length - 1 || j < Q.length - 1) {
      const advanceP = j >= Q.length - 1 || (i < P.length - 1 && sP[i + 1]! <= sQ[j + 1]!);
      if (advanceP) {
        tri(vid(P[i]!), vid(Q[j]!), vid(P[i + 1]!));
        i++;
      } else {
        tri(vid(P[i]!), vid(Q[j]!), vid(Q[j + 1]!));
        j++;
      }
    }
  };
  zipStrip(colPoints[0]!, mesialFree);
  zipStrip(colPoints[M]!, distalFree);

  // --- assemble, orient consistently, flip to face +axis ---
  const flat = new Float64Array(positions);
  const indices = new Uint32Array(triangles.length * 3);
  triangles.forEach((t, i) => indices.set(t, i * 3));
  const oriented = orientNormalsConsistently({ positions: flat, indices }).mesh;
  const finalMesh = flipToAxis(oriented, axisUnit);
  const stats = analyzeMesh(finalMesh);

  // --- seam / free edge lists for the gate + reporting ---
  const seamEdges: SeamEdge[] = [];
  const segLabel = ['buccal', 'lingual'];
  for (let r = 0; r < 2; r++) {
    const run = seamRuns[r]!;
    for (let k = 0; k < run.len; k++) {
      const a = outline[(run.start + k) % n]!;
      const b = outline[(run.start + k + 1) % n]!;
      seamEdges.push({ a, b, segment: segLabel[r]! });
    }
  }
  const freeEdges: SeamEdge[] = [];
  for (let r = 0; r < 2; r++) {
    const run = freeRuns[r]!;
    for (let k = 0; k < run.len; k++) {
      const a = outline[(run.start + k) % n]!;
      const b = outline[(run.start + k + 1) % n]!;
      freeEdges.push({ a, b, segment: r === 0 ? 'proximalA' : 'proximalB' });
    }
  }

  // The two proximal faces (Task-5 currency): column = the proximal
  // cross-section (grid column 0 / M, B→L order), free run = the outline U
  // oriented to share the column's endpoints. Copies (never internal arrays):
  // the result is an immutable value.
  const proximalFaces: [ProximalFaceBoundary, ProximalFaceBoundary] = [
    { columnPoints: colPoints[0]!.map((p) => [p[0], p[1], p[2]] as Vec3), freeRunPoints: mesialFree.map((p) => [p[0], p[1], p[2]] as Vec3) },
    { columnPoints: colPoints[M]!.map((p) => [p[0], p[1], p[2]] as Vec3), freeRunPoints: distalFree.map((p) => [p[0], p[1], p[2]] as Vec3) },
  ];

  return {
    mesh: finalMesh,
    stats,
    seamEdges,
    freeEdges,
    cavityTriangleIndices: part.cavityTriangleIndices,
    proximalFaces,
    seamDihedralBoundDeg,
    crossSegments,
    seamSurroundingMaxAngleDeg: seamAngleDeg,
    patchTriangleCount: finalMesh.indices.length / 3,
  };
}

function angleDeg(a: Vec3, b: Vec3): number {
  const la = Math.hypot(a[0], a[1], a[2]);
  const lb = Math.hypot(b[0], b[1], b[2]);
  if (!(la > 0 && lb > 0)) return 0;
  const c = Math.max(-1, Math.min(1, dot(a, b) / (la * lb)));
  return (Math.acos(c) * 180) / Math.PI;
}

/** Flip all triangle windings if the area-weighted normal sum faces AGAINST the
 * insertion axis, so the patch faces outward (+axis). Deterministic. */
function flipToAxis(mesh: IndexedMesh, axisUnit: Vec3): IndexedMesh {
  const triCount = mesh.indices.length / 3;
  let sx = 0, sy = 0, sz = 0;
  for (let t = 0; t < triCount; t++) {
    const [a, b, c] = triangleVertexPositions(mesh, t);
    const nrm = cross(sub(b, a), sub(c, a)); // area-weighted (un-normalized)
    sx += nrm[0];
    sy += nrm[1];
    sz += nrm[2];
  }
  if (sx * axisUnit[0] + sy * axisUnit[1] + sz * axisUnit[2] >= 0) return mesh;
  const indices = mesh.indices.slice();
  for (let t = 0; t < triCount; t++) {
    const b = indices[t * 3 + 1]!;
    indices[t * 3 + 1] = indices[t * 3 + 2]!;
    indices[t * 3 + 2] = b;
  }
  return { positions: mesh.positions.slice(), indices };
}
