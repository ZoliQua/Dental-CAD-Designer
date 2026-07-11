// packages/kernel/src/section/plane.test.ts
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../bvh/geometry.ts';
import { DegeneratePlaneError, normalizePlane, projectToPlaneXY, signedDistance } from './plane.ts';

describe('normalizePlane', () => {
  it('normalizes a non-unit normal and computes d = normal . point', () => {
    const basis = normalizePlane({ point: [1, 2, 3], normal: [0, 0, 5] });
    expect(basis.normal).toEqual([0, 0, 1]);
    expect(basis.d).toBeCloseTo(3, 12);
  });

  it('produces an orthonormal (e1, e2, normal) frame for an arbitrary normal', () => {
    const basis = normalizePlane({ point: [0, 0, 0], normal: [1, 2, 3] });
    const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const length = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
    expect(length(basis.normal)).toBeCloseTo(1, 12);
    expect(length(basis.e1)).toBeCloseTo(1, 12);
    expect(length(basis.e2)).toBeCloseTo(1, 12);
    expect(dot(basis.e1, basis.normal)).toBeCloseTo(0, 12);
    expect(dot(basis.e2, basis.normal)).toBeCloseTo(0, 12);
    expect(dot(basis.e1, basis.e2)).toBeCloseTo(0, 12);
  });

  it('throws DegeneratePlaneError for a zero-length normal', () => {
    expect(() => normalizePlane({ point: [0, 0, 0], normal: [0, 0, 0] })).toThrow(DegeneratePlaneError);
  });

  it('throws DegeneratePlaneError for a near-zero (but not exactly zero) normal', () => {
    expect(() => normalizePlane({ point: [0, 0, 0], normal: [1e-14, 0, 0] })).toThrow(DegeneratePlaneError);
  });

  it('is deterministic: repeated calls with the same input produce bit-identical bases', () => {
    const plane = { point: [1, -2, 0.5] as Vec3, normal: [0.3, 0.7, -0.2] as Vec3 };
    const a = normalizePlane(plane);
    const b = normalizePlane(plane);
    expect(a).toEqual(b);
  });
});

describe('signedDistance', () => {
  it('is zero on the plane, positive on the normal side, negative on the other', () => {
    const basis = normalizePlane({ point: [0, 0, 0], normal: [0, 0, 1] });
    expect(signedDistance(basis, [5, -3, 0])).toBeCloseTo(0, 12);
    expect(signedDistance(basis, [0, 0, 2])).toBeCloseTo(2, 12);
    expect(signedDistance(basis, [0, 0, -2])).toBeCloseTo(-2, 12);
  });
});

describe('projectToPlaneXY', () => {
  it('round-trips: reconstructing u*e1 + v*e2 + d*normal recovers an on-plane point', () => {
    const basis = normalizePlane({ point: [1, 2, 3], normal: [1, 1, 1] });
    const p: Vec3 = [4, -1, 0]; // arbitrary point NOT necessarily on the plane
    const [u, v] = projectToPlaneXY(basis, p);
    const reconstructed: Vec3 = [
      u * basis.e1[0] + v * basis.e2[0] + signedDistance(basis, p) * basis.normal[0] + basis.d * basis.normal[0],
      u * basis.e1[1] + v * basis.e2[1] + signedDistance(basis, p) * basis.normal[1] + basis.d * basis.normal[1],
      u * basis.e1[2] + v * basis.e2[2] + signedDistance(basis, p) * basis.normal[2] + basis.d * basis.normal[2],
    ];
    expect(reconstructed[0]).toBeCloseTo(p[0], 9);
    expect(reconstructed[1]).toBeCloseTo(p[1], 9);
    expect(reconstructed[2]).toBeCloseTo(p[2], 9);
  });

  it('for a point exactly ON the plane, u*e1 + v*e2 + d*normal recovers it exactly', () => {
    const basis = normalizePlane({ point: [0, 0, 2], normal: [0, 0, 1] });
    const onPlane: Vec3 = [3, -4, 2];
    const [u, v] = projectToPlaneXY(basis, onPlane);
    const reconstructed: Vec3 = [
      u * basis.e1[0] + v * basis.e2[0] + basis.d * basis.normal[0],
      u * basis.e1[1] + v * basis.e2[1] + basis.d * basis.normal[1],
      u * basis.e1[2] + v * basis.e2[2] + basis.d * basis.normal[2],
    ];
    expect(reconstructed[0]).toBeCloseTo(onPlane[0], 12);
    expect(reconstructed[1]).toBeCloseTo(onPlane[1], 12);
    expect(reconstructed[2]).toBeCloseTo(onPlane[2], 12);
  });
});
