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
import { marchingCubes, muClampEpsilon, MIN_PITCH_MM, PitchTooSmallError, type ScalarGrid } from './marchingCubes.ts';

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
 * @throws {PitchTooSmallError} (marchingCubes.ts) if `pitchMm < MIN_PITCH_MM`
 * — checked up front, before any grid/SDF work, so this fails fast rather
 * than after the expensive stages.
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
  if (pitchMm < MIN_PITCH_MM) {
    // Checked here (fail-fast, before any grid/SDF work) even though
    // muClampEpsilon (marchingCubes.ts) would eventually throw the same
    // error during stage 2 — see PitchTooSmallError's doc for why.
    throw new PitchTooSmallError(pitchMm);
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

// ---------------------------------------------------------------------------
// offsetMeshRoi — Phase 4 Task 1 carry-in: die-offset ROI-band perf fix
// ---------------------------------------------------------------------------
//
// ## The problem, MEASURED (this task's report has the full sweep)
//
// `offsetMesh` above always derives its SDF grid's bbox from the INPUT
// MESH's own bbox (`inputStats.bbox`, from `analyzeMesh(mesh)`) — correct
// for a mesh that IS the region of interest, but expensive for a die-sized
// input whose relevant geometry (the region near a prep's margin, which is
// all Phase 4's inner-surface stage ever offsets) is a small fraction of
// the die's full extent (e.g. `standin-prep-die.stl`'s 8x8x10mm bbox
// includes a flat base and 9mm of coarsely-tessellated lateral wall the
// crown pipeline never touches). Measured on that exact fixture at the
// clinical default pitch 0.02mm (P2 Task 7's original report, reproduced by
// this task): `markCandidateCells` — the band-restriction pass `offsetMesh`
// already uses to avoid dense whole-grid sampling (`sdf/grid.ts`'s "Perf"
// doc) — marks **~56% of the entire 87M-cell grid** as candidates, not the
// few-percent a `bandMm`-thin shell around the surface would suggest. Root
// cause (measured via `markCandidateCells` cell counts across several
// sub-regions, this task's report): the die's lateral wall is a SINGLE
// un-subdivided cone band (only two rings of vertices, z=1mm and z=10mm —
// no intermediate rings), so each of its 128 triangles' own axis-aligned
// bounding box spans nearly the ENTIRE 9mm height (and, since the wall
// tapers from radius 4mm to 2.5mm, a meaningful RADIAL span too) —
// `markCandidateCells`'s conservative "mark the whole triangle bbox,
// expanded by bandMm" rule (see that function's own doc: this can only
// over-include, never miss a genuine in-band cell) turns a handful of large,
// coarse triangles into a candidate region covering more than half the
// domain, each candidate cell costing a real `signedClosestPoint` BVH query
// (~2.5-15µs measured, sdf/grid.ts's "Perf" doc) — 117-126s total (P2 Task
// 7's report; reproduced by this task, see offsetMeshRoi.perf.test.ts).
//
// ## The fix: restrict the GRID DOMAIN itself to a caller-supplied ROI bbox
// — never restrict which triangles participate in distance queries
//
// This is the SAME judgment call `axis/roi.ts`'s `extractMarginRegion`
// makes (that module's own doc: "under-including a sliver of legitimately-
// nearby surface only makes the objective slightly less complete... that is
// exactly the safe direction of error"), applied at the SDF-grid-bbox level
// rather than axis/roi.ts's triangle-index-subset level (an offset needs a
// spatial VOLUME to sample, not a triangle subset): `offsetMeshRoi` derives
// `offsetGridSpec` from a caller-supplied `roiBboxMm` instead of the input
// mesh's own bbox — bounding `cellCount` (and therefore the worst case of
// `markCandidateCells`'s own over-marking, however bad, since a clamped
// candidate mark can never exceed the DOMAIN it's clamped into,
// `markCandidateCells`'s `clampIndex` calls) directly, regardless of the
// root cause above. Every OTHER stage (BVH, pseudonormals, the watertight
// gate) still runs over the FULL, UNRESTRICTED input mesh — a point near
// the ROI boundary may have its true closest surface point on a triangle
// OUTSIDE the ROI, and `signedClosestPoint` must still find it exactly; only
// the SET OF GRID POINTS SAMPLED shrinks, never the set of triangles a
// sampled point is measured against. This is why `offsetMeshRoi`'s output is
// byte-identical, cell-for-cell, to what `offsetMesh`'s full-bbox grid would
// have produced at any grid point BOTH pipelines actually sample (proven by
// construction: `computeSdfGridSlice`'s per-point value depends only on
// `mesh`/`bvh`/`pseudonormals`/the point's own world coordinates, never on
// the grid's overall extent) — see offsetMeshRoi.test.ts's byte-identity
// assertion (ROI = full bbox reduces to `offsetMesh` exactly) and its
// interior-accuracy assertion (a genuinely SMALLER ROI still meets the same
// documented `@errorBound` everywhere strictly inside the crop boundary).
//
// ## Output shape: an OPEN (uncleaned) patch, not a solid — documented,
// not a bug
//
// Unlike `offsetMesh`, this function does NOT call `cleanupMesh` (the
// manifold-3d watertight/manifold validator): cropping the grid domain to a
// sub-region of a closed solid's true offset surface generically produces an
// OPEN patch (a boundary loop wherever the true surface exits the sampled
// domain — marching cubes simply stops at the domain edge; it never
// fabricates a closing cap there, since MC only emits geometry for grid
// EDGES that exist within `dims`). This is the correct, expected shape for
// this primitive's intended Phase 4 consumer (the inner-surface stage,
// Task 3): a cropped inner-surface PATCH that a later stage stitches to the
// margin band and skirt, not a standalone solid. `cleanupMesh`'s watertight
// requirement would reject this shape outright, so it is deliberately never
// called here — only `weldVertices` (topology cleanup, no watertight
// requirement) runs, and `stats.watertight` is expected to be `false` for a
// genuinely-cropped ROI (asserted, not hidden, by the tests).
//
// ## Scope note (honest — this task's YAGNI guardrail)
//
// This is the KERNEL-LEVEL primitive only. `kernel-workers/src/jobs/
// offset.ts`'s worker job (which the crown pipeline's `innerSurfaceOffset`
// job, Phase 4 Task 3, will actually call from a worker with progress/
// cancellation) is NOT extended with an ROI variant in this task — no
// pipeline stage exists yet to derive a real ROI bbox from a margin loop
// (that derivation is Task 3's job, once `packages/cad-pipeline`'s
// inner-surface stage exists to own the "prep region" concept). Wiring this
// kernel primitive into a worker job is deliberately left for that task.
//
// @errorBound Identical to `offsetMesh`'s own `@errorBound` (same
// `offsetErrorBoundMm` formula, evaluated against the ROI-padded domain's
// own `maxAbsCoordOf`) for every point the ROI grid actually samples — the
// domain restriction changes WHICH points are sampled, never the per-point
// accuracy of a sampled value (see this doc's "byte-identical" argument
// above). The bound does NOT apply at/beyond the crop boundary itself
// (there is, by construction, no computed value beyond the sampled domain —
// the output mesh simply has a boundary edge there, not an inaccurate one).
export interface OffsetMeshRoiOptions extends OffsetMeshOptions {
  /** Tight world-space mm bbox to restrict SDF sampling to — REQUIRED (no
   * default; a caller with no ROI opinion should call `offsetMesh` instead).
   * Padded internally by the SAME `offsetGridSpec` band-margin rule
   * `offsetMesh` uses (`|distanceMm| + OFFSET_BAND_MARGIN_PITCHES *
   * pitchMm`) — the caller does not need to pre-pad this box, only ensure it
   * is large enough that the true offset surface within the region of
   * interest doesn't ITSELF extend past the padded domain in a way the
   * caller cares about (see this module's doc: the surface simply crops
   * cleanly at the domain edge, it does not corrupt anything inside). */
  roiBboxMm: { readonly min: Vec3; readonly max: Vec3 };
}

export interface OffsetMeshRoiResult {
  /** Welded surface soup restricted to the padded ROI — see this module's
   * doc: generally an OPEN patch (manifold-3d's watertight cleanup is
   * deliberately NOT applied), never expect `stats.watertight` to be `true`
   * unless `roiBboxMm` happens to enclose the entire true offset surface. */
  mesh: IndexedMesh;
  /** `analyzeMesh` over the welded (uncledaned) mesh above. */
  stats: MeshStats;
  errorBoundMm: number;
  distanceMm: number;
  pitchMm: number;
  /** Echo of the requested ROI (pre-padding). */
  roiBboxMm: { readonly min: Vec3; readonly max: Vec3 };
}

/**
 * ROI-restricted offset — see this module's doc above for the perf
 * motivation, the correctness argument (byte-identical to `offsetMesh` at
 * every grid point both pipelines sample), and why the result is an open
 * (uncledaned) patch. `mesh` is still the FULL, unrestricted input — every
 * stage but the SDF grid's own bbox runs exactly as `offsetMesh` does.
 *
 * @throws {TypeError} for invalid `distanceMm`/`pitchMm`, or a degenerate
 * `roiBboxMm` (`max` not `>=` `min` on every axis — checked by
 * `sdfGridDims`).
 * @throws {PitchTooSmallError} if `pitchMm < MIN_PITCH_MM`.
 * @throws {NonWatertightMeshError} if `mesh` is not closed (the SAME
 * watertight requirement `offsetMesh` has — signed distance always needs a
 * closed input, regardless of how small the sampled ROI is).
 * @throws {SdfGridTooLargeError} if the ROI's padded grid exceeds the memory
 * guard.
 * @throws {EmptyOffsetResultError} if no iso-crossing cell exists anywhere
 * inside the padded ROI (e.g. the ROI genuinely doesn't reach the true
 * offset surface — a legitimate, honest outcome for a badly-chosen ROI, not
 * a bug in this function).
 */
export async function offsetMeshRoi(
  mesh: IndexedMesh,
  distanceMm: number,
  options: OffsetMeshRoiOptions,
): Promise<OffsetMeshRoiResult> {
  const { pitchMm, roiBboxMm } = options;
  if (!Number.isFinite(distanceMm)) {
    throw new TypeError(`offsetMeshRoi: distanceMm must be finite, got ${distanceMm}`);
  }
  if (!(Number.isFinite(pitchMm) && pitchMm > 0)) {
    throw new TypeError(`offsetMeshRoi: pitchMm must be finite and > 0, got ${pitchMm}`);
  }
  if (pitchMm < MIN_PITCH_MM) {
    throw new PitchTooSmallError(pitchMm);
  }

  // Stage 0: BVH/pseudonormals over the FULL, unrestricted mesh — see this
  // module's doc for why (a point near the ROI boundary may be closest to a
  // triangle outside it).
  const bvh = buildBvh(mesh);
  const pseudonormals = computePseudonormals(mesh);

  // Stage 1: banded SDF grid, domain from roiBboxMm (NOT the mesh's own
  // bbox) — this is the entire fix.
  const spec = offsetGridSpec(roiBboxMm, distanceMm, pitchMm);
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

  // Stage 2: marching cubes at iso = distanceMm — crops cleanly at the
  // domain edge (see this module's doc: never fabricates a closing cap).
  const soup = marchingCubes(sdf, distanceMm);
  if (soup.triangleCount === 0) {
    throw new EmptyOffsetResultError(distanceMm);
  }

  // Stage 3: weld ONLY — no `cleanupMesh` (see this module's doc: the
  // result is generally an open patch, not a solid).
  const welded = weldVertices({ positions: soup.positions, normals: null, triangleCount: soup.triangleCount });

  // Stage 4: stats over the welded mesh (watertight === false expected for
  // a genuinely-cropped ROI).
  const stats = analyzeMesh(welded);

  return {
    mesh: welded,
    stats,
    errorBoundMm: offsetErrorBoundMm(pitchMm, maxAbsCoordOf(
      { min: roiBboxMm.min, max: roiBboxMm.max },
      spec.padding,
    )),
    distanceMm,
    pitchMm,
    roiBboxMm,
  };
}
