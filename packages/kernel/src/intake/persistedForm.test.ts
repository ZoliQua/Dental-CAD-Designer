// packages/kernel/src/intake/persistedForm.test.ts
//
// Phase 10 Task 2 — the persisted form of a mesh: what the server rebuilds
// from the binary STL the client stores (float32 coordinates, re-welded).
// The cross-check against the real io writer and parser lives in
// kernel-workers (persistedMeshForm.test.ts), which may import @dqcad/io.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { IndexedMesh } from '../mesh/types.ts';
import { openArchPrepCase } from '../die/die.test-fixtures.ts';
import { persistedMeshForm } from './persistedForm.ts';

function sameMesh(a: IndexedMesh, b: IndexedMesh): void {
  expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
  expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
}

describe('persistedMeshForm', () => {
  it('narrows every coordinate to float32 and keeps the triangles in order', () => {
    const { scan } = openArchPrepCase();
    const form = persistedMeshForm(scan);
    expect(form.indices.length).toBe(scan.indices.length);
    for (let t = 0; t < scan.indices.length / 3; t++) {
      for (let k = 0; k < 3; k++) {
        const sv = scan.indices[t * 3 + k]!;
        const fv = form.indices[t * 3 + k]!;
        for (let c = 0; c < 3; c++) expect(form.positions[fv * 3 + c]).toBe(Math.fround(scan.positions[sv * 3 + c]!));
      }
    }
  });

  it('leaves a float32-exact mesh whose vertices are in first-use order unchanged', () => {
    const mesh: IndexedMesh = {
      positions: Float64Array.from([0, 0, 0, 1.5, 0, 0, 0, 2.25, 0, 0, 0, 0.75]),
      indices: Uint32Array.from([0, 1, 2, 0, 3, 1, 1, 3, 2, 0, 2, 3]),
    };
    sameMesh(persistedMeshForm(mesh), mesh);
  });

  it('is idempotent: the persisted form of a persisted form is itself', () => {
    const coord = fc.double({ min: -50, max: 50, noNaN: true, noDefaultInfinity: true });
    fc.assert(
      fc.property(
        fc.array(fc.tuple(coord, coord, coord), { minLength: 3, maxLength: 24 }),
        fc.array(fc.tuple(fc.nat(), fc.nat(), fc.nat()), { minLength: 1, maxLength: 40 }),
        (points, tris) => {
          const n = points.length;
          const mesh: IndexedMesh = {
            positions: Float64Array.from(points.flat()),
            indices: Uint32Array.from(tris.flatMap(([a, b, c]) => [a % n, b % n, c % n])),
          };
          const once = persistedMeshForm(mesh);
          sameMesh(persistedMeshForm(once), once);
        },
      ),
      { numRuns: 200, seed: 20261027 },
    );
  });

  it('does not touch its input', () => {
    const { scan } = openArchPrepCase();
    const before = scan.positions.slice();
    persistedMeshForm(scan);
    expect(Array.from(scan.positions)).toEqual(Array.from(before));
  });
});
