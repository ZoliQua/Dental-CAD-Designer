// packages/kernel/src/shell/shell.ts
//
// Phase 4 Task 7 — CROWN SHELL construction + wall-thickness measurement +
// auto-thicken. Turns the morphed outer anatomy (Task 6) and the intaglio
// inner surface (Task 4) into a SINGLE WATERTIGHT crown shell, measures the
// minimum wall thickness across it, and (on explicit request) thickens
// walls that fall below the material minimum.
//
// ## The shell join — outer + inner joined at the margin band (the seam)
//
// The crown shell is topologically a hollow solid (genus 0): the OUTER
// anatomy surface is its exterior, the INNER intaglio surface is its
// interior (the fit surface that seats on the die), and the two are joined
// along the MARGIN — the crown's finish-line edge. Both surfaces are open:
//
//   • the outer anatomy is an occlusally-capped dome whose single open
//     boundary is its CERVICAL rim (near the margin);
//   • the inner intaglio (buildInnerSurface, Task 4) is an occlusally-capped
//     cup whose single open boundary IS the confirmed margin polyline (the
//     skirt's bottom rim — the ≤10 µm marginal seal).
//
// `constructShell` bridges those two rims with a MARGIN-BAND ribbon (the
// seam): a ruled annulus stitched by the same deterministic azimuth-fraction
// zipper `offset/innerSurfaceSolid.ts`'s skirt uses (advance whichever ring
// is behind in normalized arc-position; strictly monotone, so it never
// backtracks and is robust to a jagged marching-cubes intaglio rim whose
// per-vertex azimuth is non-monotone). This generalizes `margin/band.ts`'s
// `marginLoopMesh` (a ribbon between a loop and its OWN normal-offset copy)
// to a ribbon between the TWO DISTINCT rims a real crown has — the outer
// cervical rim and the inner margin rim, which are generally different loops
// (different vertex counts, offset by the marginal wall thickness), so a
// fixed ±h collar cannot bridge them.
//
// The stitched surface is a closed 2-manifold; it is then passed through the
// manifold-3d wrapper (`boolean/manifold.ts`'s `cleanupMesh`) — which
// CONSTRUCTS a manifold-3d `Manifold` (validating the oriented-2-manifold
// invariant and collapsing degenerate slivers the stitch may create) and
// returns the cleaned solid. `cleanupMesh` THROWS `NonManifoldInputError`
// if the stitched mesh is not a valid closed 2-manifold, so a non-watertight
// stitch can never masquerade as a shell — and `constructShell` additionally
// re-runs `analyzeMesh` on the RESULT and throws `ShellNotWatertightError`
// unless it is watertight and single-component. (Repair-before-boolean: the
// stitch is watertight BY CONSTRUCTION, so no intake repair is needed before
// the wrapper; a caller feeding a topologically broken outer/inner gets a
// loud typed failure, never a silent bad shell.)
//
// ## Determinism across the WASM boundary
//
// The stitch is pure Float64 and deterministic; the ONLY nondeterminism risk
// is the manifold-3d Float32 round-trip inside `cleanupMesh`, whose output
// hash depends on the manifold-3d WASM BUILD (not just the inputs). Same
// inputs + same manifold-3d version ⇒ byte-identical shell (proven by the
// determinism test); a manifold-3d build change is caught by the
// manifoldVersion-guarded golden (test/golden/kernel-ops.test.ts), NOT
// mistaken for a kernel regression.
//
// ## Wall-thickness measurement (fail-safe: over-report thin, never under)
//
// `measureWallThickness` measures the minimum wall thickness as the
// closest-point distance BETWEEN the inner and outer surfaces, sampled at
// BOTH meshes' vertices (inner→outer AND outer→inner, min of the two — the
// more conservative direction). The straight-line nearest-surface distance
// is a LOWER BOUND on the true through-material wall thickness (any path
// through the wall is at least as long as the straight-line gap), so this
// OVER-reports thinness and can never silently pass a genuinely thin wall.
//
// @errorBound The pointwise distance is EXACT Float64 (bvh/closestPoint is
// exact closest-point-on-triangle, no Float32 anywhere here — the shell mesh
// this measures is the manifold-3d OUTPUT, but the thickness scan runs on the
// Float64 inner/outer INPUT surfaces, not through manifold-3d). The only
// approximation is DISCRETE SAMPLING: the minimum is exact at the sampled
// vertices; a thin feature narrower than the local vertex spacing could sit
// between samples. `sampleSpacingMm` (the max sampled-vertex spacing) is
// reported as the localization resolution and surfaced to the QC report;
// because the distance itself is a conservative lower bound, the reported
// minimum still errs toward flagging thinness. Sampling BOTH surfaces
// halves the effective miss risk (a thin spot missed on one surface's
// vertices is usually hit on the other's).
import type { Vec3 } from '../bvh/geometry.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import type { MeshStats } from '../intake/types.ts';
import { buildBvh } from '../bvh/build.ts';
import { closestPoint, closestPointBatch } from '../bvh/closestPoint.ts';
import { buildHalfedge } from '../halfedge/build.ts';
import { findBoundaryLoops, destinationVertex } from '../halfedge/iterate.ts';
import { analyzeMesh } from '../intake/analyze.ts';
import { orientNormalsConsistently } from '../intake/orient.ts';
import { orthonormalBasis } from '../axis/hemisphere.ts';
import { distanceToClosedPolyline } from '../offset/innerSurfaceOffset.ts';
import { cleanupMesh } from '../boolean/manifold.ts';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when the outer anatomy or inner surface does not present exactly
 * one usable open boundary loop to stitch (a closed mesh has none; a badly
 * cropped one may have several). The shell join expects an OPEN outer dome
 * (single cervical rim) and an OPEN inner cup (single margin rim); anything
 * else is a loud typed failure, never a silently unsealed shell. */
export class ShellBoundaryError extends Error {
  constructor(which: 'outer' | 'inner', loopCount: number) {
    super(
      `constructShell: the ${which} surface has ${loopCount} boundary loop(s); the shell join needs exactly one open rim to ` +
        `stitch (an OPEN ${which === 'outer' ? 'occlusally-capped anatomy dome (cervical rim)' : 'intaglio cup (margin rim)'}).`,
    );
    this.name = 'ShellBoundaryError';
  }
}

/** Thrown when the constructed shell, AFTER the manifold-3d cleanup pass,
 * fails re-validation (not watertight, or more than one connected
 * component). A false "watertight" claim on a QC-gated solid is the worst
 * possible outcome (CLAUDE.md invariant 4), so this fails loudly with the
 * measured stats rather than returning a bad shell. */
export class ShellNotWatertightError extends Error {
  readonly stats: MeshStats;
  constructor(stats: MeshStats) {
    super(
      `constructShell: the constructed shell is not a watertight single-component solid after manifold cleanup ` +
        `(watertight=${stats.watertight}, manifoldEdges=${stats.manifoldEdges}, boundaryEdgeCount=${stats.boundaryEdgeCount}, ` +
        `componentCount=${stats.componentCount}) — refusing to return a non-watertight shell.`,
    );
    this.name = 'ShellNotWatertightError';
    this.stats = stats;
  }
}

// ---------------------------------------------------------------------------
// constructShell
// ---------------------------------------------------------------------------

export interface ConstructShellParams {
  /** Insertion axis (crown draw direction), points occlusally — normalized
   * internally. Used only to give the azimuth zipper a stable rotation axis
   * for measuring each rim's arc-position. */
  readonly insertionAxis: Vec3;
}

export interface ConstructShellHooks {
  /** Fraction in [0, 1] at phase boundaries. */
  readonly onProgress?: (fraction: number) => void;
  /** Awaited at phase boundaries — should THROW to cancel. Affects no
   * computed value (byte-identity contract). */
  readonly checkCancel?: () => Promise<void>;
}

export interface ConstructShellResult {
  /** The watertight crown shell (manifold-3d cleaned). A NEW immutable mesh. */
  readonly mesh: IndexedMesh;
  readonly stats: MeshStats;
  /** Triangles in the margin-band seam ribbon (outer rim ↔ inner rim). */
  readonly seamTriangleCount: number;
  readonly outerRimVertexCount: number;
  readonly innerRimVertexCount: number;
  /** Shell volume, mm³ (signed volume from analyzeMesh; always > 0 here). */
  readonly volumeMm3: number;
}

function normalizeAxis(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!(len > 0)) throw new TypeError('constructShell: insertionAxis must be a non-zero vector');
  return [v[0] / len, v[1] / len, v[2] / len];
}

/** Ordered vertex-index boundary loops (map each halfedge boundary loop to
 * its destination vertices — mirrors innerSurfaceSolid.ts's
 * `boundaryVertexLoops`). */
function boundaryVertexLoops(mesh: IndexedMesh): number[][] {
  const hm = buildHalfedge(mesh);
  return findBoundaryLoops(hm).map((loop) => loop.map((he) => destinationVertex(hm, he)));
}

/** The single open rim of `mesh` to stitch: the boundary loop with the most
 * vertices (the main opening). Throws {@link ShellBoundaryError} if there is
 * none. Extra small loops (if any) are left for the manifold cleanup to
 * reject as boundary — a loud failure, never a silent hole. */
function pickRim(mesh: IndexedMesh, which: 'outer' | 'inner'): number[] {
  const loops = boundaryVertexLoops(mesh);
  if (loops.length === 0) throw new ShellBoundaryError(which, 0);
  let best = loops[0]!;
  for (const l of loops) if (l.length > best.length) best = l;
  return best;
}

function meshVertex(mesh: IndexedMesh, i: number): Vec3 {
  return [mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!];
}

/**
 * Builds the margin-band seam: a ruled annulus stitching the outer rim
 * (indices into `outer`) to the inner rim (indices into `inner`), returning
 * the COMBINED (outer verts, then inner verts) mesh with the outer + inner
 * triangles + the seam triangles. Both rims encircle the insertion axis; the
 * zipper advances whichever ring is behind in normalized arc-position (i/M vs
 * j/N) — strictly monotone, deterministic. Rings are first oriented CCW
 * around the axis and aligned at their nearest-azimuth start so the pairing
 * never crosses.
 */
function stitchMarginBand(
  outer: IndexedMesh,
  outerRim: number[],
  inner: IndexedMesh,
  innerRim: number[],
  axisUnit: Vec3,
): { mesh: IndexedMesh; seamTriangleCount: number } {
  const outerV = outer.positions.length / 3;
  const positions = new Float64Array(outer.positions.length + inner.positions.length);
  positions.set(outer.positions, 0);
  positions.set(inner.positions, outer.positions.length);

  const op = (i: number): Vec3 => meshVertex(outer, i);
  const ip = (i: number): Vec3 => meshVertex(inner, i);

  // Common center + tangent basis (from the inner/margin rim — the sealed,
  // clinically-anchored loop) for a consistent azimuth of both rings.
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const vi of innerRim) {
    const p = ip(vi);
    cx += p[0];
    cy += p[1];
    cz += p[2];
  }
  cx /= innerRim.length;
  cy /= innerRim.length;
  cz /= innerRim.length;
  const { u, v } = orthonormalBasis(axisUnit);
  const projUV = (p: Vec3): [number, number] => {
    const dx = p[0] - cx;
    const dy = p[1] - cy;
    const dz = p[2] - cz;
    return [dx * u[0] + dy * u[1] + dz * u[2], dx * v[0] + dy * v[1] + dz * v[2]];
  };
  const az = (p: Vec3): number => {
    const [pu, pv] = projUV(p);
    return Math.atan2(pv, pu);
  };
  const signedArea = (idxs: number[], get: (i: number) => Vec3): number => {
    let a = 0;
    const n = idxs.length;
    for (let k = 0; k < n; k++) {
      const [x0, y0] = projUV(get(idxs[k]!));
      const [x1, y1] = projUV(get(idxs[(k + 1) % n]!));
      a += x0 * y1 - x1 * y0;
    }
    return a * 0.5;
  };

  const outerOrder = [...outerRim];
  if (signedArea(outerOrder, op) < 0) outerOrder.reverse();
  let innerOrder = [...innerRim];
  if (signedArea(innerOrder, ip) < 0) innerOrder.reverse();

  // Align the inner ring's start to the outer ring's start (nearest azimuth).
  const a0 = az(op(outerOrder[0]!));
  let startK = 0;
  let bestDiff = Infinity;
  for (let k = 0; k < innerOrder.length; k++) {
    let d = Math.abs(az(ip(innerOrder[k]!)) - a0);
    if (d > Math.PI) d = 2 * Math.PI - d;
    if (d < bestDiff) {
      bestDiff = d;
      startK = k;
    }
  }
  innerOrder = [...innerOrder.slice(startK), ...innerOrder.slice(0, startK)];

  const M = outerOrder.length;
  const N = innerOrder.length;
  const innerVi = (idx: number): number => outerV + innerOrder[idx % N]!;

  // Combined triangles: outer + inner (re-indexed) + seam.
  const seamTris: number[] = [];
  let i = 0;
  let j = 0;
  while (i < M || j < N) {
    const oCur = outerOrder[i % M]!;
    const iCur = innerVi(j);
    const advanceO = j >= N || (i < M && (i + 1) / M <= (j + 1) / N);
    if (advanceO) {
      const oNext = outerOrder[(i + 1) % M]!;
      seamTris.push(oCur, iCur, oNext);
      i++;
    } else {
      const iNext = innerVi(j + 1);
      seamTris.push(oCur, iNext, iCur);
      j++;
    }
  }

  const indices = new Uint32Array(outer.indices.length + inner.indices.length + seamTris.length);
  indices.set(outer.indices, 0);
  for (let t = 0; t < inner.indices.length; t++) indices[outer.indices.length + t] = inner.indices[t]! + outerV;
  indices.set(seamTris, outer.indices.length + inner.indices.length);

  return { mesh: { positions, indices }, seamTriangleCount: seamTris.length / 3 };
}

/** Flips every triangle's winding (in place on a copy) — used to pin the
 * shell to outward orientation (positive signed volume). */
function flipWinding(mesh: IndexedMesh): IndexedMesh {
  const idx = mesh.indices.slice();
  for (let t = 0; t < idx.length / 3; t++) {
    const tmp = idx[t * 3 + 1]!;
    idx[t * 3 + 1] = idx[t * 3 + 2]!;
    idx[t * 3 + 2] = tmp;
  }
  return { positions: mesh.positions, indices: idx };
}

/**
 * Constructs the watertight crown shell from the outer anatomy + inner
 * intaglio, joined at the margin band — see this module's doc for the full
 * construction, the manifold-wrapper validation, and the determinism story.
 * Deterministic: same inputs + same manifold-3d version ⇒ byte-identical shell.
 *
 * @throws {ShellBoundaryError} if the outer/inner surface lacks a single open rim.
 * @throws {NonManifoldInputError} (from the wrapper) if the stitched surface
 * is not a valid closed 2-manifold.
 * @throws {ShellNotWatertightError} if the cleaned shell is not a watertight
 * single-component solid.
 */
export async function constructShell(
  outerMesh: IndexedMesh,
  innerMesh: IndexedMesh,
  params: ConstructShellParams,
  hooks?: ConstructShellHooks,
): Promise<ConstructShellResult> {
  const axisUnit = normalizeAxis(params.insertionAxis);
  if (hooks?.checkCancel) await hooks.checkCancel();
  hooks?.onProgress?.(0);

  const outerRim = pickRim(outerMesh, 'outer');
  const innerRim = pickRim(innerMesh, 'inner');
  hooks?.onProgress?.(0.15);

  const { mesh: stitched, seamTriangleCount } = stitchMarginBand(outerMesh, outerRim, innerMesh, innerRim, axisUnit);
  if (hooks?.checkCancel) await hooks.checkCancel();
  hooks?.onProgress?.(0.4);

  // One connected component (outer + seam + inner) — make it consistently
  // oriented, then pin to OUTWARD (positive signed volume) so the manifold
  // wrapper and every downstream consumer see one deterministic global sign.
  const oriented = orientNormalsConsistently(stitched).mesh;
  const orientedStats = analyzeMesh(oriented);
  const outwardOriented =
    orientedStats.signedVolumeMm3 !== null && orientedStats.signedVolumeMm3 < 0 ? flipWinding(oriented) : oriented;
  hooks?.onProgress?.(0.55);

  // Re-validate + clean via the manifold-3d wrapper. Throws
  // NonManifoldInputError if the stitch is not a valid closed 2-manifold.
  const shell = await cleanupMesh(outwardOriented);
  if (hooks?.checkCancel) await hooks.checkCancel();
  hooks?.onProgress?.(0.9);

  const stats = analyzeMesh(shell);
  if (!stats.watertight || stats.componentCount !== 1) {
    throw new ShellNotWatertightError(stats);
  }
  hooks?.onProgress?.(1);

  return {
    mesh: shell,
    stats,
    seamTriangleCount,
    outerRimVertexCount: outerRim.length,
    innerRimVertexCount: innerRim.length,
    volumeMm3: stats.signedVolumeMm3 ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Wall thickness
// ---------------------------------------------------------------------------

/** Cosine threshold classifying a wall sample as OCCLUSAL vs AXIAL: the wall
 * direction (sample → nearest point on the opposing surface) is occlusal
 * (measured along the insertion axis) if |direction · axis| ≥ this (≈ 45°). */
const OCCLUSAL_WALL_COS = Math.SQRT1_2;

export interface WallThicknessOptions {
  /** Insertion axis (occlusal direction) — required to classify occlusal vs
   * axial walls. Omit to classify everything as axial. */
  readonly insertionAxis?: Vec3;
  /** Confirmed margin polyline — samples within `marginExclusionMm` of it are
   * EXCLUDED from the minimum (the crown feathers to ~0 thickness at the
   * finish-line edge by design; that edge is a marginal-integrity concern,
   * not a wall-too-thin defect). Omit to include every sample. */
  readonly marginLoop?: readonly Vec3[];
  /** Distance (mm) from the margin polyline within which samples are excluded
   * (default 0 — no exclusion; a caller with a feather margin sets this). */
  readonly marginExclusionMm?: number;
}

export interface WallThicknessResult {
  /** Minimum wall thickness (mm) over all INCLUDED samples, both directions —
   * a conservative lower bound of the true through-material thickness. */
  readonly minThicknessMm: number;
  /** Minimum over occlusal-classified samples (Infinity if none). */
  readonly minOcclusalThicknessMm: number;
  /** Minimum over axial-classified samples (Infinity if none). */
  readonly minAxialThicknessMm: number;
  /** World position of the thinnest included sample. */
  readonly minPoint: Vec3;
  /** Included sample count (both surfaces). */
  readonly sampleCount: number;
  /** Samples excluded by the margin band. */
  readonly excludedCount: number;
  /** Per-INNER-vertex thickness (mm) — the heatmap over the intaglio; the
   * raw inner→outer distance at each inner vertex (excluded vertices keep
   * their true distance, not masked). Length = inner vertex count. */
  readonly perInnerVertexMm: Float64Array;
  /** Localization resolution (mm): the max sampled-vertex spacing — see the
   * module `@errorBound`. The distance VALUE is exact Float64. */
  readonly sampleSpacingMm: number;
  /** The measurement's error bound surfaced to the QC report — the sampling
   * resolution (`sampleSpacingMm`); the thickness value itself is exact and
   * conservative (a lower bound). */
  readonly errorBoundMm: number;
}

/** Max edge length in a mesh (the vertex spacing bound for the sampling
 * resolution). */
function maxEdgeLength(mesh: IndexedMesh): number {
  let max = 0;
  const tri = mesh.indices.length / 3;
  for (let t = 0; t < tri; t++) {
    const a = mesh.indices[t * 3]!;
    const b = mesh.indices[t * 3 + 1]!;
    const c = mesh.indices[t * 3 + 2]!;
    for (const [i, j] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const dx = mesh.positions[i * 3]! - mesh.positions[j * 3]!;
      const dy = mesh.positions[i * 3 + 1]! - mesh.positions[j * 3 + 1]!;
      const dz = mesh.positions[i * 3 + 2]! - mesh.positions[j * 3 + 2]!;
      const d = Math.hypot(dx, dy, dz);
      if (d > max) max = d;
    }
  }
  return max;
}

/**
 * Measures the crown-shell wall thickness as the inner↔outer closest-surface
 * distance, sampled at both meshes' vertices (min of both directions — the
 * conservative choice). See this module's doc + `@errorBound`. Pure,
 * deterministic, exact Float64 at the sampled points.
 */
export function measureWallThickness(
  innerMesh: IndexedMesh,
  outerMesh: IndexedMesh,
  options: WallThicknessOptions = {},
): WallThicknessResult {
  const axis = options.insertionAxis ? normalizeAxis(options.insertionAxis) : null;
  const marginLoop = options.marginLoop;
  const exclusion = options.marginExclusionMm ?? 0;
  const excluded = (p: Vec3): boolean =>
    marginLoop !== undefined && exclusion > 0 && distanceToClosedPolyline(p, marginLoop) < exclusion;

  const bvhOuter = buildBvh(outerMesh);
  const bvhInner = buildBvh(innerMesh);

  const innerRes = closestPointBatch(outerMesh, bvhOuter, innerMesh.positions);
  const outerRes = closestPointBatch(innerMesh, bvhInner, outerMesh.positions);

  const perInnerVertexMm = new Float64Array(innerRes.length);
  for (let i = 0; i < innerRes.length; i++) perInnerVertexMm[i] = innerRes[i]!.distance;

  let minThicknessMm = Infinity;
  let minOcclusalThicknessMm = Infinity;
  let minAxialThicknessMm = Infinity;
  let minPoint: Vec3 = [0, 0, 0];
  let sampleCount = 0;
  let excludedCount = 0;

  const consider = (sample: Vec3, near: readonly [number, number, number], dist: number): void => {
    if (excluded(sample)) {
      excludedCount++;
      return;
    }
    sampleCount++;
    if (dist < minThicknessMm) {
      minThicknessMm = dist;
      minPoint = sample;
    }
    // Occlusal iff the wall direction (sample → nearest opposing point) runs
    // along the insertion axis.
    let occlusal = false;
    if (axis) {
      const dx = near[0] - sample[0];
      const dy = near[1] - sample[1];
      const dz = near[2] - sample[2];
      const len = Math.hypot(dx, dy, dz);
      if (len > 0) {
        const dot = Math.abs((dx * axis[0] + dy * axis[1] + dz * axis[2]) / len);
        occlusal = dot >= OCCLUSAL_WALL_COS;
      }
    }
    if (occlusal) {
      if (dist < minOcclusalThicknessMm) minOcclusalThicknessMm = dist;
    } else if (dist < minAxialThicknessMm) {
      minAxialThicknessMm = dist;
    }
  };

  for (let i = 0; i < innerRes.length; i++) {
    consider(meshVertex(innerMesh, i), innerRes[i]!.point, innerRes[i]!.distance);
  }
  for (let i = 0; i < outerRes.length; i++) {
    consider(meshVertex(outerMesh, i), outerRes[i]!.point, outerRes[i]!.distance);
  }

  if (sampleCount === 0) {
    minThicknessMm = Infinity;
  }
  const sampleSpacingMm = Math.max(maxEdgeLength(innerMesh), maxEdgeLength(outerMesh));

  return {
    minThicknessMm,
    minOcclusalThicknessMm,
    minAxialThicknessMm,
    minPoint,
    sampleCount,
    excludedCount,
    perInnerVertexMm,
    sampleSpacingMm,
    errorBoundMm: sampleSpacingMm,
  };
}

// ---------------------------------------------------------------------------
// autoThicken
// ---------------------------------------------------------------------------

/** Default overshoot factor — each pass pushes `overshoot ×` the measured
 * deficit. A vertex-displacement thickening leaves the TRIANGULATED surface
 * (and the opposing surface's own vertices) slightly short of the target
 * between moved vertices — most acutely opposite a convex intaglio corner,
 * whose nearest-outer distance a single outward nudge cannot fully raise; a
 * >1 overshoot clears that discretization gap (over-thickening, bounded by
 * `maxDisplacementMm`, is clinically safe — thicker walls are stronger). */
export const AUTO_THICKEN_DEFAULT_OVERSHOOT = 1.5;
/** Default number of deterministic convergence passes. */
export const AUTO_THICKEN_DEFAULT_PASSES = 5;

export interface AutoThickenParams {
  /** The target minimum wall thickness (mm) — from the material profile
   * (NEVER defaulted in kernel/pipeline code). Thin regions are pushed to
   * meet this. */
  readonly minThicknessMm: number;
  /** Maximum TOTAL outward displacement (mm) applied to any outer vertex
   * (accumulated over passes) — bounds the correction so a grossly-thin
   * design cannot be silently ballooned (a clamped vertex is reported, not
   * hidden). */
  readonly maxDisplacementMm: number;
  /** Overshoot factor (default {@link AUTO_THICKEN_DEFAULT_OVERSHOOT}). */
  readonly overshoot?: number;
  /** Convergence passes (default {@link AUTO_THICKEN_DEFAULT_PASSES}). */
  readonly passes?: number;
  /** Margin polyline — vertices within `marginExclusionMm` of it are NOT
   * displaced (the feather edge is left intact). */
  readonly marginLoop?: readonly Vec3[];
  readonly marginExclusionMm?: number;
}

export interface AutoThickenResult {
  /** The thickened OUTER anatomy (a NEW mesh; same topology, some vertices
   * displaced outward). Feed this back through `constructShell`. */
  readonly mesh: IndexedMesh;
  /** Outer vertices actually displaced. */
  readonly displacedVertexCount: number;
  /** Largest displacement applied (mm). */
  readonly maxAppliedMm: number;
  /** Vertices whose needed correction EXCEEDED `maxDisplacementMm` and were
   * clamped — their wall may still be below target after thickening (a
   * WARNING the caller journals, never a silent success). */
  readonly clampedVertexCount: number;
}

/**
 * User-invoked, bounded auto-thicken: pushes each OUTER-anatomy vertex whose
 * local wall thickness is below `minThicknessMm` outward (directly away from
 * its nearest point on the inner surface — the direction guaranteed to
 * increase the inner↔outer gap), by exactly the deficit, clamped to
 * `maxDisplacementMm`. Never thins anything; never runs silently (the caller
 * gates it behind an explicit user action and journals it — CLAUDE.md
 * invariant 5). Deterministic.
 *
 * @throws {TypeError} if `minThicknessMm`/`maxDisplacementMm` are not finite & > 0.
 */
export function autoThickenOuter(
  outerMesh: IndexedMesh,
  innerMesh: IndexedMesh,
  params: AutoThickenParams,
): AutoThickenResult {
  if (!(Number.isFinite(params.minThicknessMm) && params.minThicknessMm > 0)) {
    throw new TypeError(`autoThickenOuter: minThicknessMm must be finite and > 0, got ${params.minThicknessMm}`);
  }
  if (!(Number.isFinite(params.maxDisplacementMm) && params.maxDisplacementMm > 0)) {
    throw new TypeError(`autoThickenOuter: maxDisplacementMm must be finite and > 0, got ${params.maxDisplacementMm}`);
  }
  const overshoot = params.overshoot ?? AUTO_THICKEN_DEFAULT_OVERSHOOT;
  const passes = params.passes ?? AUTO_THICKEN_DEFAULT_PASSES;
  if (!(Number.isFinite(overshoot) && overshoot > 0)) {
    throw new TypeError(`autoThickenOuter: overshoot must be finite and > 0, got ${overshoot}`);
  }
  if (!(Number.isInteger(passes) && passes >= 1)) {
    throw new TypeError(`autoThickenOuter: passes must be an integer >= 1, got ${passes}`);
  }
  const marginLoop = params.marginLoop;
  const exclusion = params.marginExclusionMm ?? 0;
  const bvhInner = buildBvh(innerMesh);

  const origin = outerMesh.positions;
  const positions = outerMesh.positions.slice();
  const vCount = positions.length / 3;
  const excludedVertex = new Uint8Array(vCount);
  for (let v = 0; v < vCount; v++) {
    if (
      marginLoop !== undefined &&
      exclusion > 0 &&
      distanceToClosedPolyline([origin[v * 3]!, origin[v * 3 + 1]!, origin[v * 3 + 2]!], marginLoop) < exclusion
    ) {
      excludedVertex[v] = 1;
    }
  }

  // Deterministic convergence: each pass re-measures thickness to the FIXED
  // inner surface (BVH built once) and pushes (overshoot × remaining deficit)
  // outward, with each vertex's TOTAL displacement from its ORIGINAL position
  // capped at maxDisplacementMm.
  const everDisplaced = new Uint8Array(vCount);
  for (let pass = 0; pass < passes; pass++) {
    for (let v = 0; v < vCount; v++) {
      if (excludedVertex[v]) continue;
      const p: Vec3 = [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!];
      const cp = closestPoint(innerMesh, bvhInner, p);
      const thickness = cp.distance;
      if (thickness >= params.minThicknessMm) continue;
      // Direction: directly away from the nearest inner point (increases the gap).
      let dx = p[0] - cp.point[0];
      let dy = p[1] - cp.point[1];
      let dz = p[2] - cp.point[2];
      const len = Math.hypot(dx, dy, dz);
      if (!(len > 0)) continue; // sits ON the inner surface — no safe direction
      dx /= len;
      dy /= len;
      dz /= len;
      const want = (params.minThicknessMm - thickness) * overshoot;
      const ox = origin[v * 3]!;
      const oy = origin[v * 3 + 1]!;
      const oz = origin[v * 3 + 2]!;
      const already = Math.hypot(p[0] - ox, p[1] - oy, p[2] - oz);
      const step = Math.max(0, Math.min(want, params.maxDisplacementMm - already));
      if (step <= 0) continue;
      positions[v * 3] = p[0] + dx * step;
      positions[v * 3 + 1] = p[1] + dy * step;
      positions[v * 3 + 2] = p[2] + dz * step;
      everDisplaced[v] = 1;
    }
  }

  // Report: displaced count, max TOTAL applied, and clamped (still below target
  // AND at the displacement bound — could not fully reach the floor).
  let displacedVertexCount = 0;
  let clampedVertexCount = 0;
  let maxAppliedMm = 0;
  for (let v = 0; v < vCount; v++) {
    if (!everDisplaced[v]) continue;
    displacedVertexCount++;
    const total = Math.hypot(
      positions[v * 3]! - origin[v * 3]!,
      positions[v * 3 + 1]! - origin[v * 3 + 1]!,
      positions[v * 3 + 2]! - origin[v * 3 + 2]!,
    );
    if (total > maxAppliedMm) maxAppliedMm = total;
    const cp = closestPoint(innerMesh, bvhInner, [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!]);
    if (cp.distance < params.minThicknessMm && total >= params.maxDisplacementMm - 1e-9) clampedVertexCount++;
  }

  return {
    mesh: { positions, indices: outerMesh.indices.slice() },
    displacedVertexCount,
    maxAppliedMm,
    clampedVertexCount,
  };
}
