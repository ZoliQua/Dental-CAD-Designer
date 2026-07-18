// packages/kernel/src/sdf/grid.test.ts
//
// Tests for `sdfGridDims` / `markCandidateCells` / `computeSdfGridSlice` /
// `sampleSdfGrid` — per this task's brief item 4: analytic sphere grid
// spot-asserts (including a sign transition across the surface),
// determinism hashes, memory-guard rejection, and `bandMm` behavior.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildBvh } from '../bvh/build.ts';
import { icosphereMesh } from '../halfedge/halfedge.test-fixtures.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { computePseudonormals } from './pseudonormals.ts';
import {
  MAX_SDF_GRID_CELLS,
  SdfGridTooLargeError,
  assertSdfGridCellCountWithinCeiling,
  sampleSdfGrid,
  sdfGridDims,
  markCandidateCells,
} from './grid.ts';

describe('sdfGridDims', () => {
  it('brackets the requested bbox with sample POINTS (dims - 1 cells span >= the padded extent)', () => {
    const { dims, origin, cellCount } = sdfGridDims({
      bboxMm: { min: [0, 0, 0], max: [1, 2, 0.5] },
      pitchMm: 0.25,
    });
    // extent/pitch = [4, 8, 2] -> dims = extent/pitch + 1
    expect(dims).toEqual([5, 9, 3]);
    expect(origin).toEqual([0, 0, 0]);
    expect(cellCount).toBe(5 * 9 * 3);
  });

  it('padding expands the origin and extent symmetrically', () => {
    const { dims, origin } = sdfGridDims({
      bboxMm: { min: [0, 0, 0], max: [1, 1, 1] },
      pitchMm: 0.5,
      padding: 0.5,
    });
    expect(origin).toEqual([-0.5, -0.5, -0.5]);
    // padded extent = 1 + 2*0.5 = 2; 2/0.5 + 1 = 5
    expect(dims).toEqual([5, 5, 5]);
  });

  it('throws TypeError for pitchMm <= 0', () => {
    expect(() => sdfGridDims({ bboxMm: { min: [0, 0, 0], max: [1, 1, 1] }, pitchMm: 0 })).toThrow(TypeError);
    expect(() => sdfGridDims({ bboxMm: { min: [0, 0, 0], max: [1, 1, 1] }, pitchMm: -1 })).toThrow(TypeError);
  });

  it('throws TypeError for negative padding', () => {
    expect(() =>
      sdfGridDims({ bboxMm: { min: [0, 0, 0], max: [1, 1, 1] }, pitchMm: 0.1, padding: -0.1 }),
    ).toThrow(TypeError);
  });

  it('throws TypeError when bboxMm.max < bboxMm.min on any axis', () => {
    expect(() =>
      sdfGridDims({ bboxMm: { min: [0, 0, 0], max: [-1, 1, 1] }, pitchMm: 0.1 }),
    ).toThrow(TypeError);
  });

  it('memory guard: rejects a grid exceeding MAX_SDF_GRID_CELLS with a typed error, WITHOUT allocating anything', () => {
    // A deliberately huge bbox/fine pitch combination — dims math alone
    // (no allocation) must reject this before any Float32Array is touched.
    expect(() =>
      sdfGridDims({ bboxMm: { min: [0, 0, 0], max: [100, 100, 100] }, pitchMm: 0.001 }),
    ).toThrow(SdfGridTooLargeError);
    try {
      sdfGridDims({ bboxMm: { min: [0, 0, 0], max: [100, 100, 100] }, pitchMm: 0.001 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SdfGridTooLargeError);
      const err = error as SdfGridTooLargeError;
      expect(err.requestedCellCount).toBeGreaterThan(MAX_SDF_GRID_CELLS);
      expect(err.limit).toBe(MAX_SDF_GRID_CELLS);
    }
  });

  it('a grid comfortably under the ceiling is accepted (NOT a boundary case — see the dedicated predicate boundary test below for the real edge; a bbox/pitch pair that lands cellCount EXACTLY on MAX_SDF_GRID_CELLS is impractical to construct/allocate, hence this rename — this task\'s Fix batch item 3a)', () => {
    // Choose bbox/pitch so cellCount is comfortably under the ceiling but
    // still large enough to prove the check isn't accidentally always-throw.
    const { cellCount } = sdfGridDims({ bboxMm: { min: [0, 0, 0], max: [1, 1, 1] }, pitchMm: 0.05 });
    expect(cellCount).toBeLessThanOrEqual(MAX_SDF_GRID_CELLS);
  });

  describe('assertSdfGridCellCountWithinCeiling — the guard PREDICATE itself, tested at the true boundary without allocating anything', () => {
    it('cellCount === MAX_SDF_GRID_CELLS is accepted (does not throw)', () => {
      expect(() => assertSdfGridCellCountWithinCeiling(MAX_SDF_GRID_CELLS)).not.toThrow();
    });

    it('cellCount === MAX_SDF_GRID_CELLS + 1 is rejected (SdfGridTooLargeError, with the exact requested count and limit)', () => {
      expect(() => assertSdfGridCellCountWithinCeiling(MAX_SDF_GRID_CELLS + 1)).toThrow(SdfGridTooLargeError);
      try {
        assertSdfGridCellCountWithinCeiling(MAX_SDF_GRID_CELLS + 1);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(SdfGridTooLargeError);
        const err = error as SdfGridTooLargeError;
        expect(err.requestedCellCount).toBe(MAX_SDF_GRID_CELLS + 1);
        expect(err.limit).toBe(MAX_SDF_GRID_CELLS);
      }
    });

    it('cellCount === MAX_SDF_GRID_CELLS - 1 is accepted (one below the boundary, sanity check)', () => {
      expect(() => assertSdfGridCellCountWithinCeiling(MAX_SDF_GRID_CELLS - 1)).not.toThrow();
    });
  });
});

describe('sampleSdfGrid — analytic sphere spot-asserts', () => {
  const radius = 2;
  const subdivisions = 2;
  const mesh: IndexedMesh = icosphereMesh(radius, subdivisions);
  const bvh = buildBvh(mesh);
  const pn = computePseudonormals(mesh);
  // Sagitta-derived tolerance — same derivation as
  // signedDistance.analytic.test.ts (icosphere facets sit inside the ideal
  // sphere by up to `radius * (1 - cos(theta/2))`).
  const baseAngle = Math.acos(1 / Math.sqrt(5));
  const theta = baseAngle / 2 ** subdivisions;
  const tolerance = 3 * radius * (1 - Math.cos(theta / 2));

  const pitchMm = 0.2;
  const bboxMm = { min: [-radius - 0.5, -radius - 0.5, -radius - 0.5] as const, max: [radius + 0.5, radius + 0.5, radius + 0.5] as const };

  function valueAt(result: ReturnType<typeof sampleSdfGrid>, ix: number, iy: number, iz: number): number {
    const [nx, ny] = result.dims;
    return result.grid[iz * ny * nx + iy * nx + ix]!;
  }

  it('the cell nearest the origin is deeply negative (inside), within tolerance of the analytic SDF at that EXACT sampled point', () => {
    const result = sampleSdfGrid(mesh, bvh, pn, { bboxMm, pitchMm });
    const [nx, ny, nz] = result.dims;
    // Nearest grid index to the origin — note this need not land EXACTLY on
    // (0,0,0) (origin + index*pitch is a discrete lattice); compare against
    // the analytic SDF at the ACTUAL sampled world coordinate, not at (0,0,0).
    const ix = Math.round((0 - result.origin[0]) / pitchMm);
    const iy = Math.round((0 - result.origin[1]) / pitchMm);
    const iz = Math.round((0 - result.origin[2]) / pitchMm);
    expect(ix).toBeGreaterThanOrEqual(0);
    expect(ix).toBeLessThan(nx);
    expect(iy).toBeLessThan(ny);
    expect(iz).toBeLessThan(nz);
    const sampledX = result.origin[0] + ix * pitchMm;
    const sampledY = result.origin[1] + iy * pitchMm;
    const sampledZ = result.origin[2] + iz * pitchMm;
    const analytic = Math.hypot(sampledX, sampledY, sampledZ) - radius;
    const v = valueAt(result, ix, iy, iz);
    expect(v).toBeLessThan(0);
    expect(Math.abs(v - analytic)).toBeLessThan(tolerance);
  });

  it('a corner cell of the padded bbox is positive (well outside)', () => {
    const result = sampleSdfGrid(mesh, bvh, pn, { bboxMm, pitchMm });
    const [nx, ny, nz] = result.dims;
    const v = valueAt(result, nx - 1, ny - 1, nz - 1);
    expect(v).toBeGreaterThan(0);
  });

  it('sign transitions: scanning the full +x extent through the sphere\'s equator crosses positive->negative->positive exactly twice, near x = -radius and x = +radius', () => {
    const result = sampleSdfGrid(mesh, bvh, pn, { bboxMm, pitchMm });
    const [nx] = result.dims;
    const iy = Math.round((0 - result.origin[1]) / pitchMm);
    const iz = Math.round((0 - result.origin[2]) / pitchMm);
    let sawNegative = false;
    const crossings: number[] = [];
    let prevSign: number | null = null;
    for (let ix = 0; ix < nx; ix++) {
      const v = valueAt(result, ix, iy, iz);
      const sign = v < 0 ? -1 : 1;
      if (sign < 0) sawNegative = true;
      if (prevSign !== null && sign !== prevSign) {
        crossings.push(result.origin[0] + ix * pitchMm);
      }
      prevSign = sign;
    }
    expect(sawNegative).toBe(true);
    expect(crossings.length).toBe(2);
    // First crossing (entering the sphere, +->-) near x = -radius; second
    // (exiting, -->+) near x = +radius.
    expect(Math.abs(crossings[0]! - -radius)).toBeLessThan(pitchMm + tolerance);
    expect(Math.abs(crossings[1]! - radius)).toBeLessThan(pitchMm + tolerance);
  });
});

describe('sampleSdfGrid — determinism', () => {
  function hashGrid(grid: Float32Array): string {
    const hash = createHash('sha256');
    hash.update(Buffer.from(grid.buffer, grid.byteOffset, grid.byteLength));
    return hash.digest('hex');
  }

  it('sampling the same mesh/options twice produces a byte-identical grid', () => {
    const mesh = icosphereMesh(1.5, 1);
    const bvh = buildBvh(mesh);
    const pn = computePseudonormals(mesh);
    const options = {
      bboxMm: { min: [-2, -2, -2] as const, max: [2, 2, 2] as const },
      pitchMm: 0.5,
    };
    const first = sampleSdfGrid(mesh, bvh, pn, options);
    const second = sampleSdfGrid(mesh, bvh, pn, options);
    expect(hashGrid(second.grid)).toBe(hashGrid(first.grid));
    expect(second.dims).toEqual(first.dims);
    expect(second.origin).toEqual(first.origin);
  });
});

describe('sampleSdfGrid — bandMm restricts computation to candidate cells near the surface', () => {
  const mesh = icosphereMesh(2, 2);
  const bvh = buildBvh(mesh);
  const pn = computePseudonormals(mesh);
  const pitchMm = 0.2;
  const bboxMm = { min: [-3, -3, -3] as const, max: [3, 3, 3] as const };

  it('a cell far from the mesh bbox (outside band) is the +Infinity sentinel', () => {
    const bandMm = 0.3;
    const result = sampleSdfGrid(mesh, bvh, pn, { bboxMm, pitchMm, bandMm });
    expect(result.bandMm).toBe(bandMm);
    const [nx, ny, nz] = result.dims;
    // Far corner of the padded bbox — several mm from the radius-2 sphere,
    // well beyond a 0.3mm band.
    const v = result.grid[(nz - 1) * ny * nx + (ny - 1) * nx + (nx - 1)]!;
    expect(v).toBe(Number.POSITIVE_INFINITY);
  });

  it('a cell right at the surface (within band) has a real (finite) computed value, matching the dense (unbanded) result', () => {
    const bandMm = 0.3;
    const dense = sampleSdfGrid(mesh, bvh, pn, { bboxMm, pitchMm });
    const banded = sampleSdfGrid(mesh, bvh, pn, { bboxMm, pitchMm, bandMm });
    const [nx, ny] = dense.dims;
    // Grid index nearest the point (2, 0, 0), which sits ON the ideal
    // sphere's surface (and very close to the polyhedral mesh's surface).
    const ix = Math.round((2 - dense.origin[0]) / pitchMm);
    const iy = Math.round((0 - dense.origin[1]) / pitchMm);
    const iz = Math.round((0 - dense.origin[2]) / pitchMm);
    const flat = iz * ny * nx + iy * nx + ix;
    expect(Number.isFinite(banded.grid[flat]!)).toBe(true);
    expect(banded.grid[flat]).toBeCloseTo(dense.grid[flat]!, 5);
  });

  it('dense (no bandMm) mode reports bandMm: null', () => {
    const result = sampleSdfGrid(mesh, bvh, pn, { bboxMm, pitchMm: 0.5 });
    expect(result.bandMm).toBeNull();
  });

  it('markCandidateCells never excludes a cell within bandMm of an actual triangle vertex', () => {
    const { dims, origin } = sdfGridDims({ bboxMm, pitchMm });
    const bandMm = 0.25;
    const mask = markCandidateCells(mesh, dims, origin, pitchMm, bandMm);
    const [nx, ny] = dims;
    // Every mesh VERTEX sits exactly ON the surface (distance 0 <= bandMm),
    // so the grid cell nearest each vertex must be marked a candidate.
    const vertexCount = mesh.positions.length / 3;
    for (let v = 0; v < vertexCount; v += 3) {
      const vx = mesh.positions[v * 3]!;
      const vy = mesh.positions[v * 3 + 1]!;
      const vz = mesh.positions[v * 3 + 2]!;
      const ix = Math.round((vx - origin[0]) / pitchMm);
      const iy = Math.round((vy - origin[1]) / pitchMm);
      const iz = Math.round((vz - origin[2]) / pitchMm);
      const flat = iz * ny * nx + iy * nx + ix;
      expect(mask[flat]).toBe(1);
    }
  });
});
