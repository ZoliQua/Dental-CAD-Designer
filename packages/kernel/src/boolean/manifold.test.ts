import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { IndexedMesh } from '../mesh/types.ts';
import { icosphereMesh } from './manifold.test-fixtures.ts';
import { NonManifoldInputError, intersect, sectionCap, subtract, union, volume } from './manifold.ts';

// Unit cube (edge length 1), corner at (offsetX, offsetY, offsetZ). Winding
// verified directly against manifold-3d (status 'NoError', analytic volume)
// before being used here — see the module doc in ../boolean/manifold.ts and
// packages/kernel-workers/src/jobs/misc.ts's unitCubeMesh for the same fixture
// (duplicated rather than shared: kernel must not depend on kernel-workers
// — see eslint.config.js's boundaries policy — and this is 12 lines of
// fixture data, not shared logic).
function unitCubeMesh(offsetX = 0, offsetY = 0, offsetZ = 0): IndexedMesh {
  const positions = new Float64Array([
    offsetX, offsetY, offsetZ,
    offsetX + 1, offsetY, offsetZ,
    offsetX + 1, offsetY + 1, offsetZ,
    offsetX, offsetY + 1, offsetZ,
    offsetX, offsetY, offsetZ + 1,
    offsetX + 1, offsetY, offsetZ + 1,
    offsetX + 1, offsetY + 1, offsetZ + 1,
    offsetX, offsetY + 1, offsetZ + 1,
  ]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, // bottom (-z)
    4, 5, 6, 4, 6, 7, // top (+z)
    0, 1, 5, 0, 5, 4, // front (-y)
    1, 2, 6, 1, 6, 5, // right (+x)
    2, 3, 7, 2, 7, 6, // back (+y)
    0, 4, 7, 0, 7, 3, // left (-x)
  ]);
  return { positions, indices };
}

/** Open box: unitCubeMesh with its top face (z = 1) omitted, so one boundary
 * loop is left unclosed — not watertight, i.e. not a 2-manifold. */
function openBoxMesh(): IndexedMesh {
  const positions = new Float64Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
  ]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, // bottom (-z)
    // top (+z) intentionally omitted
    0, 1, 5, 0, 5, 4, // front (-y)
    1, 2, 6, 1, 6, 5, // right (+x)
    2, 3, 7, 2, 7, 6, // back (+y)
    0, 4, 7, 0, 7, 3, // left (-x)
  ]);
  return { positions, indices };
}

/** Real (sha256) content hash of a mesh's buffers, for asserting byte-level
 * determinism between two runs of the same op — not just "close enough"
 * numeric equality. */
function hashMesh(mesh: IndexedMesh): string {
  return createHash('sha256')
    .update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength))
    .update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength))
    .digest('hex');
}

describe('union', () => {
  it('unions two axis-aligned overlapping cubes to the analytic volume', async () => {
    // Two unit cubes overlapping by 0.5 along X: union volume = 1 + 1 - 0.5 = 1.5.
    const a = unitCubeMesh(0, 0, 0);
    const b = unitCubeMesh(0.5, 0, 0);
    const result = await union(a, b);
    const resultVolume = await volume(result);
    expect(Math.abs(resultVolume - 1.5)).toBeLessThan(1e-6);
  });
});

describe('subtract', () => {
  it('subtracts a half-overlapping cube to the analytic volume', async () => {
    // Cube minus a cube offset 0.5 along X: remaining volume = 1 - 0.5 = 0.5.
    const a = unitCubeMesh(0, 0, 0);
    const b = unitCubeMesh(0.5, 0, 0);
    const result = await subtract(a, b);
    const resultVolume = await volume(result);
    expect(Math.abs(resultVolume - 0.5)).toBeLessThan(1e-6);
  });
});

describe('intersect', () => {
  it('intersects two half-overlapping cubes to the analytic volume', async () => {
    const a = unitCubeMesh(0, 0, 0);
    const b = unitCubeMesh(0.5, 0, 0);
    const result = await intersect(a, b);
    const resultVolume = await volume(result);
    expect(Math.abs(resultVolume - 0.5)).toBeLessThan(1e-6);
  });
});

describe('union of disjoint spheres', () => {
  it('unions two disjoint icospheres to ~2x a single sphere volume', async () => {
    const radius = 2;
    // subdivisions=3 icosphere approximates the analytic sphere within
    // ~0.86% (measured directly against manifold-3d) — well clear of the
    // 2% relative tolerance asserted below, and far enough apart (radius 2,
    // centers 10 apart) to guarantee no overlap.
    const subdivisions = 3;
    const a = icosphereMesh(radius, subdivisions, [-5, 0, 0]);
    const b = icosphereMesh(radius, subdivisions, [5, 0, 0]);

    const singleVolume = await volume(a);
    const unionResult = await union(a, b);
    const unionVolume = await volume(unionResult);

    const expected = singleVolume * 2;
    const relativeError = Math.abs(unionVolume - expected) / expected;
    expect(relativeError).toBeLessThan(0.02);
  });
});

describe('non-manifold input', () => {
  it('rejects an open (non-watertight) box with a typed NonManifoldInputError', async () => {
    const open = openBoxMesh();
    const closed = unitCubeMesh(0.5, 0, 0);

    await expect(union(open, closed)).rejects.toThrow(NonManifoldInputError);
    await expect(union(open, closed)).rejects.toMatchObject({ status: 'NotManifold' });
  });
});

describe('determinism', () => {
  it('produces byte-identical output hashes across repeated runs of the same union', async () => {
    const a = unitCubeMesh(0, 0, 0);
    const b = unitCubeMesh(0.5, 0, 0);

    const first = await union(a, b);
    const second = await union(a, b);

    expect(hashMesh(first)).toBe(hashMesh(second));
  });
});

/** Sum of triangle areas of a flat `IndexedMesh` (used here only for
 * roughly-planar cap meshes, where this is a physically meaningful total
 * area regardless of triangulation). */
function meshArea(mesh: IndexedMesh): number {
  let area = 0;
  const { positions, indices } = mesh;
  for (let t = 0; t < indices.length / 3; t++) {
    const ia = indices[t * 3]!;
    const ib = indices[t * 3 + 1]!;
    const ic = indices[t * 3 + 2]!;
    const ax = positions[ia * 3]!, ay = positions[ia * 3 + 1]!, az = positions[ia * 3 + 2]!;
    const bx = positions[ib * 3]!, by = positions[ib * 3 + 1]!, bz = positions[ib * 3 + 2]!;
    const cx = positions[ic * 3]!, cy = positions[ic * 3 + 1]!, cz = positions[ic * 3 + 2]!;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const crossX = uy * vz - uz * vy;
    const crossY = uz * vx - ux * vz;
    const crossZ = ux * vy - uy * vx;
    area += 0.5 * Math.hypot(crossX, crossY, crossZ);
  }
  return area;
}

// sectionCap (Task 10): filled cross-section polygon via manifold-3d's
// slice — see boolean/manifold.ts's module doc for why this is
// DISPLAY-ONLY (Float32-WASM-boundary-bounded precision, never the
// acceptance-critical outline — that's ../section/polyline.ts's
// `sectionMesh`, exact Float64 end-to-end, tested in polyline.test.ts).
describe('sectionCap', () => {
  it('caps a unit cube through its middle (z=0.5) to a 1x1 square, area 1', async () => {
    const cube = unitCubeMesh(0, 0, 0);
    const cap = await sectionCap(cube, { point: [0, 0, 0.5], normal: [0, 0, 1] });
    expect(cap).not.toBeNull();
    expect(meshArea(cap!)).toBeCloseTo(1, 3);
    for (let i = 0; i < cap!.positions.length; i += 3) {
      expect(cap!.positions[i + 2]).toBeCloseTo(0.5, 3); // every cap vertex lies on the cutting plane
    }
  });

  it('caps an axis-aligned tilted plane through the cube with the correct analytic area', async () => {
    // Plane x=0.5 (normal along X instead of Z) — same square cross-section
    // by symmetry, exercising the general (non-identity) rotation path.
    const cube = unitCubeMesh(0, 0, 0);
    const cap = await sectionCap(cube, { point: [0.5, 0, 0], normal: [1, 0, 0] });
    expect(cap).not.toBeNull();
    expect(meshArea(cap!)).toBeCloseTo(1, 3);
  });

  it('caps a sphere through its center with area close to pi*r^2', async () => {
    const radius = 5;
    const sphere = icosphereMesh(radius, 4);
    const cap = await sectionCap(sphere, { point: [0, 0, 0], normal: [0, 0, 1] });
    expect(cap).not.toBeNull();
    const expectedArea = Math.PI * radius ** 2;
    // Loose tolerance: icosphere tessellation deficit (see
    // manifold.test-fixtures.ts's icosphereMesh doc, ~0.86% at subdivision
    // 4 for VOLUME; the cap's 2D cross-section deficit is the same order)
    // plus the documented Float32 WASM-boundary rounding — this is a
    // display-quality sanity check, not a precision claim.
    expect(Math.abs(meshArea(cap!) - expectedArea) / expectedArea).toBeLessThan(0.02);
  });

  it('returns null when the plane misses the mesh entirely', async () => {
    const cube = unitCubeMesh(0, 0, 0);
    const cap = await sectionCap(cube, { point: [0, 0, 100], normal: [0, 0, 1] });
    expect(cap).toBeNull();
  });

  it('rejects a non-watertight mesh with NonManifoldInputError', async () => {
    const open = openBoxMesh();
    await expect(sectionCap(open, { point: [0, 0, 0.5], normal: [0, 0, 1] })).rejects.toThrow(
      NonManifoldInputError,
    );
  });

  it('produces byte-identical output hashes across repeated calls', async () => {
    const cube = unitCubeMesh(0, 0, 0);
    const plane = { point: [0, 0, 0.5] as const, normal: [0.2, 0.3, 1] as const };
    const first = await sectionCap(cube, plane);
    const second = await sectionCap(cube, plane);
    expect(hashMesh(first!)).toBe(hashMesh(second!));
  });
});
