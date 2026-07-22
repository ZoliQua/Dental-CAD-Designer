// packages/kernel/src/register/register.test-fixtures.ts
//
// TEST-ONLY shared helpers for register/'s test suite (kabsch.analytic,
// icpRefine tests) — an independent, hand-derived rigid-transform reference
// (exact Rodrigues formula) the tests check kernel output against, kept out
// of the shipped kernel API (same "icosphere generator... kept out of the
// shipped kernel API" convention as halfedge.test-fixtures.ts).
import type { Vec3 } from '../bvh/geometry.ts';
import type { Mat3 } from './transform.ts';

/** A known rotation about an arbitrary axis, via the exact (not linearized)
 * Rodrigues formula — deliberately NOT reusing icpRefine.ts's own
 * `rodrigues` implementation, so tests checking against this are a real
 * cross-check, not a tautology. */
export function rotationAboutAxis(axisIn: Vec3, angleRad: number): Mat3 {
  const len = Math.hypot(axisIn[0], axisIn[1], axisIn[2]);
  const [x, y, z] = [axisIn[0] / len, axisIn[1] / len, axisIn[2] / len];
  const s = Math.sin(angleRad);
  const c = Math.cos(angleRad);
  const t = 1 - c;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}

export function applyRigid(rotation: Mat3, translation: Vec3, p: Vec3): Vec3 {
  return [
    rotation[0][0] * p[0] + rotation[0][1] * p[1] + rotation[0][2] * p[2] + translation[0],
    rotation[1][0] * p[0] + rotation[1][1] * p[1] + rotation[1][2] * p[2] + translation[1],
    rotation[2][0] * p[0] + rotation[2][1] * p[1] + rotation[2][2] * p[2] + translation[2],
  ];
}
