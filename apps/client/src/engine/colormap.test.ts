// colormap.test.ts — value->RGB table for the diverging blue/white/red
// colormap (Task 9's brief: "colormap unit tests (value→RGB table)"), plus
// computeAutoRange's unsigned/signed/empty branches and
// distancesToVertexColors' Float64->Float32 conversion.
import { describe, expect, it } from 'vitest';
import {
  colorForValue,
  computeAutoRange,
  distancesToVertexColors,
  type ColorRange,
} from './colormap';

function expectRgbClose(actual: readonly [number, number, number], expected: readonly [number, number, number]) {
  expect(actual[0]).toBeCloseTo(expected[0], 6);
  expect(actual[1]).toBeCloseTo(expected[1], 6);
  expect(actual[2]).toBeCloseTo(expected[2], 6);
}

describe('colorForValue — value -> RGB table', () => {
  const range: ColorRange = { min: 0, max: 10 };

  it('range.min maps to pure blue', () => {
    expectRgbClose(colorForValue(0, range), [0.1, 0.35, 0.85]);
  });

  it('the range midpoint maps to pure white', () => {
    expectRgbClose(colorForValue(5, range), [1, 1, 1]);
  });

  it('range.max maps to pure red', () => {
    expectRgbClose(colorForValue(10, range), [0.85, 0.15, 0.1]);
  });

  it('a quarter-point blends blue toward white', () => {
    expectRgbClose(colorForValue(2.5, range), [0.55, 0.675, 0.925]);
  });

  it('a three-quarter point blends white toward red', () => {
    expectRgbClose(colorForValue(7.5, range), [0.925, 0.575, 0.55]);
  });

  it('clamps below range.min to pure blue (not extrapolated)', () => {
    expectRgbClose(colorForValue(-100, range), [0.1, 0.35, 0.85]);
  });

  it('clamps above range.max to pure red (not extrapolated)', () => {
    expectRgbClose(colorForValue(1000, range), [0.85, 0.15, 0.1]);
  });

  it('a symmetric signed range puts white exactly at 0', () => {
    const symmetric: ColorRange = { min: -0.05, max: 0.05 };
    expectRgbClose(colorForValue(0, symmetric), [1, 1, 1]);
    expectRgbClose(colorForValue(-0.05, symmetric), [0.1, 0.35, 0.85]);
    expectRgbClose(colorForValue(0.05, symmetric), [0.85, 0.15, 0.1]);
  });

  it('a degenerate range (max <= min) always returns white', () => {
    expectRgbClose(colorForValue(0, { min: 0, max: 0 }), [1, 1, 1]);
    expectRgbClose(colorForValue(5, { min: 3, max: 1 }), [1, 1, 1]);
  });
});

describe('computeAutoRange', () => {
  it('unsigned distances (all >= 0): range is [0, percentile-of-magnitude]', () => {
    const distances = Float64Array.from([0, 0.01, 0.02, 0.03, 0.04, 0.05]);
    const range = computeAutoRange(distances, 1); // 100th percentile == exact max
    expect(range.min).toBe(0);
    expect(range.max).toBeCloseTo(0.05, 12);
  });

  it('signed distances (some negative): range is symmetric about 0', () => {
    const distances = Float64Array.from([-0.05, -0.02, 0, 0.02, 0.03]);
    const range = computeAutoRange(distances, 1); // 100th percentile of |values| == 0.05
    expect(range.min).toBeCloseTo(-0.05, 12);
    expect(range.max).toBeCloseTo(0.05, 12);
  });

  it('a lower percentile clips outliers out of the range', () => {
    // 99 values at 1.0, one huge outlier at 1000 — the 98th percentile
    // should land well below the outlier, at (rank = 0.98*99 = 97.02 -> still 1.0).
    const distances = new Float64Array(100);
    distances.fill(1);
    distances[99] = 1000;
    const range = computeAutoRange(distances, 0.98);
    expect(range.max).toBeLessThan(10); // nowhere near the 1000 outlier
    expect(range.max).toBeGreaterThanOrEqual(1);
  });

  it('the 100th percentile of a uniform array equals that value exactly', () => {
    const distances = new Float64Array(50);
    distances.fill(0.017);
    const range = computeAutoRange(distances, 1);
    expect(range.min).toBe(0);
    expect(range.max).toBeCloseTo(0.017, 12);
  });

  it('empty distances -> degenerate [0, 0] range', () => {
    expect(computeAutoRange(new Float64Array(0))).toEqual({ min: 0, max: 0 });
  });

  it('does not mutate the input array (sorts an internal copy)', () => {
    const distances = Float64Array.from([0.05, 0.01, 0.03]);
    const snapshot = Array.from(distances);
    computeAutoRange(distances);
    expect(Array.from(distances)).toEqual(snapshot);
  });
});

describe('distancesToVertexColors', () => {
  it('produces a Float32Array sized 3x the input, matching colorForValue per-point', () => {
    const distances = Float64Array.from([0, 5, 10]);
    const range: ColorRange = { min: 0, max: 10 };
    const colors = distancesToVertexColors(distances, range);
    expect(colors).toBeInstanceOf(Float32Array);
    expect(colors.length).toBe(9);
    expectRgbClose([colors[0]!, colors[1]!, colors[2]!], colorForValue(0, range));
    expectRgbClose([colors[3]!, colors[4]!, colors[5]!], colorForValue(5, range));
    expectRgbClose([colors[6]!, colors[7]!, colors[8]!], colorForValue(10, range));
  });

  it('an empty distances array produces an empty color buffer', () => {
    expect(distancesToVertexColors(new Float64Array(0), { min: 0, max: 1 }).length).toBe(0);
  });
});
