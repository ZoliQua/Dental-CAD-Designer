// packages/kernel/src/intake/weld.property.test.ts
//
// Property-based tests (fast-check) for weldVertices, per this task's
// brief: "weld idempotent (weld(weld(m))==weld(m))" and "welding a soup
// built from an indexed mesh reproduces it".
//
// Seeded explicitly (not fast-check's auto-random seed) so CI runs are
// reproducible — see docs/plans/phase-1-import-viewer.md's determinism
// constraint, matching packages/io/src/stl/roundtrip.property.test.ts's
// convention.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { IndexedMesh } from '../mesh/types.ts';
import { indexedToSoup } from './soup.ts';
import type { TriangleSoup } from './types.ts';
import { weldVertices } from './weld.ts';

const PROPERTY_SEED = 20260712;

/** Integer-coordinate points (mm), pairwise distinct by construction
 * (`fc.uniqueArray`) — the minimum possible separation between two
 * distinct integer triples is 1 mm, many orders of magnitude above the
 * 1e-6 mm weld epsilon, so these never coincidentally merge. */
const distinctPointsArb = fc.uniqueArray(
  fc.tuple(fc.integer({ min: -20, max: 20 }), fc.integer({ min: -20, max: 20 }), fc.integer({ min: -20, max: 20 })),
  { minLength: 3, maxLength: 12, selector: (p) => p.join(',') },
);

function soupFromPointRefs(points: ReadonlyArray<readonly [number, number, number]>, refs: readonly number[][]): TriangleSoup {
  const triangleCount = refs.length;
  const positions = new Float64Array(triangleCount * 9);
  refs.forEach((triangle, t) => {
    triangle.forEach((pointIndex, corner) => {
      const p = points[pointIndex]!;
      positions.set(p, t * 9 + corner * 3);
    });
  });
  return { positions, normals: null, triangleCount };
}

/** Fan-triangulates `points` (triangle i references points[0], points[i+1],
 * points[i+2]) — this makes the resulting `IndexedMesh` automatically
 * canonical in `weldVertices`' sense: scanning triangles in order, vertex
 * `k`'s first occurrence is at triangle `max(0, k - 1)`, i.e. strictly
 * increasing in `k` — exactly the "stable first-occurrence ordering" weld
 * produces. Every point is referenced (no orphans). */
function fanTriangulatedMesh(points: ReadonlyArray<readonly [number, number, number]>): IndexedMesh {
  const positions = new Float64Array(points.length * 3);
  points.forEach((p, i) => positions.set(p, i * 3));
  const triangleRefs: number[] = [];
  for (let i = 1; i < points.length - 1; i++) {
    triangleRefs.push(0, i, i + 1);
  }
  return { positions, indices: Uint32Array.from(triangleRefs) };
}

describe('weldVertices idempotence', () => {
  it('weld(weld(m)) reproduces weld(m) exactly (positions and indices)', () => {
    fc.assert(
      fc.property(
        distinctPointsArb,
        fc.array(fc.array(fc.nat({ max: 11 }), { minLength: 3, maxLength: 3 }), { minLength: 1, maxLength: 20 }),
        (points, rawRefs) => {
          const refs = rawRefs.map((triangle) => triangle.map((i) => i % points.length));
          const soup = soupFromPointRefs(points, refs);

          const first = weldVertices(soup);
          const second = weldVertices(indexedToSoup(first));

          expect(Array.from(second.positions)).toEqual(Array.from(first.positions));
          expect(Array.from(second.indices)).toEqual(Array.from(first.indices));
        },
      ),
      { seed: PROPERTY_SEED, numRuns: 200 },
    );
  });
});

describe('weldVertices reproduces an already-canonical indexed mesh', () => {
  it('weldVertices(indexedToSoup(mesh)) === mesh for a fan-triangulated (first-occurrence-order) mesh', () => {
    fc.assert(
      fc.property(distinctPointsArb, (points) => {
        const mesh = fanTriangulatedMesh(points);
        const rewelded = weldVertices(indexedToSoup(mesh));

        expect(Array.from(rewelded.positions)).toEqual(Array.from(mesh.positions));
        expect(Array.from(rewelded.indices)).toEqual(Array.from(mesh.indices));
      }),
      { seed: PROPERTY_SEED, numRuns: 200 },
    );
  });
});
