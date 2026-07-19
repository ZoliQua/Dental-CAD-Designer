// packages/kernel/src/offset/offsetMesh.ts
//
// Offset surfaces (Phase 2 Task 7): `offsetMesh(mesh, distanceMm,
// { pitchMm })` — the cement-gap geometry foundation for Phase 4 crowns
// (PLAN.md §5 Phase 2 "Offset surfaces: distance-field based"). Pipeline:
//
//   1. banded SDF grid over the mesh (sdf/grid.ts — `bandMm` is ALWAYS
//      passed; see `offsetGridSpec` for the band/padding derivation),
//   2. marching cubes at iso value = `distanceMm` (marchingCubes.ts),
//   3. weld (intake/weld.ts) + manifold cleanup (boolean/manifold.ts's
//      `cleanupMesh` — validates watertight/manifold, collapses residual
//      degenerate slivers),
//   4. `analyzeMesh` stats over the FINAL cleaned mesh.
//
// ## Sign convention (documented per this task's brief, and tested)
//
// `distanceMm > 0` offsets OUTWARD (grows the solid: a sphere of radius r
// becomes radius r + d); `distanceMm < 0` offsets INWARD (shrinks: radius
// r + d = r - |d|). This follows directly from the SDF's negative-inside
// convention (sdf/signedDistance.ts): the iso surface `{f = d}` for d > 0
// is the locus of points d mm OUTSIDE the original surface.
//
// ## Async, unlike most kernel algorithms
//
// The manifold cleanup step goes through the manifold-3d WASM wrapper,
// whose API is async (one-time WASM instantiation) — so `offsetMesh` is
// async, same as the boolean ops it shares that wrapper with
// (boolean/manifold.ts's `union`/`subtract`/...). The heavy synchronous
// stages (SDF sampling, marching cubes) are exposed as per-slice/per-slab
// primitives so kernel-workers/src/jobs/offset.ts can drive them itself
// with real progress + cancellation between slices/slabs (same split as
// sdf/grid.ts vs. jobs/sdf.ts).
//
// @errorBound `errorBoundMm = pitchMm / 2 + eps_f32`, carried in the result
// struct (PLAN §6.6: bounds surfaced for later QC). Derivation (honest, no
// hand-waving — each term below is proven, not assumed):
//
//  1. Grid samples are EXACT signed distances to the input mesh
//     (`signedClosestPoint`: no approximation, Float64 — see its own
//     `@errorBound`), rounded once to Float32 storage (relative error
//     ≤ 1.19e-7 — sdf/grid.ts's documented boundary).
//  2. A marching-cubes vertex `v` lies on a grid edge of length `pitch`
//     whose endpoint samples straddle `d = distanceMm`, placed where the
//     LINEAR interpolant crosses `d`. The SDF `f` restricted to that edge
//     is 1-Lipschitz (|f(x) - f(y)| <= |x - y| for any distance field), and
//     a 1-Lipschitz function deviates from its chord by at most
//     `(pitch^2 - delta^2) / (2 * pitch) <= pitch / 2` (with
//     `delta = |f(p2) - f(p1)|`; maximize `min(a + t, b + (pitch - t)) -
//     chord(t)` over t to get this exactly). At the interpolated vertex the
//     chord equals `d`, so `|f(v) - d| <= pitch / 2`.
//  3. `|f(v) - d|` IS the quantity the phase acceptance criterion measures
//     (for a sphere fixture, `f(v) = |v - center| - r` up to the fixture's
//     own facet sagitta), so the bound applies to the reported max radial
//     error directly. At the clinical default pitch 0.02 mm the bound is
//     exactly the acceptance ceiling: 10 µm.
//  4. `eps_f32` collects the two documented Float32 boundaries (grid
//     storage in step 1, and the manifold-3d WASM cast in the cleanup —
//     boolean/manifold.ts's `@errorBound`) plus marchingCubes.ts's
//     mu-clamp: `2 * 1.19e-7 * maxAbsCoordMm + muClampEpsilon * pitch`.
//     At die scale (coords ≤ ~20 mm, pitch 0.02) that totals < 3e-5 mm =
//     0.03 µm — three orders of magnitude below pitch/2, included for
//     honesty rather than significance.
//
// The bound is on distance measured THROUGH the field (`|f(v) - d|`);
// Euclidean distance from `v` to the true offset surface is additionally
// bounded by the shared grid edge both crossings lie on (`<= pitch`,
// hard geometric localization). MC's known smoothing of sharp features
// (mcTables.ts's variant note) affects where the surface is SAMPLED, not
// this per-vertex field-value bound.
import type { Vec3 } from '../bvh/geometry.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import type { Bbox, MeshStats } from '../intake/types.ts';
import { buildBvh } from '../bvh/build.ts';
import { analyzeMesh } from '../intake/analyze.ts';
import { weldVertices } from '../intake/weld.ts';
import { computePseudonormals } from '../sdf/pseudonormals.ts';
import { computeSdfGridSlice, markCandidateCells, sdfGridDims } from '../sdf/grid.ts';
import { cleanupMesh } from '../boolean/manifold.ts';
import { marchingCubes, muClampEpsilon, type ScalarGrid } from './marchingCubes.ts';

/** How many SDF z-slices `offsetMesh` computes between event-loop yields —
 * see the yield note in `offsetMesh`'s doc. At die scale a slice is
 * ~50-100 ms, so this yields every ~0.5-1 s: frequent enough to keep any
 * host thread's message handling alive, rare enough to cost nothing. */
const SDF_SLICES_PER_YIELD = 8;

/** One macrotask yield (`setTimeout 0`, available in both Node and browser
 * workers — a microtask would NOT let pending messages/timers run). */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Band/padding safety margin, in pitches: `3 > sqrt(3) ≈ 1.732`, the cell
 * diagonal in pitch units. Any cell the iso surface `{f = distanceMm}`
 * intersects has all 8 corners within `pitch * sqrt(3)` of a surface point,
 * hence (1-Lipschitz f) corner values within `distanceMm ± pitch*sqrt(3)`
 * — all strictly inside a band of `|distanceMm| + 3 * pitch`. So every
 * iso-crossing cell is fully computed (no sentinel corner), and marching
 * cubes' skip-sentinel-cells policy (marchingCubes.ts module doc) provably
 * cannot clip the iso surface. The extra margin above sqrt(3) is cheap
 * (band width grows by ~1.3 pitches ≈ tens of µm) and absorbs the
 * conservative bbox-based candidate marking (`markCandidateCells` marks by
 * triangle bbox, never missing in-band cells — sdf/grid.ts).
 */
export const OFFSET_BAND_MARGIN_PITCHES = 3;

/** Grid request `offsetMesh` makes for a given mesh bbox / distance /
 * pitch — exposed so jobs/offset.ts (worker) and tests derive the IDENTICAL
 * grid (padding and band both `|distanceMm| + OFFSET_BAND_MARGIN_PITCHES *
 * pitchMm`; padding so the outward iso surface — at most `|distanceMm|`
 * beyond the mesh bbox — always has ≥ 3 pitches of sampled margin beyond it
 * on every side, band per `OFFSET_BAND_MARGIN_PITCHES`'s doc). */
export function offsetGridSpec(
  bbox: Bbox,
  distanceMm: number,
  pitchMm: number,
): { bboxMm: { min: Vec3; max: Vec3 }; padding: number; bandMm: number } {
  const margin = Math.abs(distanceMm) + OFFSET_BAND_MARGIN_PITCHES * pitchMm;
  return {
    bboxMm: { min: [bbox.min[0], bbox.min[1], bbox.min[2]], max: [bbox.max[0], bbox.max[1], bbox.max[2]] },
    padding: margin,
    bandMm: margin,
  };
}

/**
 * Thrown when the requested offset produces NO surface — e.g. an inward
 * offset larger than the solid's inradius (`{f = distanceMm}` is empty:
 * every grid sample is on one side of the iso value). A typed error rather
 * than an empty mesh, because every downstream consumer (cement-gap
 * booleans, QC gates) treats "the offset solid vanished" as a failed
 * clinical parameter choice, not a valid geometry.
 */
export class EmptyOffsetResultError extends Error {
  constructor(distanceMm: number) {
    super(
      `offsetMesh: offset by ${distanceMm} mm produced no surface (iso value outside the sampled ` +
        `field's range — for an inward offset, |distance| likely exceeds the solid's inradius)`,
    );
    this.name = 'EmptyOffsetResultError';
  }
}

export interface OffsetMeshOptions {
  /** Voxel pitch, mm. REQUIRED — no kernel-level default (clinical defaults
   * live only in packages/clinical-profiles; see its
   * `DEFAULT_OFFSET_VOXEL_PITCH_MM`). Must be finite and > 0. */
  pitchMm: number;
}

export interface OffsetMeshResult {
  /** The offset surface: watertight, manifold, CCW-from-outside (validated
   * by the manifold cleanup pass; re-verified in `stats`). */
  mesh: IndexedMesh;
  /** `analyzeMesh` over the FINAL cleaned mesh (post-weld, post-manifold —
   * the mesh above, not any intermediate). */
  stats: MeshStats;
  /** Documented approximation bound, mm — see this module's `@errorBound`
   * (pitch/2 + Float32/clamp epsilon terms). Carried per PLAN §6.6 for QC
   * surfacing. */
  errorBoundMm: number;
  /** Echo of the request, for journaling. */
  distanceMm: number;
  pitchMm: number;
}

/** The `errorBoundMm` computation, shared verbatim by `offsetMesh` and
 * jobs/offset.ts — see this module's `@errorBound` for the derivation of
 * each term. `maxAbsCoordMm` is the largest |coordinate| the pipeline
 * handles (padded grid corner), bounding both Float32 casts. */
export function offsetErrorBoundMm(pitchMm: number, maxAbsCoordMm: number): number {
  const FLOAT32_RELATIVE_EPSILON = 1.19e-7;
  return pitchMm / 2 + 2 * FLOAT32_RELATIVE_EPSILON * maxAbsCoordMm + muClampEpsilon(pitchMm) * pitchMm;
}

/** Largest |coordinate| of the padded grid region for `bbox` + `padding` —
 * input to `offsetErrorBoundMm`, shared with jobs/offset.ts. */
export function maxAbsCoordOf(bbox: Bbox, padding: number): number {
  let maxAbs = 0;
  for (let axis = 0; axis < 3; axis++) {
    maxAbs = Math.max(maxAbs, Math.abs(bbox.min[axis]! - padding), Math.abs(bbox.max[axis]! + padding));
  }
  return maxAbs;
}

/**
 * Offsets a closed, watertight mesh's surface by `distanceMm` (positive =
 * outward/grow, negative = inward/shrink — see this module's sign-
 * convention doc), returning a new watertight, manifold `IndexedMesh` plus
 * stats and the documented error bound. See the module doc for the
 * pipeline, `@errorBound`, and why this is async.
 *
 * Deterministic: same mesh + arguments → byte-identical output (every
 * stage is deterministic — see each stage's own module doc — and the
 * manifold-3d WASM pass is single-threaded and input-deterministic;
 * offsetMesh.test.ts pins this with a double-run hash).
 *
 * @throws {TypeError} for non-finite `distanceMm` or invalid `pitchMm`.
 * @throws {NonWatertightMeshError} (sdf/pseudonormals.ts) if `mesh` is not
 * closed — signed distance requires a watertight input.
 * @throws {SdfGridTooLargeError} (sdf/grid.ts) if bbox/pitch exceed the
 * grid memory guard.
 * @throws {EmptyOffsetResultError} if the offset surface is empty.
 * @throws {NonManifoldInputError} (boolean/manifold.ts) if the extracted
 * surface fails manifold validation (marching cubes' documented ambiguity
 * limitation — see mcTables.ts).
 */
export async function offsetMesh(
  mesh: IndexedMesh,
  distanceMm: number,
  options: OffsetMeshOptions,
): Promise<OffsetMeshResult> {
  const { pitchMm } = options;
  if (!Number.isFinite(distanceMm)) {
    throw new TypeError(`offsetMesh: distanceMm must be finite, got ${distanceMm}`);
  }
  if (!(Number.isFinite(pitchMm) && pitchMm > 0)) {
    throw new TypeError(`offsetMesh: pitchMm must be finite and > 0, got ${pitchMm}`);
  }

  // Stage 0: bbox + acceleration structures (computePseudonormals is also
  // the watertight gate — throws NonWatertightMeshError for open input).
  const inputStats = analyzeMesh(mesh);
  const bvh = buildBvh(mesh);
  const pseudonormals = computePseudonormals(mesh);

  // Stage 1: banded SDF grid (bandMm ALWAYS set — dense die-scale grids
  // take hours; banded, tens of seconds. See sdf/grid.ts's "Perf" doc).
  // Driven per-slice (the same `computeSdfGridSlice` primitive
  // `sampleSdfGrid` wraps, identical iteration order → byte-identical
  // grid) rather than through the synchronous `sampleSdfGrid` wrapper,
  // with a macrotask yield every few slices: this function is async
  // anyway (WASM cleanup below), and a die-scale grid is ~40-60 s of
  // otherwise UNINTERRUPTED synchronous compute — long enough to starve
  // whatever event loop hosts the call (worker heartbeats, test-runner
  // RPC), observed as vitest worker RPC timeouts during this task's own
  // acceptance runs. The yield changes no computed value (pure scheduling).
  const spec = offsetGridSpec(inputStats.bbox, distanceMm, pitchMm);
  const { dims, origin, cellCount } = sdfGridDims({ bboxMm: spec.bboxMm, pitchMm, padding: spec.padding });
  const [, ny, nz] = dims;
  const grid = new Float32Array(cellCount);
  const mask = markCandidateCells(mesh, dims, origin, pitchMm, spec.bandMm);
  const nx = dims[0];
  for (let z = 0; z < nz; z++) {
    grid.set(computeSdfGridSlice(mesh, bvh, pseudonormals, dims, origin, pitchMm, z, mask), z * ny * nx);
    if (z % SDF_SLICES_PER_YIELD === SDF_SLICES_PER_YIELD - 1) await yieldToEventLoop();
  }
  const sdf: ScalarGrid = { grid, dims, origin, pitchMm };

  // Stage 2: marching cubes at iso = distanceMm.
  const soup = marchingCubes(sdf, distanceMm);
  if (soup.triangleCount === 0) {
    throw new EmptyOffsetResultError(distanceMm);
  }

  // Stage 3: weld + manifold cleanup (validates watertight/manifold; may
  // collapse slivers — see cleanupMesh's doc).
  const welded = weldVertices({ positions: soup.positions, normals: null, triangleCount: soup.triangleCount });
  const cleaned = await cleanupMesh(welded);

  // Stage 4: stats over the FINAL mesh.
  const stats = analyzeMesh(cleaned);

  return {
    mesh: cleaned,
    stats,
    errorBoundMm: offsetErrorBoundMm(pitchMm, maxAbsCoordOf(inputStats.bbox, spec.padding)),
    distanceMm,
    pitchMm,
  };
}
