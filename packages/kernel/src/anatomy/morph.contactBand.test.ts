// packages/kernel/src/anatomy/morph.contactBand.test.ts
//
// Phase 14 Task 2 (ADR-027 Decision 3): the proximal contact vertex is the
// nearest vertex whose fractional height above the margin lies in the
// profile's band. A cylinder tooth (cervical z = 0, occlusal z = 5, rings
// every 0.5 mm) beside a box neighbour whose face is equidistant from every
// ring it spans: without a band, the lowest-index tie (the most cervical
// ring) wins; with one, the nearest vertex in the band.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  planAnatomyMorph,
  morphAnatomy,
  MorphEmptyContactBandError,
  type AnatomyMorphInput,
  type IndexedMesh,
  type MorphOptions,
  type Vec3,
} from '../index.ts';

function outwardBox(min: Vec3, max: Vec3): IndexedMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const idx = [0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  return { positions: new Float64Array(v), indices: Uint32Array.from(idx) };
}

function cylinderTooth(radius: number, height: number, rings: number, segments: number): IndexedMesh {
  const positions: number[] = [];
  for (let r = 0; r < rings; r++) {
    const z = (height * r) / (rings - 1);
    for (let s = 0; s < segments; s++) {
      const th = (2 * Math.PI * s) / segments;
      positions.push(radius * Math.cos(th), radius * Math.sin(th), z);
    }
  }
  const indices: number[] = [];
  for (let r = 0; r < rings - 1; r++) {
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments;
      const a = r * segments + s;
      const b = r * segments + s1;
      const c = (r + 1) * segments + s;
      const d = (r + 1) * segments + s1;
      indices.push(a, b, d, a, d, c);
    }
  }
  return { positions: new Float64Array(positions), indices: Uint32Array.from(indices) };
}

function marginCircle(radius: number, z: number, n = 48): Vec3[] {
  const loop: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    loop.push([radius * Math.cos(th), radius * Math.sin(th), z]);
  }
  return loop;
}

const R = 1.2;
const H = 5;
const SEG = 24;
const TEST_OPTIONS: Partial<MorphOptions> = { contactInfluenceRadiusMm: 0.8, contactFacingRadiusMm: 1.0, cervicalSealBandMm: 0.6 };

function input(band?: { minFraction: number; maxFraction: number; axis?: Vec3 }): AnatomyMorphInput {
  return {
    placedMesh: cylinderTooth(R, H, 11, SEG),
    marginLoop: marginCircle(R, 0),
    contacts: [
      {
        kind: 'proximalDistal',
        // The −x face at x = R + 0.1 spans z ∈ [0.3, 4.7]: every ring from
        // z = 0.5 to 4.5 has a vertex (segment 0, at x = R) 0.1 mm from it.
        mesh: outwardBox([R + 0.1, -2, 0.3], [3, 2, 4.7]),
        targetPenetrationMm: 0.02,
        ...(band ? { heightBand: { axis: band.axis ?? [0, 0, 1], minFraction: band.minFraction, maxFraction: band.maxFraction } } : {}),
      },
    ],
    options: TEST_OPTIONS,
  };
}

/** The chosen contact vertex's height (z) — the cylinder's margin centroid is
 * the origin and its top is at H, so the fraction is z / H. */
function contactZ(inp: AnatomyMorphInput): number {
  const plan = planAnatomyMorph(inp);
  const v = plan.contacts[0]!.contactVertexIndex;
  return plan.positions[v * 3 + 2]!;
}

describe('planAnatomyMorph — the proximal contact height band (ADR-027 Decision 3)', () => {
  it('without a band the most cervical equidistant ring wins (lowest index)', () => {
    expect(contactZ(input())).toBeCloseTo(0.5, 12);
  });

  it('with a band the contact vertex is the nearest one inside it', () => {
    // [0.60, 0.95] of H = 5 ⇒ z ∈ [3.0, 4.75]: rings 3.0, 3.5, 4.0, 4.5 are
    // all 0.1 mm away; the lowest index (z = 3.0) wins.
    expect(contactZ(input({ minFraction: 0.6, maxFraction: 0.95 }))).toBeCloseTo(3.0, 12);
  });

  it('the band [0, 1] selects exactly as no band (bit-identical morph)', () => {
    const a = morphAnatomy(input());
    const b = morphAnatomy(input({ minFraction: 0, maxFraction: 1 }));
    expect(Array.from(b.mesh.positions)).toEqual(Array.from(a.mesh.positions));
  });

  it('the axis is normalised (a scaled axis selects the same vertex)', () => {
    expect(contactZ(input({ minFraction: 0.6, maxFraction: 0.95, axis: [0, 0, 7] }))).toBeCloseTo(3.0, 12);
  });

  it('a band with no vertex is an error, never a silent global fallback', () => {
    // Rings at fractions 0.9 and 1.0: (0.91, 0.99) holds none.
    expect(() => planAnatomyMorph(input({ minFraction: 0.91, maxFraction: 0.99 }))).toThrow(MorphEmptyContactBandError);
  });

  it('rejects an invalid band', () => {
    for (const band of [
      { minFraction: -0.1, maxFraction: 0.5 },
      { minFraction: 0.2, maxFraction: 1.1 },
      { minFraction: 0.5, maxFraction: 0.5 },
      { minFraction: Number.NaN, maxFraction: 0.5 },
      { minFraction: 0.2, maxFraction: 0.5, axis: [0, 0, 0] as Vec3 },
    ]) {
      expect(() => planAnatomyMorph(input(band)), JSON.stringify(band)).toThrow(RangeError);
    }
  });

  it('property: the chosen vertex lies in the band', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 0.8, noNaN: true }), fc.double({ min: 0.15, max: 0.2, noNaN: true }), (lo, width) => {
        const z = contactZ(input({ minFraction: lo, maxFraction: lo + width }));
        expect(z / H).toBeGreaterThanOrEqual(lo);
        expect(z / H).toBeLessThanOrEqual(lo + width);
      }),
      { numRuns: 60, seed: 1428 },
    );
  });
});
