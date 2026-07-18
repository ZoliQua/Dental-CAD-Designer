// packages/kernel/src/sdf/grid.ts
//
// `sampleSdfGrid`: samples `signedClosestPoint` over a regular Float64
// world-space grid — the scalar field Task 7's offset-surface extraction
// consumes (marching cubes over `grid` at iso-value `offsetMm`, out of THIS
// task's YAGNI scope — see this task's brief's guardrail). This module is
// deliberately split into small, independently-testable pieces
// (`sdfGridDims`, `computeSdfGridSlice`, `markCandidateCells`) so
// kernel-workers/src/jobs/sdf.ts's worker job can drive the SAME per-slice
// primitive with real async cancellation between slices (kernel functions
// are synchronous — see this repo's CLAUDE.md/Global Constraints — so genuine
// mid-computation cancellation cannot live HERE; `sampleSdfGrid` below is a
// synchronous convenience wrapper with only a synchronous `onProgress` hook,
// same convention as bvh/build.ts's `buildBvh`).
//
// ## Grid storage: Float32, not Float64 (documented exception to this
// project's "Float64 everywhere in kernel" rule — see
// docs/plans/phase-2-kernel-core.md's Global Constraints)
//
// The brief's own motivating example: a 10 mm die sampled at the clinical
// default 20 µm pitch is `ceil(10/0.02)+1 = 501` samples per axis (see
// `sdfGridDims`'s `+1` doc) — `501^3 ≈ 1.258e8` grid samples. At Float64 (8
// bytes/sample) that's `~1.01 GB` for ONE grid; at Float32 (4 bytes) it's
// `~503 MB` — half the memory for the exact same sample COUNT (this is a
// storage-precision decision, not a computation-precision one: see below).
//
// **Quantization error, measured against the task's error budget:** Float32
// has ~7 decimal digits of precision (relative epsilon ≈ 1.19e-7). For a
// signed-distance value of magnitude up to this grid's largest plausible
// extent (~10s of mm for any dental-CAD geometry this kernel targets), the
// ABSOLUTE quantization error is `magnitude * 1.19e-7`:
//   - at 1 mm magnitude (near the iso-surface, where Task 7 actually reads
//     values): `1.19e-7 mm ≈ 0.00012 µm`.
//   - at 10 mm magnitude (far corner of a die-sized bbox, where nothing
//     downstream reads the value anyway): `1.19e-6 mm ≈ 0.0012 µm`.
// Task 7's phase-acceptance criterion is "offset of a sphere by 50 µm has
// max radial error <= 10 µm at default pitch" (docs/plans/phase-2-kernel-
// core.md's Global Constraints), and THAT budget is already dominated by the
// grid's own spatial resolution (a trilinear/marching-cubes reconstruction
// from a pitch-`p` grid has an inherent O(p) interpolation error, roughly
// `p/2 = 10 µm` at the clinical default `p = 20 µm` — see Task 7's own
// `@errorBound` for the precise derivation once written). Float32's ~0.0001
// -0.001 µm quantization is 4-5 orders of magnitude below that `p/2 = 10 µm`
// floor — it cannot plausibly be the limiting term in Task 7's error chain,
// so storing the grid as Float32 costs nothing against the documented
// acceptance budget while halving memory at exactly the scale (100M+
// samples) where memory is the binding constraint.
//
// **What stays Float64:** every computation feeding a grid sample —
// `signedClosestPoint` itself, world-space coordinate math
// (`origin + index * pitchMm`), the candidate-cell band test — is Float64
// throughout, per this project's Global Constraints ("Float64 everywhere...
// Float32 only in engine render copies + the documented manifold WASM
// boundary"). Only the FINAL rounding into the returned `Float32Array` loses
// precision — this module is a second documented Float32 boundary, alongside
// the existing manifold WASM one (packages/kernel/src/boolean/manifold.ts),
// justified by the same standard: an explicit error-budget argument, not
// convenience.
//
// ## Memory guard
//
// `MAX_SDF_GRID_CELLS` below is a hard ceiling on `dims[0] * dims[1] *
// dims[2]` (total grid samples) — see its own doc for the exact derivation.
// `sdfGridDims` checks it BEFORE any array is allocated, so a request that
// exceeds it fails fast with a typed `SdfGridTooLargeError` rather than
// attempting a multi-hundred-MB-to-multi-GB allocation.
//
// ## Perf: dense sampling is O(cellCount) BVH queries — measured, and why
// `bandMm` exists
//
// A `closestPoint` BVH query's cost is NOT uniform across query points — it
// depends heavily on how well the BVH's branch-and-bound pruning works for
// that particular point (bvh/closestPoint.ts), and this was measured to
// matter a LOT for SDF grid sampling specifically (Node 23, Apple-silicon
// dev machine, a 20,480-triangle radius-4.8mm icosphere BVH — see this
// task's report for the raw benchmarks):
//   - A "generic" mixed query (scattered across a bbox spanning both inside
//     and outside the mesh): ~6.3 µs/query.
//   - A query point NEAR THE SURFACE (the case `bandMm`'s candidate cells
//     are — see below): ~3.2 µs/query (even faster — the true closest
//     triangle is found almost immediately, pruning the rest of the tree
//     fast).
//   - A query point DEEP IN THE INTERIOR of a near-symmetric closed shape
//     (worst case measured: the exact center of the icosphere, where every
//     point on the surface is EQUIDISTANT): ~137 µs/query — over 20x the
//     generic case, because near-uniform distance to every candidate
//     subtree defeats branch-and-bound pruning almost entirely (a well-known
//     pathology of best-first nearest-neighbor BVH search, not a bug).
// Dense (unbanded) sampling of a large grid that includes a meaningful
// interior volume can therefore be dramatically slower than a naive
// "microseconds times cell count" estimate suggests — at
// `MAX_SDF_GRID_CELLS` (~1.258e8, the brief's own 501^3 example), a dense
// scan that includes deep-interior points could run into HOURS, not
// minutes, single-threaded (137 µs * 1.258e8 ≈ 4.8 hours worst case).
//
// Per this task's guardrail ("no narrow-band optimization... unless measured
// slow, in which case sampling only within a band around the surface IS in
// scope as the documented pragmatic choice"), `bandMm` (see
// `SampleSdfGridOptions`) is the escape hatch — and it specifically AVOIDS
// the pathological deep-interior case, not just wasted far-field cells:
// when provided, `markCandidateCells` restricts the EXPENSIVE
// `signedClosestPoint` calls to grid cells within `bandMm` of some
// triangle's bounding box (a cheap, triangle-driven O(triangleCount) pass
// with NO BVH queries at all — see its own doc), leaving every other cell —
// including every deep-interior one — at the `Number.POSITIVE_INFINITY`
// sentinel, never queried. Measured end-to-end on the SAME 501^3 (~1.258e8
// cell) die-scale grid with `bandMm = 0.1 mm` (5 pitches): `markCandidateCells`
// itself took 83.7 ms, marked ~16% of cells (20,059,328) as candidates, and
// the full grid (candidate queries + sentinel fill) completed in **23.1
// seconds** — comfortably "seconds", not hours, and well within a
// background worker job's progress-bar-and-cancel budget. Task 7 only ever
// needs values near the offset iso-surface (a thin shell around the
// ORIGINAL surface, `|d| <= a few * offsetMm`), so a realistic `bandMm`
// (e.g. `offsetMm * 4`) touches only the samples actually consumed
// downstream, not the whole padded bbox — this task's recommendation is
// that any grid request with a non-trivial interior volume ALWAYS pass
// `bandMm`. Dense (no `bandMm`) mode remains available (and is what every
// test below exercises, at small grid sizes where the cost is negligible)
// for callers that genuinely need every sample, or where the requested grid
// is small/thin enough (e.g. a shell-only bbox with little interior volume)
// that dense O(cellCount) is fine outright.
import type { IndexedMesh } from '../mesh/types.ts';
import type { Bvh } from '../bvh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import type { Pseudonormals } from './pseudonormals.ts';
import { signedClosestPoint } from './signedDistance.ts';

/**
 * `MAX_SDF_GRID_CELLS = 1.3e8` — chosen to comfortably admit this task's own
 * motivating example (a 10 mm die at the clinical default 20 µm pitch,
 * `501^3 ≈ 1.258e8` samples — see this module's top-of-file doc) while still
 * rejecting a request an order of magnitude larger before it can attempt a
 * multi-GB allocation. At Float32 storage (this module's chosen grid dtype
 * — see top-of-file doc), the resulting grid array is `1.3e8 * 4 bytes ≈
 * 520 MB` — a real but bounded worker-thread allocation, roughly half of
 * what the SAME cell count would cost at Float64 (`~1.04 GB`), which is
 * this ceiling's actual memory justification. This ceiling bounds MEMORY
 * only, not wall-clock time — see this module's "Perf" doc above for why a
 * caller requesting a grid anywhere near this ceiling should pass `bandMm`.
 */
export const MAX_SDF_GRID_CELLS = 130_000_000;

/** Thrown by `sdfGridDims` (and therefore `sampleSdfGrid`) when the
 * requested `bboxMm`/`pitchMm`/`padding` combination would produce a grid
 * exceeding `MAX_SDF_GRID_CELLS` — see that constant's doc for the
 * derivation. Thrown BEFORE any grid array is allocated. */
export class SdfGridTooLargeError extends RangeError {
  readonly requestedCellCount: number;
  readonly limit: number;

  constructor(requestedCellCount: number, limit: number) {
    super(
      `sampleSdfGrid: requested grid has ${requestedCellCount.toLocaleString()} cells, exceeding the ` +
        `${limit.toLocaleString()}-cell memory guard (see grid.ts's MAX_SDF_GRID_CELLS doc) — use a coarser ` +
        `pitchMm, a smaller bboxMm/padding, or a bandMm-limited request.`,
    );
    this.name = 'SdfGridTooLargeError';
    this.requestedCellCount = requestedCellCount;
    this.limit = limit;
  }
}

export interface SdfGridBbox {
  readonly min: Vec3;
  readonly max: Vec3;
}

export interface SdfGridOptions {
  /** World-space mm region to sample — typically the mesh's own bbox
   * (`analyzeMesh(mesh).bbox`) or a caller-chosen sub-region. */
  bboxMm: SdfGridBbox;
  /** Grid spacing, mm. Required (no kernel-level default — this project's
   * Global Constraints reserve clinical defaults, e.g.
   * `DEFAULT_OFFSET_VOXEL_PITCH_MM`, to `packages/clinical-profiles`; kernel
   * functions always take such values as required parameters). Must be
   * `> 0`. */
  pitchMm: number;
  /** Extra margin (mm) added on every side of `bboxMm` before computing grid
   * dimensions — e.g. so an offset iso-surface a few pitches outside the
   * mesh's own bbox is still fully sampled. Must be `>= 0`. Default `0`. */
  padding?: number;
}

/** `dims`/`origin`/`cellCount` for a grid over `options` — pure, no mesh
 * needed (dimensions depend only on the requested region/spacing). */
export interface SdfGridDims {
  /** Sample-point counts along x/y/z (NOT cell counts in the "voxel" sense —
   * see this interface's `+1` doc below). */
  readonly dims: readonly [number, number, number];
  /** World-space mm coordinate of grid index `(0, 0, 0)` — i.e. the padded
   * bbox's minimum corner. */
  readonly origin: Vec3;
  /** `dims[0] * dims[1] * dims[2]` — total scalar samples this grid holds
   * (what `MAX_SDF_GRID_CELLS` bounds). */
  readonly cellCount: number;
}

/**
 * Computes `dims`/`origin`/`cellCount` for `options`, and enforces
 * `MAX_SDF_GRID_CELLS` — see this module's top-of-file doc. Pure and cheap
 * (no mesh, no allocation beyond the returned small struct) — always safe to
 * call before deciding whether a `sampleSdfGrid`/worker-job request is even
 * worth attempting.
 *
 * `dims[axis] = ceil(paddedExtent[axis] / pitchMm) + 1`: this samples grid
 * POINTS (vertices of a `dims - 1`-cell lattice), not grid CELLS, the
 * standard convention for a scalar field consumed by a downstream marching-
 * cubes-style reconstruction (Task 7) — `dims[axis] - 1` cells span exactly
 * `ceil(paddedExtent/pitchMm) * pitchMm >= paddedExtent`, so the padded bbox
 * is always fully bracketed by sample points on both sides, never falling
 * short by a fractional cell at the far edge.
 *
 * @throws {TypeError} if `pitchMm <= 0`, `padding < 0`, or `bboxMm.max` is
 * not `>= bboxMm.min` on every axis.
 * @throws {SdfGridTooLargeError} if the resulting `cellCount` exceeds
 * `MAX_SDF_GRID_CELLS`.
 */
export function sdfGridDims(options: SdfGridOptions): SdfGridDims {
  const { bboxMm, pitchMm } = options;
  const padding = options.padding ?? 0;
  if (!(pitchMm > 0)) {
    throw new TypeError(`sdfGridDims: pitchMm must be > 0, got ${pitchMm}`);
  }
  if (!(padding >= 0)) {
    throw new TypeError(`sdfGridDims: padding must be >= 0, got ${padding}`);
  }
  for (let axis = 0; axis < 3; axis++) {
    if (!(bboxMm.max[axis]! >= bboxMm.min[axis]!)) {
      throw new TypeError(
        `sdfGridDims: bboxMm.max must be >= bboxMm.min on every axis (axis ${axis}: ` +
          `min=${bboxMm.min[axis]}, max=${bboxMm.max[axis]})`,
      );
    }
  }

  const origin: Vec3 = [
    bboxMm.min[0] - padding,
    bboxMm.min[1] - padding,
    bboxMm.min[2] - padding,
  ];
  const dims: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    const extent = bboxMm.max[axis]! - bboxMm.min[axis]! + 2 * padding;
    dims[axis] = Math.ceil(extent / pitchMm) + 1;
  }
  const cellCount = dims[0] * dims[1] * dims[2];
  if (cellCount > MAX_SDF_GRID_CELLS) {
    throw new SdfGridTooLargeError(cellCount, MAX_SDF_GRID_CELLS);
  }
  return { dims, origin, cellCount };
}

/**
 * Marks grid cells within `bandMm` of SOME triangle's (band-expanded)
 * bounding box — the cheap, triangle-driven pass `sampleSdfGrid`/the worker
 * job use to skip expensive `signedClosestPoint` calls for cells that cannot
 * possibly be within `bandMm` of the surface (see this module's "Perf" doc).
 *
 * This is a CONSERVATIVE (superset) test, not an exact distance-to-surface
 * computation: a triangle's own axis-aligned bounding box, expanded by
 * `bandMm` on every side, is marked WHOLESALE — every grid cell in that
 * expanded box is a candidate, even ones whose true nearest point on the
 * triangle is farther than `bandMm` away (e.g. a corner of the expanded box,
 * `bandMm` away axis-aligned but `bandMm * sqrt(3)` away diagonally from the
 * triangle itself). This never MISSES a genuinely in-band cell (the
 * triangle's true closest point is always within its own bbox, so the
 * expanded bbox always contains every point within `bandMm` of it) — it can
 * only over-include, which costs a few extra (still exact)
 * `signedClosestPoint` calls, never an incorrect stored value (candidate
 * cells always get their REAL computed signed distance, regardless of
 * whether it lands inside or outside `bandMm` — see `computeSdfGridSlice`).
 *
 * @errorBound Not applicable (a candidacy filter, not a value computation) —
 * see the conservativeness argument above for why it cannot cause a wrong
 * VALUE, only extra (still exact) computation.
 */
export function markCandidateCells(
  mesh: IndexedMesh,
  dims: readonly [number, number, number],
  origin: Vec3,
  pitchMm: number,
  bandMm: number,
): Uint8Array {
  const [nx, ny, nz] = dims;
  const mask = new Uint8Array(nx * ny * nz);
  const triangleCount = mesh.indices.length / 3;

  const clampIndex = (i: number, max: number): number => (i < 0 ? 0 : i > max ? max : i);

  for (let t = 0; t < triangleCount; t++) {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let corner = 0; corner < 3; corner++) {
      const v = mesh.indices[t * 3 + corner]!;
      const x = mesh.positions[v * 3]!;
      const y = mesh.positions[v * 3 + 1]!;
      const z = mesh.positions[v * 3 + 2]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }

    const ix0 = clampIndex(Math.floor((minX - bandMm - origin[0]) / pitchMm), nx - 1);
    const ix1 = clampIndex(Math.ceil((maxX + bandMm - origin[0]) / pitchMm), nx - 1);
    const iy0 = clampIndex(Math.floor((minY - bandMm - origin[1]) / pitchMm), ny - 1);
    const iy1 = clampIndex(Math.ceil((maxY + bandMm - origin[1]) / pitchMm), ny - 1);
    const iz0 = clampIndex(Math.floor((minZ - bandMm - origin[2]) / pitchMm), nz - 1);
    const iz1 = clampIndex(Math.ceil((maxZ + bandMm - origin[2]) / pitchMm), nz - 1);

    for (let iz = iz0; iz <= iz1; iz++) {
      const zBase = iz * ny * nx;
      for (let iy = iy0; iy <= iy1; iy++) {
        const rowBase = zBase + iy * nx;
        for (let ix = ix0; ix <= ix1; ix++) {
          mask[rowBase + ix] = 1;
        }
      }
    }
  }
  return mask;
}

/**
 * Computes ONE z-slice (`dims[0] * dims[1]` samples, x fastest-varying — the
 * SAME flat layout `sampleSdfGrid`'s full-grid `grid` array uses) of the SDF
 * grid — the primitive both `sampleSdfGrid` (below, synchronous whole-grid
 * convenience) and kernel-workers/src/jobs/sdf.ts's worker job call, so the
 * two paths are guaranteed to produce byte-identical results (same
 * primitive, same iteration order within a slice).
 *
 * When `candidateMask` is provided (see `markCandidateCells`), a cell whose
 * flat index (`iz*ny*nx + iy*nx + ix`, matching the FULL grid's flat
 * layout — the caller passes the mask sized to the WHOLE grid, not just this
 * slice) is `0` gets `Number.POSITIVE_INFINITY` with no `signedClosestPoint`
 * call at all; every other cell (including every cell when `candidateMask`
 * is omitted) gets its real computed signed distance, rounded to Float32
 * (this module's documented grid storage dtype — see top-of-file doc).
 */
export function computeSdfGridSlice(
  mesh: IndexedMesh,
  bvh: Bvh,
  pseudonormals: Pseudonormals,
  dims: readonly [number, number, number],
  origin: Vec3,
  pitchMm: number,
  z: number,
  candidateMask?: Uint8Array,
): Float32Array {
  const [nx, ny] = dims;
  const slice = new Float32Array(nx * ny);
  const worldZ = origin[2] + z * pitchMm;
  const zBase = z * ny * nx;

  for (let iy = 0; iy < ny; iy++) {
    const worldY = origin[1] + iy * pitchMm;
    const rowBase = zBase + iy * nx;
    for (let ix = 0; ix < nx; ix++) {
      if (candidateMask && candidateMask[rowBase + ix] === 0) {
        slice[iy * nx + ix] = Number.POSITIVE_INFINITY;
        continue;
      }
      const worldX = origin[0] + ix * pitchMm;
      const point: Vec3 = [worldX, worldY, worldZ];
      const result = signedClosestPoint(mesh, bvh, pseudonormals, point);
      slice[iy * nx + ix] = result.signedDistance;
    }
  }
  return slice;
}

export interface SampleSdfGridOptions extends SdfGridOptions {
  /** See this module's "Perf" doc — when provided, grid cells farther than
   * `bandMm` from every triangle's bounding box are left at
   * `Number.POSITIVE_INFINITY` (sentinel: "not computed, definitely outside
   * the band") rather than getting a `signedClosestPoint` call. Omit for
   * dense (every-cell-exact) sampling. Must be `> 0` if provided. */
  bandMm?: number;
  /** Synchronous progress hook, called once per completed z-slice — same
   * "coarse instrumentation point, not a cancellation mechanism" convention
   * as bvh/build.ts's `BuildBvhOptions.onProgress` (see that doc for why
   * this is deliberately synchronous: `sampleSdfGrid` itself is a
   * synchronous, single-pass computation, matching every other kernel
   * algorithm). kernel-workers/src/jobs/sdf.ts's worker job does NOT use
   * this wrapper — it drives `computeSdfGridSlice` itself, per-slice, so it
   * can `await ctx.cancelled()` between slices (a synchronous hook cannot
   * express real cancellation — see this module's top-of-file doc). */
  onProgress?: (completedSlices: number, totalSlices: number) => void;
}

export interface SampleSdfGridResult {
  /** Flat Float32 grid, `dims[0]*dims[1]*dims[2]` samples, x fastest-varying
   * then y then z (`grid[iz*dims[1]*dims[0] + iy*dims[0] + ix]`) — see this
   * module's top-of-file doc for why Float32 (not this project's usual
   * Float64) is the documented, error-budget-justified storage dtype here. */
  readonly grid: Float32Array;
  readonly dims: readonly [number, number, number];
  readonly origin: Vec3;
  readonly pitchMm: number;
  /** Echoes `options.bandMm`, or `null` if dense (unbanded) sampling was
   * used — lets a consumer (Task 7) tell whether cells outside the
   * mesh's immediate vicinity are real values or the
   * `Number.POSITIVE_INFINITY` sentinel. */
  readonly bandMm: number | null;
}

/**
 * Synchronous whole-grid convenience wrapper around `sdfGridDims` +
 * `markCandidateCells` (if `options.bandMm` is set) + `computeSdfGridSlice`
 * (looped over every z) — see this module's top-of-file doc for the overall
 * design and its "Perf"/"Grid storage" sections for the Float32 dtype and
 * `bandMm` rationale.
 *
 * This is the direct, worker-free entry point this task's kernel-level
 * tests use (grid.test.ts); kernel-workers/src/jobs/sdf.ts's worker job
 * reimplements this SAME z-slice loop itself (not by calling this function)
 * so it can add real async cancellation between slices — see
 * `SampleSdfGridOptions.onProgress`'s doc.
 *
 * @throws {SdfGridTooLargeError} — see `sdfGridDims`.
 */
export function sampleSdfGrid(
  mesh: IndexedMesh,
  bvh: Bvh,
  pseudonormals: Pseudonormals,
  options: SampleSdfGridOptions,
): SampleSdfGridResult {
  if (options.bandMm !== undefined && !(options.bandMm > 0)) {
    throw new TypeError(`sampleSdfGrid: bandMm must be > 0 if provided, got ${options.bandMm}`);
  }
  const { dims, origin, cellCount } = sdfGridDims(options);
  const [nx, ny, nz] = dims;
  const grid = new Float32Array(cellCount);
  const mask =
    options.bandMm !== undefined ? markCandidateCells(mesh, dims, origin, options.pitchMm, options.bandMm) : undefined;

  for (let z = 0; z < nz; z++) {
    const slice = computeSdfGridSlice(mesh, bvh, pseudonormals, dims, origin, options.pitchMm, z, mask);
    grid.set(slice, z * ny * nx);
    options.onProgress?.(z + 1, nz);
  }

  return { grid, dims, origin, pitchMm: options.pitchMm, bandMm: options.bandMm ?? null };
}
