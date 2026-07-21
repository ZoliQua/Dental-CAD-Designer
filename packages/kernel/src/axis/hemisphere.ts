// packages/kernel/src/axis/hemisphere.ts
//
// Deterministic Fibonacci-spiral direction sampling over a hemisphere (the
// FULL hemisphere for the coarse sweep, a small polar CAP for the fine
// refinement sweep) — see suggestInsertionAxis.ts's module doc for how
// these two are combined into a coarse -> fine insertion-axis search, and
// for the hemisphere ORIENTATION rationale (what `pole` is derived from).
//
// ## Method
//
// A Fibonacci/golden-angle spiral — the standard "sunflower seed" EQUAL-AREA
// (in solid angle) point distribution over a sphere cap (Vogel's formula;
// see e.g. Swinbank & Purser 2006 for the closed-form spherical case this
// specializes to a hemisphere/cap) — laid out directly in a LOCAL frame
// whose +Z axis is `pole`, then rotated into world space via a fixed,
// deterministic orthonormal basis (`orthonormalBasis` below). No
// `Math.random`/seeding anywhere, no iterative optimization (e.g. no
// spherical-cap relaxation/Lloyd iteration): every call with the same
// `(count, pole[, maxAngleRad])` produces the bit-identical direction set
// (CLAUDE.md's determinism invariant), and `suggestInsertionAxis.ts`'s
// tie-break rule depends on this file's specific, fixed generation ORDER
// (index 0 is always nearest `pole` — see each function's doc).
import type { Vec3 } from '../bvh/geometry.ts';
import { cross, normalizeOrZero } from './vec.ts';

/** The golden angle (radians): Vogel's formula's fixed per-sample azimuth
 * step, `pi * (3 - sqrt(5))` (~2.3999 rad, ~137.5 degrees). */
export const GOLDEN_ANGLE_RAD = Math.PI * (3 - Math.sqrt(5));

/**
 * A fixed, deterministic orthonormal basis `{u, v}` spanning the plane
 * perpendicular to unit vector `pole`, such that `{u, v, pole}` is a
 * right-handed orthonormal frame — the standard "pick whichever world axis
 * is LEAST parallel to the input as a reference, cross for the first
 * perpendicular, cross again for the second" tangent-frame construction
 * used throughout graphics. The reference-axis switch at `|pole.x| < 0.9`
 * avoids the near-parallel-vectors degeneracy (a reference axis nearly
 * parallel to `pole` would make the first cross product numerically
 * unstable); it introduces no discontinuity concern for THIS use (each
 * `suggestInsertionAxis` call picks one `pole` and builds one basis from
 * it, never sweeps `pole` continuously).
 */
export function orthonormalBasis(pole: Vec3): { u: Vec3; v: Vec3 } {
  const reference: Vec3 = Math.abs(pole[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalizeOrZero(cross(reference, pole));
  const v = cross(pole, u);
  return { u, v };
}

function requireUnitPole(pole: Vec3, callerName: string): Vec3 {
  const len = Math.hypot(pole[0], pole[1], pole[2]);
  if (!(len > 0)) {
    throw new TypeError(`${callerName}: pole must be a non-zero-length vector`);
  }
  return [pole[0] / len, pole[1] / len, pole[2] / len];
}

function requirePositiveIntCount(count: number, callerName: string): void {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`${callerName}: count must be a positive integer (got ${count})`);
  }
}

function localToWorld(u: Vec3, v: Vec3, poleUnit: Vec3, localX: number, localY: number, localZ: number): Vec3 {
  return normalizeOrZero([
    u[0] * localX + v[0] * localY + poleUnit[0] * localZ,
    u[1] * localX + v[1] * localY + poleUnit[1] * localZ,
    u[2] * localX + v[2] * localY + poleUnit[2] * localZ,
  ]);
}

/**
 * `count` directions spread over the FULL hemisphere centered on `pole`
 * (polar angle 0..90 degrees from `pole`, i.e. `local z` ranges over `(0,
 * 1]`) via the golden-angle spiral — EQUAL-AREA in solid angle (Vogel's
 * formula). Index `0` is always the direction CLOSEST to `pole` itself
 * (`z` nearest `1` — see the body below: `i=0` gives `z = 1 - 0.5/count`,
 * the largest `z` any sample gets), which is what
 * `suggestInsertionAxis.ts`'s documented tie-break relies on ("the
 * earliest-generated candidate wins an exact score tie" — for a fully
 * symmetric/no-undercut ROI, e.g. a sphere patch, every candidate ties and
 * the result deterministically resolves to `pole` itself).
 *
 * @throws {TypeError} if `pole` is the zero vector.
 * @throws {RangeError} if `count` is not a positive integer.
 */
export function fibonacciHemisphereDirections(count: number, pole: Vec3): Vec3[] {
  requirePositiveIntCount(count, 'fibonacciHemisphereDirections');
  const poleUnit = requireUnitPole(pole, 'fibonacciHemisphereDirections');
  const { u, v } = orthonormalBasis(poleUnit);
  const directions: Vec3[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const z = 1 - (i + 0.5) / count; // in (0, 1] for every i in [0, count) — a genuine hemisphere, never crossing the equator.
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const theta = i * GOLDEN_ANGLE_RAD;
    directions[i] = localToWorld(u, v, poleUnit, r * Math.cos(theta), r * Math.sin(theta), z);
  }
  return directions;
}

/**
 * `count` directions spread over a polar CAP of angular radius
 * `maxAngleRad` around `pole` (`local z` ranges over `[cos(maxAngleRad),
 * 1]`) — the same golden-angle equal-area construction as
 * `fibonacciHemisphereDirections`, restricted to a small cap instead of the
 * whole hemisphere. This is the "fine" sweep
 * `suggestInsertionAxis.ts`'s coarse -> refine loop runs around its coarse
 * winner (`pole` there is the coarse winner's direction, not the ROI's
 * derived hemisphere pole). Index `0` is again the direction closest to
 * `pole`.
 *
 * @throws {TypeError} if `pole` is the zero vector.
 * @throws {RangeError} if `count` is not a positive integer, or
 * `maxAngleRad` is not in `(0, pi]`.
 */
export function fibonacciCapDirections(count: number, pole: Vec3, maxAngleRad: number): Vec3[] {
  requirePositiveIntCount(count, 'fibonacciCapDirections');
  if (!(maxAngleRad > 0 && maxAngleRad <= Math.PI)) {
    throw new RangeError(`fibonacciCapDirections: maxAngleRad must be in (0, pi] (got ${maxAngleRad})`);
  }
  const poleUnit = requireUnitPole(pole, 'fibonacciCapDirections');
  const { u, v } = orthonormalBasis(poleUnit);
  const zMin = Math.cos(maxAngleRad);
  const directions: Vec3[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const z = 1 - ((i + 0.5) / count) * (1 - zMin); // i=0 nearest pole (z near 1), i=count-1 nearest the cap boundary (z near zMin) — mirrors fibonacciHemisphereDirections' own i=0-nearest-pole convention.
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const theta = i * GOLDEN_ANGLE_RAD;
    directions[i] = localToWorld(u, v, poleUnit, r * Math.cos(theta), r * Math.sin(theta), z);
  }
  return directions;
}
