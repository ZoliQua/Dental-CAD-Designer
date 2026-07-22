// packages/kernel/src/register/transform.ts
//
// 4x4 rigid-transform helpers for the register/ module — column-major
// 16-number layout, MATCHING @dqcad/shared-types' `SceneNode.transform`
// convention exactly ("4x4 matrix, 16 numbers, column-major") and,
// transitively, Three.js's `Matrix4.elements`/`Matrix4.fromArray` layout
// (apps/client/src/engine/SceneManager.ts is the only place in this repo
// that ever constructs a `THREE.Matrix4` from this array). `kernel/` never
// imports three.js (CLAUDE.md's layer rule) — this file re-derives the
// arithmetic from scratch rather than depending on it; the client-side
// round-trip test (apps/client/src/engine/alignment.test.ts) is what
// verifies the two independently-implemented conventions actually agree.
//
// Column-major layout: `m[col*4 + row]`. For a rigid transform composed of a
// row-major 3x3 rotation `R` (`R[row][col]`) and a translation `t`, columns
// 0-2 are R's three COLUMNS (`[R[0][c], R[1][c], R[2][c], 0]`) and column 3
// is `[t[0], t[1], t[2], 1]`:
//
//   [ R00 R01 R02 tx ]
//   [ R10 R11 R12 ty ]
//   [ R20 R21 R22 tz ]
//   [  0   0   0   1 ]
//
// stored as `[R00,R10,R20,0, R01,R11,R21,0, R02,R12,R22,0, tx,ty,tz,1]`.
import type { Vec3 } from '../bvh/geometry.ts';

export type Mat4 = readonly number[];
/** Row-major 3x3: `Mat3[row][col]`. */
export type Mat3 = readonly [Vec3, Vec3, Vec3];

export const IDENTITY_MAT4: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function assertMat4(m: Mat4, callerName: string): void {
  if (m.length !== 16) {
    throw new TypeError(`${callerName}: transform must have exactly 16 elements (column-major 4x4), got ${m.length}`);
  }
}

/** Composes a rigid transform (row-major 3x3 rotation + translation) into
 * this module's column-major `Mat4` layout — see this file's module doc. */
export function composeRigid(rotation: Mat3, translation: Vec3): Mat4 {
  return [
    rotation[0][0], rotation[1][0], rotation[2][0], 0,
    rotation[0][1], rotation[1][1], rotation[2][1], 0,
    rotation[0][2], rotation[1][2], rotation[2][2], 0,
    translation[0], translation[1], translation[2], 1,
  ];
}

/** Applies a `Mat4` to a POINT (not a direction — the translation is
 * added): `x' = m[0]*x + m[4]*y + m[8]*z + m[12]`, etc. — see this file's
 * module doc for the layout this implements. */
export function applyMat4ToPoint(m: Mat4, p: Vec3): Vec3 {
  assertMat4(m, 'applyMat4ToPoint');
  return [
    m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
    m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
    m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
  ];
}

/** `a * b` (apply `b` first, then `a`): `(a*b)*p === a*(b*p)`, standard
 * column-major composition. */
export function multiplyMat4(a: Mat4, b: Mat4): Mat4 {
  assertMat4(a, 'multiplyMat4');
  assertMat4(b, 'multiplyMat4');
  const out = new Array<number>(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += a[k * 4 + row]! * b[col * 4 + k]!;
      }
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/** Inverts a RIGID transform (rotation + translation only, no scale/shear):
 * `R' = R^T`, `t' = -R^T t`. This is not a general 4x4 inverse — callers
 * must only pass a `Mat4` built by `composeRigid`/`coarseAlignFromPointTriples`/
 * `icpRefine`, all of which always produce an orthonormal rotation block. */
export function invertRigidMat4(m: Mat4): Mat4 {
  assertMat4(m, 'invertRigidMat4');
  const rt: Mat3 = [
    [m[0]!, m[1]!, m[2]!],
    [m[4]!, m[5]!, m[6]!],
    [m[8]!, m[9]!, m[10]!],
  ];
  const t: Vec3 = [m[12]!, m[13]!, m[14]!];
  const negRtT: Vec3 = [
    -(rt[0][0] * t[0] + rt[0][1] * t[1] + rt[0][2] * t[2]),
    -(rt[1][0] * t[0] + rt[1][1] * t[1] + rt[1][2] * t[2]),
    -(rt[2][0] * t[0] + rt[2][1] * t[1] + rt[2][2] * t[2]),
  ];
  return composeRigid(rt, negRtT);
}
