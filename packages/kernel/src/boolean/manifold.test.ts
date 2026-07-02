import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { IndexedMesh } from '../mesh/types.ts';
import { icosphereMesh } from './manifold.test-fixtures.ts';
import { NonManifoldInputError, intersect, subtract, union, volume } from './manifold.ts';

// Unit cube (edge length 1), corner at (offsetX, offsetY, offsetZ). Winding
// verified directly against manifold-3d (status 'NoError', analytic volume)
// before being used here — see the module doc in ../boolean/manifold.ts and
// packages/kernel-workers/src/jobs.ts's unitCubeMesh for the same fixture
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
