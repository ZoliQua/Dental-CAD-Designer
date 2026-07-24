// packages/kernel/src/sculpt/sculpt.ts
//
// Phase 4 Task 8 — FREEFORM SCULPTING BRUSHES on the crown shell (Task 7).
// Interactive add / remove / smooth brushes that displace the OUTER surface of
// a finished crown shell while the FIT SURFACE (the inner intaglio + the margin
// + the margin-band seam) stays LOCKED by default — so Task 4's ≤10 µm marginal
// fit survives sculpting untouched. Every brush is a DETERMINISTIC, exact-Float64
// vertex displacement (no re-triangulation, no accumulation-order dependence),
// so a journaled stroke sequence replays BIT-IDENTICALLY (CLAUDE.md invariant 2).
//
// ## The brush math (exact, documented — this is the determinism contract)
//
// A stroke is `{ center, radiusMm, strength, brush }`. Let `d = |pos_v - center|`
// be the 3-D Euclidean distance from a vertex to the stroke center and
// `t = d / radiusMm`. A vertex is AFFECTED iff it is NOT locked and `t <= 1`.
// The RADIAL FALLOFF is the C1-smooth bump
//
//     falloff(t) = (1 - t²)²   for t in [0, 1],   0 otherwise
//
// (value 1 and slope 0 at t=0, value 0 and slope 0 at t=1 — so a stroke leaves
// no crease at its rim). `w = falloff(t)` is the per-vertex weight. Then, with
// `n_v` the UNIT area-weighted vertex normal (`computeVertexNormals`, computed
// ONCE from the pre-stroke mesh — the "snapshot", so all displacements in a
// stroke are computed from the same state and are order-independent):
//
//   • add    : disp_v = +n_v · strength · w          (raises the surface)
//   • remove : disp_v = −n_v · strength · w          (lowers the surface)
//   • smooth : disp_v = (L_v) · clamp01(strength) · w
//              where L_v = (mean of v's one-ring neighbour positions) − pos_v
//              is the discrete umbrella/Laplacian (Taubin-style λ step), also
//              from the pre-stroke snapshot — moving each vertex toward its
//              neighbours' centroid REDUCES local curvature.
//
// For add/remove `strength` is the peak displacement in mm at the stroke centre;
// for smooth it is the peak blend fraction in [0, 1] at the centre. A vertex
// with an undefined (zero-length) normal is skipped by add/remove (never
// divide by a zero direction — computeVertexNormals's contract).
//
// ## Watertight preserved + the safe-displacement bound (@errorBound-adjacent)
//
// A brush ONLY displaces existing vertices; it never adds/removes/retriangulates
// a face, so the mesh's connectivity — and therefore its manifold-edge /
// boundary-edge / component structure, i.e. its TOPOLOGICAL watertightness — is
// preserved BY CONSTRUCTION (the op re-runs `analyzeMesh` and refuses to return
// a non-watertight result regardless, per invariant 4). The tractable geometric
// failure a displacement CAN cause is a LOCAL FOLD: a triangle incident to a
// moved vertex whose normal reverses (or collapses to a sliver), which is the
// onset of a self-intersection. The guard: over the AFFECTED triangles (any
// triangle with ≥1 affected vertex) find, by deterministic bisection, the
// largest global scale `s ∈ (0, 1]` at which EVERY affected triangle still
// retains at least `minAreaFraction` of its original area projected on its
// original normal (`A(s) ≥ minAreaFraction · A(0)`; `A(s)` is continuous in `s`
// and `A(0) > 0`, so the safe scales form an interval `[0, s*)` and bisection
// converges). The stroke is applied at that `s` — `s = 1` is the unclamped
// stroke; `s < 1` is a CLAMPED stroke (reported as `clamped`, `appliedScale`),
// never a torn shell. **Safe-displacement bound:** a stroke displaces the
// surface only up to the point where the first affected triangle would fold;
// this guards LOCAL folds (the dominant tearing mode) exactly. It does NOT
// prove the absence of a GLOBAL self-intersection between two distant, both-
// moving patches — out of reach of a bounded local-normal displacement on a
// smooth shell, and surfaced honestly here rather than claimed away.
//
// ## The lock — protecting the fit surface (the whole point of this task)
//
// See `computeShellLock`: the fit surface (inner intaglio + inner margin rim +
// the margin-band seam's outer cervical rim) is identified on the ACTUAL shell
// (robust to the manifold-3d cleanup reindexing that makes the shell's vertex
// ORDER unusable) and frozen. Sculpting a LOCKED vertex is impossible — it is
// simply never in the affected set — so the ≤10 µm margin fit is preserved
// exactly (the locked vertices are byte-identical before/after any stroke).
import type { Vec3 } from '../bvh/geometry.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { buildBvh } from '../bvh/build.ts';
import { closestPointBatch } from '../bvh/closestPoint.ts';
import { buildHalfedge } from '../halfedge/build.ts';
import { oneRingVertices } from '../halfedge/iterate.ts';
import { computeVertexNormals } from '../curvature/normals.ts';
import { distanceToClosedPolyline } from '../offset/innerSurfaceOffset.ts';
import { analyzeMesh } from '../intake/analyze.ts';
import type { MeshStats } from '../intake/types.ts';

// ---------------------------------------------------------------------------
// Constants (documented, exact — part of the determinism/version contract)
// ---------------------------------------------------------------------------

/** Default: a shell vertex within this distance (mm) of the inner intaglio
 * surface IS a fit-surface vertex and is LOCKED. 20 µm — far below the 0.5 mm
 * minimum wall thickness (so it never catches an outer vertex) yet far above
 * the manifold-3d Float32 cleanup round-trip (< ~1 µm at crown scale), so it
 * cleanly separates inner from outer. */
export const SCULPT_LOCK_INNER_EPSILON_MM = 0.02;

/** Default number of topological one-ring GROWTH steps applied to the base
 * (distance-to-inner) lock. The outer cervical rim is stitched DIRECTLY to the
 * inner margin rim by the seam band, so one growth ring reaches it; the default
 * 2 locks the cervical rim plus a one-ring safety band of outer surface just
 * above it, guaranteeing every seam triangle has all-locked corners. */
export const SCULPT_LOCK_SEAM_RING_GROWTH = 2;

/** Default flip/degeneracy guard: an affected triangle must retain at least this
 * fraction of its original (projected-on-original-normal) area after a stroke.
 * Below it the triangle is folding to a sliver — the stroke is clamped. */
export const SCULPT_MIN_AREA_FRACTION = 0.1;

/** Deterministic bisection iterations for the safe-scale clamp (2^-24 ≈ 6e-8
 * relative resolution on the scale — far finer than any clinically meaningful
 * displacement difference). */
export const SCULPT_CLAMP_BISECTION_ITERS = 24;

export type SculptBrushType = 'add' | 'remove' | 'smooth';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when a stroke's parameters are not usable (non-finite / non-positive
 * radius, non-finite strength, unknown brush). A brush is a precise numeric op;
 * a malformed stroke is a loud typed failure, never a silent no-op. */
export class SculptStrokeParamError extends Error {
  constructor(reason: string) {
    super(`applySculptStroke: ${reason}`);
    this.name = 'SculptStrokeParamError';
  }
}

/** Thrown if, despite the topology-preserving guarantee, the sculpted mesh
 * fails watertight re-validation (defence in depth — invariant 4: never return
 * a shell that claims watertight without proving it). */
export class SculptNotWatertightError extends Error {
  readonly stats: MeshStats;
  constructor(stats: MeshStats) {
    super(
      `applySculptStroke: the sculpted mesh failed watertight re-validation ` +
        `(watertight=${stats.watertight}, boundaryEdgeCount=${stats.boundaryEdgeCount}, componentCount=${stats.componentCount}).`,
    );
    this.name = 'SculptNotWatertightError';
    this.stats = stats;
  }
}

// ---------------------------------------------------------------------------
// Stroke / gesture types
// ---------------------------------------------------------------------------

export interface SculptStroke {
  /** World-space stroke centre (mm). */
  readonly center: Vec3;
  /** Brush radius (mm) — vertices farther than this are unaffected. > 0. */
  readonly radiusMm: number;
  /** add/remove: peak outward/inward displacement (mm) at the centre; smooth:
   * peak blend fraction [0, 1] at the centre. Finite. */
  readonly strength: number;
  readonly brush: SculptBrushType;
}

export interface SculptStrokeOptions {
  /** Flip/degeneracy guard threshold (default {@link SCULPT_MIN_AREA_FRACTION}). */
  readonly minAreaFraction?: number;
  /** Bisection iterations for the clamp (default {@link SCULPT_CLAMP_BISECTION_ITERS}). */
  readonly clampIterations?: number;
  /** Skip the watertight re-validation (used internally by the gesture driver,
   * which validates ONCE at the end — every intermediate stroke preserves
   * topology identically, so re-checking each is redundant work). */
  readonly skipWatertightCheck?: boolean;
}

export interface SculptStrokeResult {
  /** The sculpted mesh — a NEW immutable value (same topology, some outer
   * vertices displaced). */
  readonly mesh: IndexedMesh;
  /** Outer vertices actually displaced by this stroke. */
  readonly movedVertexCount: number;
  /** Peak applied displacement magnitude (mm) — after any clamp. */
  readonly peakDisplacementMm: number;
  /** Global scale actually applied (1 = full stroke; < 1 = clamped by the
   * fold guard). */
  readonly appliedScale: number;
  /** True iff the fold guard clamped this stroke (`appliedScale < 1`). */
  readonly clamped: boolean;
  /** Mean discrete-Laplacian magnitude over the affected vertices, BEFORE and
   * AFTER the stroke — the local-curvature proxy. `smooth` drives after < before
   * (curvature reduced); reported for every brush. `0/0` regions report 0. */
  readonly curvatureBefore: number;
  readonly curvatureAfter: number;
}

// ---------------------------------------------------------------------------
// Lock computation
// ---------------------------------------------------------------------------

export interface ShellLockOptions {
  /** The inner intaglio surface (Task 4) — its vertices define the fit surface.
   * A shell vertex within `lockInnerEpsilonMm` of it is LOCKED. */
  readonly innerMesh: IndexedMesh;
  /** Confirmed margin polyline (dense). When present, shell vertices within
   * `marginLockBandMm` of it are additionally LOCKED (belt-and-braces seam
   * protection). Optional — the ring growth already captures the cervical rim. */
  readonly marginLoop?: readonly Vec3[];
  /** Distance (mm) to the inner surface below which a vertex is a fit vertex
   * (default {@link SCULPT_LOCK_INNER_EPSILON_MM}). */
  readonly lockInnerEpsilonMm?: number;
  /** Margin-polyline lock band (mm) — default 0 (rely on ring growth). */
  readonly marginLockBandMm?: number;
  /** Topological one-ring growth steps (default {@link SCULPT_LOCK_SEAM_RING_GROWTH}). */
  readonly seamRingGrowth?: number;
}

export interface ShellLockResult {
  /** Per-vertex lock flag (1 = locked / fit surface, 0 = sculptable outer). */
  readonly locked: Uint8Array;
  readonly lockedCount: number;
  /** Sculptable (outer) vertex count = totalVertices − lockedCount. */
  readonly outerCount: number;
}

/**
 * Identifies the LOCKED fit surface of a finished crown `shell` — the inner
 * intaglio + the inner margin rim + the margin-band seam's outer cervical rim —
 * so a sculpt brush can freeze it (protecting the ≤10 µm margin fit).
 *
 * Robust to the manifold-3d cleanup that reorders the shell's vertices (so the
 * `constructShell` triangle-range breakdown can't be used post-cleanup): the fit
 * surface is found by GEOMETRY + TOPOLOGY on the actual shell —
 *   1. base lock: every shell vertex within `lockInnerEpsilonMm` of the inner
 *      surface (the whole intaglio, including its exact margin rim);
 *   2. optional margin-polyline band;
 *   3. `seamRingGrowth` topological one-ring growth steps — the outer cervical
 *      rim is stitched directly to the inner margin rim by the seam, so growth
 *      reaches it, guaranteeing every seam triangle has all-locked corners and
 *      the seam ribbon never moves.
 * Deterministic, exact Float64.
 */
export function computeShellLock(shell: IndexedMesh, options: ShellLockOptions): ShellLockResult {
  const innerEps = options.lockInnerEpsilonMm ?? SCULPT_LOCK_INNER_EPSILON_MM;
  const marginBand = options.marginLockBandMm ?? 0;
  const ringGrowth = options.seamRingGrowth ?? SCULPT_LOCK_SEAM_RING_GROWTH;
  const vCount = shell.positions.length / 3;
  const locked = new Uint8Array(vCount);

  // 1. base: distance to the inner intaglio surface.
  const bvhInner = buildBvh(options.innerMesh);
  const dInner = closestPointBatch(options.innerMesh, bvhInner, shell.positions);
  for (let v = 0; v < vCount; v++) {
    if (dInner[v]!.distance <= innerEps) locked[v] = 1;
  }

  // 2. optional margin-polyline band.
  if (options.marginLoop && options.marginLoop.length >= 3 && marginBand > 0) {
    for (let v = 0; v < vCount; v++) {
      if (locked[v]) continue;
      const p: Vec3 = [shell.positions[v * 3]!, shell.positions[v * 3 + 1]!, shell.positions[v * 3 + 2]!];
      if (distanceToClosedPolyline(p, options.marginLoop) <= marginBand) locked[v] = 1;
    }
  }

  // 3. topological one-ring growth (captures the seam's outer cervical rim).
  if (ringGrowth > 0) {
    const hm = buildHalfedge(shell);
    let frontier: number[] = [];
    for (let v = 0; v < vCount; v++) if (locked[v]) frontier.push(v);
    for (let step = 0; step < ringGrowth; step++) {
      const next: number[] = [];
      for (const v of frontier) {
        for (const nb of oneRingVertices(hm, v)) {
          if (!locked[nb]) {
            locked[nb] = 1;
            next.push(nb);
          }
        }
      }
      if (next.length === 0) break;
      frontier = next;
    }
  }

  let lockedCount = 0;
  for (let v = 0; v < vCount; v++) if (locked[v]) lockedCount++;
  return { locked, lockedCount, outerCount: vCount - lockedCount };
}

// ---------------------------------------------------------------------------
// Brush application
// ---------------------------------------------------------------------------

function falloff(t: number): number {
  if (t >= 1) return 0;
  const s = 1 - t * t;
  return s * s;
}

/** Mean |discrete Laplacian| over the given vertex set, from `positions` and a
 * prebuilt neighbour list. `0` for an empty set. */
function meanLaplacianMagnitude(positions: Float64Array, neighbors: readonly number[][], verts: readonly number[]): number {
  if (verts.length === 0) return 0;
  let acc = 0;
  for (const v of verts) {
    const nb = neighbors[v]!;
    if (nb.length === 0) continue;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (const u of nb) {
      sx += positions[u * 3]!;
      sy += positions[u * 3 + 1]!;
      sz += positions[u * 3 + 2]!;
    }
    const inv = 1 / nb.length;
    const lx = sx * inv - positions[v * 3]!;
    const ly = sy * inv - positions[v * 3 + 1]!;
    const lz = sz * inv - positions[v * 3 + 2]!;
    acc += Math.hypot(lx, ly, lz);
  }
  return acc / verts.length;
}

/**
 * Applies ONE sculpt stroke to `mesh`, displacing only NON-locked (outer)
 * vertices per this module's documented brush math, with the fold guard
 * clamping any displacement that would tear the surface. Pure/deterministic:
 * same `(mesh, stroke, locked, options)` → byte-identical result.
 *
 * @throws {SculptStrokeParamError} on a malformed stroke.
 * @throws {SculptNotWatertightError} if the result fails watertight
 * re-validation (unless `skipWatertightCheck`).
 */
export function applySculptStroke(
  mesh: IndexedMesh,
  stroke: SculptStroke,
  locked: Uint8Array,
  options: SculptStrokeOptions = {},
): SculptStrokeResult {
  if (!(Number.isFinite(stroke.radiusMm) && stroke.radiusMm > 0)) {
    throw new SculptStrokeParamError(`radiusMm must be finite and > 0, got ${stroke.radiusMm}`);
  }
  if (!Number.isFinite(stroke.strength)) {
    throw new SculptStrokeParamError(`strength must be finite, got ${stroke.strength}`);
  }
  if (stroke.brush !== 'add' && stroke.brush !== 'remove' && stroke.brush !== 'smooth') {
    throw new SculptStrokeParamError(`unknown brush type ${String(stroke.brush)}`);
  }
  const vCount = mesh.positions.length / 3;
  if (locked.length !== vCount) {
    throw new SculptStrokeParamError(`locked mask length ${locked.length} !== vertex count ${vCount}`);
  }
  const minAreaFraction = options.minAreaFraction ?? SCULPT_MIN_AREA_FRACTION;
  const clampIters = options.clampIterations ?? SCULPT_CLAMP_BISECTION_ITERS;

  const origin = mesh.positions;
  const hm = buildHalfedge(mesh);
  // Pre-stroke snapshots (all displacements computed from these — order-free).
  const normals = computeVertexNormals(hm, mesh);
  const neighbors: number[][] = new Array(vCount);
  const needNeighbors = stroke.brush === 'smooth';
  // Neighbour lists are needed for smoothing AND for the curvature report — build
  // them once for every vertex we'll touch or report on (cheap; the affected set
  // is small). Build lazily per affected/reported vertex below instead of all V.

  const cx = stroke.center[0];
  const cy = stroke.center[1];
  const cz = stroke.center[2];
  const r = stroke.radiusMm;
  const invR = 1 / r;

  // Affected vertices + their (unscaled) displacement vectors.
  const affected: number[] = [];
  const dispX = new Float64Array(vCount);
  const dispY = new Float64Array(vCount);
  const dispZ = new Float64Array(vCount);

  const neighborsOf = (v: number): number[] => {
    let nb = neighbors[v];
    if (nb === undefined) {
      nb = oneRingVertices(hm, v);
      neighbors[v] = nb;
    }
    return nb;
  };

  for (let v = 0; v < vCount; v++) {
    if (locked[v]) continue;
    const px = origin[v * 3]!;
    const py = origin[v * 3 + 1]!;
    const pz = origin[v * 3 + 2]!;
    const d = Math.hypot(px - cx, py - cy, pz - cz);
    const t = d * invR;
    if (t >= 1) continue;
    const w = falloff(t);
    if (w === 0) continue;
    if (stroke.brush === 'smooth') {
      const nb = neighborsOf(v);
      if (nb.length === 0) continue;
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (const u of nb) {
        sx += origin[u * 3]!;
        sy += origin[u * 3 + 1]!;
        sz += origin[u * 3 + 2]!;
      }
      const inv = 1 / nb.length;
      const lambda = Math.max(0, Math.min(1, stroke.strength)) * w;
      dispX[v] = (sx * inv - px) * lambda;
      dispY[v] = (sy * inv - py) * lambda;
      dispZ[v] = (sz * inv - pz) * lambda;
    } else {
      const nx = normals[v * 3]!;
      const ny = normals[v * 3 + 1]!;
      const nz = normals[v * 3 + 2]!;
      if (nx === 0 && ny === 0 && nz === 0) continue; // undefined direction
      const sign = stroke.brush === 'add' ? 1 : -1;
      const amt = sign * stroke.strength * w;
      dispX[v] = nx * amt;
      dispY[v] = ny * amt;
      dispZ[v] = nz * amt;
    }
    affected.push(v);
  }

  // Curvature-before over affected vertices (needs neighbours).
  if (needNeighbors) {
    // already built for affected verts
  } else {
    for (const v of affected) neighborsOf(v);
  }
  const curvatureBefore = meanLaplacianMagnitude(origin, neighbors as number[][], affected);

  if (affected.length === 0) {
    // Nothing to do — return an immutable copy, topology + fit surface intact.
    const out: IndexedMesh = { positions: origin.slice(), indices: mesh.indices.slice() };
    return {
      mesh: out,
      movedVertexCount: 0,
      peakDisplacementMm: 0,
      appliedScale: 1,
      clamped: false,
      curvatureBefore,
      curvatureAfter: curvatureBefore,
    };
  }

  // --- Fold guard: collect affected triangles (≥1 affected vertex). ---
  const affectedFlag = new Uint8Array(vCount);
  for (const v of affected) affectedFlag[v] = 1;
  const triCount = mesh.indices.length / 3;
  interface GuardTri {
    ia: number;
    ib: number;
    ic: number;
    n0x: number;
    n0y: number;
    n0z: number;
    a0: number;
  }
  const guardTris: GuardTri[] = [];
  for (let t = 0; t < triCount; t++) {
    const ia = mesh.indices[t * 3]!;
    const ib = mesh.indices[t * 3 + 1]!;
    const ic = mesh.indices[t * 3 + 2]!;
    if (!affectedFlag[ia] && !affectedFlag[ib] && !affectedFlag[ic]) continue;
    const ax = origin[ia * 3]!;
    const ay = origin[ia * 3 + 1]!;
    const az = origin[ia * 3 + 2]!;
    const ux = origin[ib * 3]! - ax;
    const uy = origin[ib * 3 + 1]! - ay;
    const uz = origin[ib * 3 + 2]! - az;
    const wx = origin[ic * 3]! - ax;
    const wy = origin[ic * 3 + 1]! - ay;
    const wz = origin[ic * 3 + 2]! - az;
    const nx = uy * wz - uz * wy;
    const ny = uz * wx - ux * wz;
    const nz = ux * wy - uy * wx;
    const twiceArea = Math.hypot(nx, ny, nz);
    const a0 = twiceArea * 0.5;
    if (a0 < 1e-18) continue; // already-degenerate original triangle — cannot fold meaningfully
    const inv = 1 / twiceArea;
    guardTris.push({ ia, ib, ic, n0x: nx * inv, n0y: ny * inv, n0z: nz * inv, a0 });
  }

  // Projected-area (on the original normal) of a guard triangle at global
  // displacement scale s. Safe iff >= minAreaFraction * a0 for every one.
  const projectedArea = (g: GuardTri, s: number): number => {
    const ax = origin[g.ia * 3]! + s * dispX[g.ia]!;
    const ay = origin[g.ia * 3 + 1]! + s * dispY[g.ia]!;
    const az = origin[g.ia * 3 + 2]! + s * dispZ[g.ia]!;
    const bx = origin[g.ib * 3]! + s * dispX[g.ib]!;
    const by = origin[g.ib * 3 + 1]! + s * dispY[g.ib]!;
    const bz = origin[g.ib * 3 + 2]! + s * dispZ[g.ib]!;
    const ccx = origin[g.ic * 3]! + s * dispX[g.ic]!;
    const ccy = origin[g.ic * 3 + 1]! + s * dispY[g.ic]!;
    const ccz = origin[g.ic * 3 + 2]! + s * dispZ[g.ic]!;
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const wx = ccx - ax;
    const wy = ccy - ay;
    const wz = ccz - az;
    const nx = uy * wz - uz * wy;
    const ny = uz * wx - ux * wz;
    const nz = ux * wy - uy * wx;
    return 0.5 * (nx * g.n0x + ny * g.n0y + nz * g.n0z);
  };
  const isSafe = (s: number): boolean => {
    for (const g of guardTris) {
      if (projectedArea(g, s) < minAreaFraction * g.a0) return false;
    }
    return true;
  };

  let appliedScale: number;
  if (isSafe(1)) {
    appliedScale = 1;
  } else {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < clampIters; i++) {
      const mid = (lo + hi) * 0.5;
      if (isSafe(mid)) lo = mid;
      else hi = mid;
    }
    appliedScale = lo;
  }

  // Apply s·disp to affected vertices (immutable copy).
  const positions = origin.slice();
  let movedVertexCount = 0;
  let peakDisplacementMm = 0;
  for (const v of affected) {
    const ddx = appliedScale * dispX[v]!;
    const ddy = appliedScale * dispY[v]!;
    const ddz = appliedScale * dispZ[v]!;
    const mag = Math.hypot(ddx, ddy, ddz);
    if (mag === 0) continue;
    positions[v * 3] = origin[v * 3]! + ddx;
    positions[v * 3 + 1] = origin[v * 3 + 1]! + ddy;
    positions[v * 3 + 2] = origin[v * 3 + 2]! + ddz;
    movedVertexCount++;
    if (mag > peakDisplacementMm) peakDisplacementMm = mag;
  }

  const out: IndexedMesh = { positions, indices: mesh.indices.slice() };
  if (!options.skipWatertightCheck) {
    const stats = analyzeMesh(out);
    if (!stats.watertight || stats.componentCount !== 1) {
      throw new SculptNotWatertightError(stats);
    }
  }
  const curvatureAfter = meanLaplacianMagnitude(positions, neighbors as number[][], affected);

  return {
    mesh: out,
    movedVertexCount,
    peakDisplacementMm,
    appliedScale,
    clamped: appliedScale < 1,
    curvatureBefore,
    curvatureAfter,
  };
}

// ---------------------------------------------------------------------------
// Gesture (coalesced sequence — the journaled + replayed unit)
// ---------------------------------------------------------------------------

export interface SculptGestureResult {
  /** The mesh after applying every stroke in order — a NEW immutable value. */
  readonly mesh: IndexedMesh;
  /** Per-stroke report, in application order. */
  readonly strokeResults: readonly SculptStrokeResult[];
  /** Distinct outer vertices displaced across the whole gesture. */
  readonly movedVertexCount: number;
  /** Max peak displacement over the gesture's strokes (mm). */
  readonly peakDisplacementMm: number;
  /** Strokes the fold guard clamped. */
  readonly clampedStrokeCount: number;
  readonly stats: MeshStats;
}

/**
 * Applies a GESTURE — an ordered sequence of strokes — to `mesh`, each stroke
 * to the previous stroke's result, with the SAME lock frozen throughout (the
 * fit surface never moves, and vertex topology is constant so the mask stays
 * valid). This is the coalesced, journaled, replayable unit: same
 * `(mesh, strokes, locked, options)` → byte-identical mesh, so replaying the
 * journaled `strokes` from the original shell reproduces the sculpt bit-for-bit
 * (CLAUDE.md invariant 2). Watertight is re-validated ONCE at the end.
 *
 * @throws {SculptStrokeParamError} on a malformed stroke.
 * @throws {SculptNotWatertightError} if the final mesh fails re-validation.
 */
export function applySculptGesture(
  mesh: IndexedMesh,
  strokes: readonly SculptStroke[],
  locked: Uint8Array,
  options: SculptStrokeOptions = {},
): SculptGestureResult {
  const vCount = mesh.positions.length / 3;
  const everMoved = new Uint8Array(vCount);
  const strokeResults: SculptStrokeResult[] = [];
  let current = mesh;
  let peakDisplacementMm = 0;
  let clampedStrokeCount = 0;

  for (let i = 0; i < strokes.length; i++) {
    const isLast = i === strokes.length - 1;
    const res = applySculptStroke(current, strokes[i]!, locked, {
      ...options,
      // Validate only the final mesh (intermediate strokes preserve topology
      // identically — re-checking each is redundant work).
      skipWatertightCheck: options.skipWatertightCheck ?? !isLast,
    });
    strokeResults.push(res);
    if (res.peakDisplacementMm > peakDisplacementMm) peakDisplacementMm = res.peakDisplacementMm;
    if (res.clamped) clampedStrokeCount++;
    // Track distinct moved verts by comparing to the running mesh.
    for (let v = 0; v < vCount; v++) {
      if (
        current.positions[v * 3] !== res.mesh.positions[v * 3] ||
        current.positions[v * 3 + 1] !== res.mesh.positions[v * 3 + 1] ||
        current.positions[v * 3 + 2] !== res.mesh.positions[v * 3 + 2]
      ) {
        everMoved[v] = 1;
      }
    }
    current = res.mesh;
  }

  let movedVertexCount = 0;
  for (let v = 0; v < vCount; v++) if (everMoved[v]) movedVertexCount++;

  const stats = analyzeMesh(current);
  if (!stats.watertight || stats.componentCount !== 1) {
    throw new SculptNotWatertightError(stats);
  }

  return { mesh: current, strokeResults, movedVertexCount, peakDisplacementMm, clampedStrokeCount, stats };
}
