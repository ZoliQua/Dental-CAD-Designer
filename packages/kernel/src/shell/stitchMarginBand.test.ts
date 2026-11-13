// packages/kernel/src/shell/stitchMarginBand.test.ts
//
// Phase 13 Task 3: the margin-band seam pairs the two rims by AZIMUTH. The
// Phase 4–12 zipper advanced by normalized INDEX (i/M vs j/N), which pairs
// correctly only when both rims are sampled uniformly in the same parameter.
// A cervical ring refined where the margin scallops (ADR-025/026) is not, so
// the seam's triangles skewed across up to a quarter turn and folded
// through the intaglio on real tooth 11 (20 self-intersecting face pairs).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../bvh/geometry.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { detAtan2 } from '../math/detMath.ts';
import { stitchMarginBand } from './shell.ts';

const AXIS: Vec3 = [0, 0, 1];

/** A rim-only "mesh": the ring's vertices, no triangles (the seam only reads
 * rim positions). */
function rim(azimuths: readonly number[], radius: number, z: number): { mesh: IndexedMesh; ring: number[] } {
  const positions: number[] = [];
  for (const a of azimuths) positions.push(radius * Math.cos(a), radius * Math.sin(a), z);
  return { mesh: { positions: new Float64Array(positions), indices: new Uint32Array(0) }, ring: azimuths.map((_, i) => i) };
}

const uniform = (n: number): number[] => Array.from({ length: n }, (_, i) => (2 * Math.PI * i) / n);

/** The seam measures azimuth around the inner rim's vertex centroid (the
 * margin's centre), so the test does too. */
function centreOf(mesh: IndexedMesh): [number, number] {
  const n = mesh.positions.length / 3;
  let x = 0, y = 0;
  for (let i = 0; i < n; i++) {
    x += mesh.positions[i * 3]!;
    y += mesh.positions[i * 3 + 1]!;
  }
  return [x / n, y / n];
}

const azOf = (positions: Float64Array, v: number, c: [number, number]): number =>
  detAtan2(positions[v * 3 + 1]! - c[1], positions[v * 3]! - c[0]);

/** Largest angular gap between consecutive vertices of a closed ring, seen
 * from `c`. */
function maxGap(mesh: IndexedMesh, c: [number, number]): number {
  const s = Array.from({ length: mesh.positions.length / 3 }, (_, v) => azOf(mesh.positions, v, c)).sort((a, b) => a - b);
  let g = 2 * Math.PI - (s[s.length - 1]! - s[0]!);
  for (let k = 1; k < s.length; k++) g = Math.max(g, s[k]! - s[k - 1]!);
  return g;
}

/** The widest azimuth span (seen from `c`) of any seam triangle. */
function widestSeamSpan(mesh: IndexedMesh, seamTriangleCount: number, c: [number, number]): number {
  const first = mesh.indices.length / 3 - seamTriangleCount;
  let widest = 0;
  for (let t = first; t < mesh.indices.length / 3; t++) {
    const a = [0, 1, 2].map((k) => azOf(mesh.positions, mesh.indices[t * 3 + k]!, c));
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        let d = Math.abs(a[p]! - a[q]!);
        if (d > Math.PI) d = 2 * Math.PI - d;
        widest = Math.max(widest, d);
      }
    }
  }
  return widest;
}

describe('stitchMarginBand — the seam pairs the rims by azimuth', () => {
  it('a ring refined in one quadrant (non-uniform): every seam triangle stays local', () => {
    // 40 outer vertices in the first quadrant, 10 over the other three.
    const outerAz = [...Array.from({ length: 40 }, (_, i) => (Math.PI / 2) * (i / 40)), ...Array.from({ length: 10 }, (_, i) => Math.PI / 2 + (1.5 * Math.PI * i) / 10)];
    const outer = rim(outerAz, 1.65, 0);
    const inner = rim(uniform(96), 1, 0);
    const { mesh, seamTriangleCount } = stitchMarginBand(outer.mesh, outer.ring, inner.mesh, inner.ring, AXIS);
    const c = centreOf(inner.mesh);
    const bound = Math.max(maxGap(outer.mesh, c), maxGap(inner.mesh, c));
    // Index pairing skews by up to a quarter turn here; azimuth pairing keeps
    // each triangle within one ring gap.
    expect(widestSeamSpan(mesh, seamTriangleCount, c)).toBeLessThanOrEqual(bound + 1e-12);
    expect(seamTriangleCount).toBe(50 + 96);
  });

  it('property: random star-shaped rims — every seam triangle spans at most the larger ring gap', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0.05, max: 1, noNaN: true }), { minLength: 8, maxLength: 60 }),
        fc.array(fc.double({ min: 0.05, max: 1, noNaN: true }), { minLength: 8, maxLength: 60 }),
        fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
        (outerSteps, innerSteps, phase) => {
          const toAz = (steps: number[], ph: number): number[] => {
            const total = steps.reduce((a, b) => a + b, 0);
            let acc = 0;
            return steps.map((s) => {
              const a = ph + (2 * Math.PI * acc) / total;
              acc += s;
              return a;
            });
          };
          const outerAz = toAz(outerSteps, phase);
          const innerAz = toAz(innerSteps, 0);
          const outer = rim(outerAz, 1.65, 0);
          const inner = rim(innerAz, 1, 0);
          const { mesh, seamTriangleCount } = stitchMarginBand(outer.mesh, outer.ring, inner.mesh, inner.ring, AXIS);
          const c = centreOf(inner.mesh);
          const bound = Math.max(maxGap(outer.mesh, c), maxGap(inner.mesh, c));
          expect(widestSeamSpan(mesh, seamTriangleCount, c)).toBeLessThanOrEqual(bound + 1e-12);
          expect(seamTriangleCount).toBe(outerAz.length + innerAz.length);
        },
      ),
      { seed: 1313, numRuns: 200 },
    );
  });

  it('two uniform rims of the same count: the seam is the plain ladder (each quad split once)', () => {
    const outer = rim(uniform(24), 1.65, 0);
    const inner = rim(uniform(24), 1, 0);
    const { mesh, seamTriangleCount } = stitchMarginBand(outer.mesh, outer.ring, inner.mesh, inner.ring, AXIS);
    expect(seamTriangleCount).toBe(48);
    expect(widestSeamSpan(mesh, seamTriangleCount, centreOf(inner.mesh))).toBeCloseTo((2 * Math.PI) / 24, 12);
  });
});
