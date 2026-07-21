// packages/kernel/src/axis/hemisphere.test.ts
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../bvh/geometry.ts';
import { dot, length } from './vec.ts';
import { fibonacciCapDirections, fibonacciHemisphereDirections, orthonormalBasis } from './hemisphere.ts';

const POLES: readonly Vec3[] = [
  [0, 0, 1],
  [1, 0, 0],
  [0, 1, 0],
  [1, 1, 1],
  [0.9, 0.1, 0.05],
];

describe('orthonormalBasis', () => {
  for (const pole of POLES) {
    it(`u,v,pole are mutually orthonormal for pole=${JSON.stringify(pole)}`, () => {
      const poleUnit: Vec3 = (() => {
        const len = length(pole);
        return [pole[0] / len, pole[1] / len, pole[2] / len];
      })();
      const { u, v } = orthonormalBasis(poleUnit);
      expect(length(u)).toBeCloseTo(1, 12);
      expect(length(v)).toBeCloseTo(1, 12);
      expect(dot(u, v)).toBeCloseTo(0, 12);
      expect(dot(u, poleUnit)).toBeCloseTo(0, 12);
      expect(dot(v, poleUnit)).toBeCloseTo(0, 12);
    });
  }
});

describe('fibonacciHemisphereDirections', () => {
  it('rejects a zero-length pole', () => {
    expect(() => fibonacciHemisphereDirections(8, [0, 0, 0])).toThrow(TypeError);
  });

  it('rejects a non-positive-integer count', () => {
    expect(() => fibonacciHemisphereDirections(0, [0, 0, 1])).toThrow(RangeError);
    expect(() => fibonacciHemisphereDirections(-1, [0, 0, 1])).toThrow(RangeError);
    expect(() => fibonacciHemisphereDirections(1.5, [0, 0, 1])).toThrow(RangeError);
  });

  it('every direction is unit length and strictly within the hemisphere (dot with pole > 0)', () => {
    const pole: Vec3 = [0, 0, 1];
    const dirs = fibonacciHemisphereDirections(64, pole);
    expect(dirs.length).toBe(64);
    for (const d of dirs) {
      expect(length(d)).toBeCloseTo(1, 12);
      expect(dot(d, pole)).toBeGreaterThan(0);
    }
  });

  it('dot(direction[i], pole) is exactly z_i = 1 - (i+0.5)/count — monotonically decreasing in i (index 0 is closest to pole)', () => {
    const pole: Vec3 = [0.3, -0.5, 0.8];
    const count = 32;
    const dirs = fibonacciHemisphereDirections(count, pole);
    const poleUnit: Vec3 = (() => {
      const len = length(pole);
      return [pole[0] / len, pole[1] / len, pole[2] / len];
    })();
    let prevDot = Infinity;
    for (let i = 0; i < count; i++) {
      const d = dot(dirs[i]!, poleUnit);
      const expectedZ = 1 - (i + 0.5) / count;
      expect(d).toBeCloseTo(expectedZ, 9);
      expect(d).toBeLessThan(prevDot);
      prevDot = d;
    }
  });

  it('is deterministic (two calls with the same inputs produce bit-identical output)', () => {
    const pole: Vec3 = [0.1, 0.2, 0.97];
    const a = fibonacciHemisphereDirections(48, pole);
    const b = fibonacciHemisphereDirections(48, pole);
    expect(a).toEqual(b);
  });
});

describe('fibonacciCapDirections', () => {
  it('rejects an out-of-range maxAngleRad', () => {
    expect(() => fibonacciCapDirections(8, [0, 0, 1], 0)).toThrow(RangeError);
    expect(() => fibonacciCapDirections(8, [0, 0, 1], -0.1)).toThrow(RangeError);
    expect(() => fibonacciCapDirections(8, [0, 0, 1], Math.PI + 0.01)).toThrow(RangeError);
  });

  it('every direction is within maxAngleRad of pole', () => {
    const pole: Vec3 = [0, 0, 1];
    const maxAngleRad = 0.4;
    const dirs = fibonacciCapDirections(24, pole, maxAngleRad);
    const cosMax = Math.cos(maxAngleRad);
    for (const d of dirs) {
      expect(length(d)).toBeCloseTo(1, 12);
      expect(dot(d, pole)).toBeGreaterThanOrEqual(cosMax - 1e-9);
    }
  });

  it('a very small cap angle concentrates directions very close to pole', () => {
    const pole: Vec3 = [0, 0, 1];
    const dirs = fibonacciCapDirections(16, pole, 0.01);
    for (const d of dirs) {
      expect(dot(d, pole)).toBeGreaterThan(Math.cos(0.011));
    }
  });

  it('index 0 is closest to pole', () => {
    const pole: Vec3 = [0, 0, 1];
    const dirs = fibonacciCapDirections(20, pole, 0.5);
    const dots = dirs.map((d) => dot(d, pole));
    expect(dots[0]).toBe(Math.max(...dots));
  });
});
