// packages/kernel/src/decimate/decimate.property.test.ts
//
// Property-based tests (fast-check) for `decimateMesh` — per this task's
// brief: (1) output validity (analyzeMesh manifold where input manifold —
// `assertValidTopology` via halfedge), (2) error monotone with target, (3)
// determinism hashes. Seeded (not fast-check's auto-random seed) for CI
// reproducibility — same convention as curvature.property.test.ts /
// halfedge.property.test.ts.
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildHalfedge } from '../halfedge/build.ts';
import { assertValidTopology } from '../halfedge/index.ts';
import { icosphereMesh, torusMesh } from '../halfedge/halfedge.test-fixtures.ts';
import { analyzeMesh } from '../intake/analyze.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { decimateMesh, type DecimateMeshResult } from './decimate.ts';

const PROPERTY_SEED = 20260712;
const NUM_RUNS = 40;

function hashResult(result: DecimateMeshResult): string {
  const hash = createHash('sha256');
  const positions = result.mesh.positions;
  const indices = result.mesh.indices;
  hash.update(Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength));
  hash.update(Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength));
  hash.update(String(result.outputTriangleCount));
  hash.update(String(result.collapseCount));
  hash.update(String(result.maxErrorMm));
  return hash.digest('hex');
}

type ShapeDesc =
  | { kind: 'icosphere'; subdivisions: number }
  | { kind: 'torus'; majorSegments: number; minorSegments: number };

const shapeArb: fc.Arbitrary<ShapeDesc> = fc.oneof(
  fc.record({ kind: fc.constant('icosphere' as const), subdivisions: fc.integer({ min: 1, max: 2 }) }),
  fc.record({
    kind: fc.constant('torus' as const),
    majorSegments: fc.integer({ min: 6, max: 12 }),
    minorSegments: fc.integer({ min: 6, max: 12 }),
  }),
);

function meshFor(desc: ShapeDesc): IndexedMesh {
  return desc.kind === 'icosphere'
    ? icosphereMesh(5, desc.subdivisions)
    : torusMesh(3, 1, desc.majorSegments, desc.minorSegments);
}

describe('decimateMesh — property: output validity', () => {
  it('output is a valid, manifold IndexedMesh whenever the input was, for any reduction ratio', () => {
    fc.assert(
      fc.property(shapeArb, fc.double({ min: 0.05, max: 0.9, noNaN: true }), (desc, ratio) => {
        const mesh = meshFor(desc);
        const inputStats = analyzeMesh(mesh);
        fc.pre(inputStats.watertight && inputStats.manifoldEdges);
        const triangleCount = mesh.indices.length / 3;
        const target = Math.max(4, Math.floor(triangleCount * ratio));

        const result = decimateMesh(mesh, { targetTriangleCount: target });
        expect(result.outputTriangleCount).toBeGreaterThan(0);
        expect(result.outputTriangleCount).toBeLessThanOrEqual(result.inputTriangleCount);

        const hm = buildHalfedge(result.mesh); // throws if non-manifold
        assertValidTopology(hm); // throws on any structural invariant violation
        const outStats = analyzeMesh(result.mesh);
        expect(outStats.manifoldEdges).toBe(true);
        expect(outStats.watertight).toBe(true);
      }),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });
});

describe('decimateMesh — property: error monotone with target', () => {
  it('decimating further (smaller targetTriangleCount, no errorBoundMm) never DECREASES the max introduced error', () => {
    // No errorBoundMm on either run: both follow the IDENTICAL deterministic
    // greedy collapse sequence (see decimate.ts's "Lazy invalidation" /
    // determinism doc) up to the LARGER target's stopping point, after which
    // the smaller-target run is a strict continuation of that same sequence
    // — so its running max error can only stay the same or grow. This holds
    // exactly (not just typically), unlike a comparison across two different
    // errorBoundMm values (whose runs can genuinely diverge in accepted-
    // collapse order — see decimate.ts's "Lazy invalidation" doc for why an
    // early `break` there would be unsound).
    fc.assert(
      fc.property(
        shapeArb,
        fc.double({ min: 0.5, max: 0.9, noNaN: true }),
        fc.double({ min: 0.05, max: 0.4, noNaN: true }),
        (desc, looserRatio, stricterRatio) => {
          const mesh = meshFor(desc);
          const inputStats = analyzeMesh(mesh);
          fc.pre(inputStats.watertight && inputStats.manifoldEdges);
          const triangleCount = mesh.indices.length / 3;
          const looserTarget = Math.max(4, Math.floor(triangleCount * looserRatio));
          const stricterTarget = Math.max(1, Math.floor(triangleCount * stricterRatio));
          fc.pre(stricterTarget < looserTarget);

          const looser = decimateMesh(mesh, { targetTriangleCount: looserTarget });
          const stricter = decimateMesh(mesh, { targetTriangleCount: stricterTarget });
          expect(stricter.maxErrorMm).toBeGreaterThanOrEqual(looser.maxErrorMm);
        },
      ),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });

  it('the realized maxErrorMm never exceeds a given errorBoundMm', () => {
    fc.assert(
      fc.property(shapeArb, fc.double({ min: 0.01, max: 0.3, noNaN: true }), (desc, bound) => {
        const mesh = meshFor(desc);
        const inputStats = analyzeMesh(mesh);
        fc.pre(inputStats.watertight && inputStats.manifoldEdges);
        const result = decimateMesh(mesh, { errorBoundMm: bound });
        expect(result.maxErrorMm).toBeLessThanOrEqual(bound);
      }),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });
});

describe('decimateMesh — property: determinism', () => {
  it('repeated runs on the same mesh/options are bit-identical (hash match)', () => {
    fc.assert(
      fc.property(shapeArb, fc.double({ min: 0.1, max: 0.8, noNaN: true }), (desc, ratio) => {
        const mesh = meshFor(desc);
        const inputStats = analyzeMesh(mesh);
        fc.pre(inputStats.watertight && inputStats.manifoldEdges);
        const triangleCount = mesh.indices.length / 3;
        const target = Math.max(4, Math.floor(triangleCount * ratio));

        const a = decimateMesh(mesh, { targetTriangleCount: target });
        const b = decimateMesh(mesh, { targetTriangleCount: target });
        expect(hashResult(a)).toBe(hashResult(b));
      }),
      { seed: PROPERTY_SEED, numRuns: NUM_RUNS },
    );
  });
});
