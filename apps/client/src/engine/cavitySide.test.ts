// Phase 9 Task 2 — pure side-selection helpers (engine/cavityDesign.ts).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@dqcad/shared-types';
import { mesioDistalDirection, proximalSide } from './cavityDesign';

describe('mesioDistalDirection', () => {
  it('is world X for a +Z insertion axis, unit length and orthogonal to a tilted axis', () => {
    expect(mesioDistalDirection([0, 0, 1])).toEqual([1, 0, 0]);
    const s = Math.SQRT1_2;
    const md = mesioDistalDirection([s, 0, s]);
    expect(Math.hypot(...md)).toBeCloseTo(1, 12);
    expect(md[0] * s + md[2] * s).toBeCloseTo(0, 12);
  });

  it('falls back to Y when the axis is along X', () => {
    expect(mesioDistalDirection([1, 0, 0])).toEqual([0, 1, 0]);
  });
});

describe('proximalSide', () => {
  const md: Vec3 = [1, 0, 0];

  it('is relative to the outline centroid, not world zero (the Task 2 bug)', () => {
    // Both faces at world x > 0, on opposite sides of the centroid x = 20.
    expect(
      proximalSide(
        [
          [16, 0, 1],
          [16, 0, 3],
        ],
        [20, 0, 2],
        md,
      ),
    ).toBe('mesial');
    expect(
      proximalSide(
        [
          [24, 0, 1],
          [24, 0, 3],
        ],
        [20, 0, 2],
        md,
      ),
    ).toBe('distal');
  });

  it('property: translating faces and centroid together never changes the side', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -50, max: 50, noNaN: true }),
        fc.double({ min: -50, max: 50, noNaN: true }),
        fc.double({ min: -50, max: 50, noNaN: true }),
        fc.double({ min: 0.5, max: 10, noNaN: true }),
        fc.boolean(),
        (tx, ty, tz, offset, negative) => {
          const dx = negative ? -offset : offset;
          const face: Vec3[] = [
            [tx + dx, ty, tz],
            [tx + dx, ty + 1, tz + 1],
          ];
          return (
            proximalSide(face, [tx, ty + 0.5, tz + 0.5], md) === (negative ? 'mesial' : 'distal')
          );
        },
      ),
    );
  });
});
