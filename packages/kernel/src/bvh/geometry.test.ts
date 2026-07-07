// packages/kernel/src/bvh/geometry.test.ts
//
// Direct unit coverage for `rayAabbEntry`'s signed-zero handling — see the
// module doc on `rayAabbEntry` in geometry.ts for the full "why -0 matters"
// explanation. Short version: the pre-fix slab-test formula computed
// `(boundsMin[axis] - origin[axis]) * invDirection[axis]` unconditionally,
// and IEEE754 gives `0 * Infinity = NaN` (not the intended signed infinity)
// whenever `origin[axis]` sits EXACTLY on a box boundary and
// `direction[axis]` is exactly zero. Every subsequent comparison against
// that NaN is false, silently disabling the axis's pruning and producing a
// false-negative miss.
//
// `bvh.property.test.ts`'s fast-check coverage (the "committed NaN
// regression coverage") does NOT reach this: its coordinate generator snaps
// every near-zero sampled double to literal `+0` (`Math.abs(v) <
// MIN_MEANINGFUL_MAGNITUDE ? 0 : v` — see that file's comment), so it can
// never produce a `-0` direction component. `-0` only arises from real
// callers via arithmetic (e.g. `direction[axis] / length` when the
// numerator is `-0` or the direction was negated), not from a plain literal
// `0`, which is exactly why a hand-written case is needed here rather than
// relying on the property test to eventually roll one.
//
// The current implementation (see geometry.ts) actually already handles
// this correctly, because it branches on `direction[axis] === 0` BEFORE
// ever touching `invDirection` — and in JS, `-0 === 0` is `true`, so the
// signed-zero branch is taken regardless of the zero's sign, sidestepping
// the `0 * Infinity` computation entirely. These tests lock that behavior
// in directly (rather than relying on it staying true "by accident" of a
// refactor) for both signs of zero.
import { describe, expect, it } from 'vitest';
import { rayAabbEntry, type Vec3 } from './geometry.ts';

describe('rayAabbEntry — signed-zero direction component on an exact boundary', () => {
  const boundsMin: Vec3 = [1, -1, -1];
  const boundsMax: Vec3 = [3, 1, 1];

  it('resolves correctly for a NEGATIVE-ZERO direction component, origin on boundsMin.x', () => {
    const origin: Vec3 = [1, 0, 0]; // x exactly on boundsMin.x
    const direction: Vec3 = [-0, 1, 0];
    const invDirection: Vec3 = [1 / direction[0]!, 1 / direction[1]!, 1 / direction[2]!]; // [-Infinity, 1, Infinity]

    const entry = rayAabbEntry(origin, direction, invDirection, boundsMin, boundsMax, 0, Infinity);

    // Pre-fix defect: this would incorrectly return `null` (NaN poisoning
    // the tMin/tMax comparisons on the x axis) instead of resolving the x
    // axis as "ray parallel to x, origin within slab -> no constraint" and
    // falling through to the y-axis entry (t=0, since origin.y=0 is the
    // midpoint of [-1,1] moving in +y... actually entry is bound by y=-1
    // reached at t=-1, which is < tMin=0, and y=1 reached at t=1) -> tMin=0.
    expect(entry).not.toBeNull();
    expect(entry).toBe(0);
  });

  it('resolves correctly for a NEGATIVE-ZERO direction component, origin on boundsMax.x', () => {
    const origin: Vec3 = [3, 0, 0]; // x exactly on boundsMax.x
    const direction: Vec3 = [-0, 1, 0];
    const invDirection: Vec3 = [1 / direction[0]!, 1 / direction[1]!, 1 / direction[2]!];

    const entry = rayAabbEntry(origin, direction, invDirection, boundsMin, boundsMax, 0, Infinity);

    expect(entry).not.toBeNull();
    expect(entry).toBe(0);
  });

  it('mirror case: a plain (+0) direction component behaves identically', () => {
    const origin: Vec3 = [1, 0, 0];
    const direction: Vec3 = [0, 1, 0];
    const invDirection: Vec3 = [1 / direction[0]!, 1 / direction[1]!, 1 / direction[2]!]; // [Infinity, 1, Infinity]

    const entry = rayAabbEntry(origin, direction, invDirection, boundsMin, boundsMax, 0, Infinity);

    expect(entry).not.toBeNull();
    expect(entry).toBe(0);
  });

  it('mirror case: +0 direction component, origin on boundsMax.x', () => {
    const origin: Vec3 = [3, 0, 0];
    const direction: Vec3 = [0, 1, 0];
    const invDirection: Vec3 = [1 / direction[0]!, 1 / direction[1]!, 1 / direction[2]!];

    const entry = rayAabbEntry(origin, direction, invDirection, boundsMin, boundsMax, 0, Infinity);

    expect(entry).not.toBeNull();
    expect(entry).toBe(0);
  });

  it('correctly rejects when the parallel axis is on-boundary but the ray still misses another slab', () => {
    // Sanity check that the -0 handling isn't just "always hit": origin.y
    // outside [-1,1] with direction.y === 0 (parallel) must still miss.
    const origin: Vec3 = [1, 5, 0];
    const direction: Vec3 = [-0, -0, 1];
    const invDirection: Vec3 = [1 / direction[0]!, 1 / direction[1]!, 1 / direction[2]!];

    const entry = rayAabbEntry(origin, direction, invDirection, boundsMin, boundsMax, 0, Infinity);
    expect(entry).toBeNull();
  });
});
