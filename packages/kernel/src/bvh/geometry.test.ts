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
import { BARYCENTRIC_EPSILON, rayAabbEntry, rayTriangleIntersect, type Vec3 } from './geometry.ts';

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

// Task-11-review Important 11: `rayTriangleIntersect`'s edge tests
// deliberately ACCEPT a hit up to `BARYCENTRIC_EPSILON` (1e-12) outside the
// triangle (this module's own "watertight edge policy" doc) — an accepted
// hit can therefore come back with a barycentric component that is
// EPSILON-NEGATIVE (or epsilon-over-1). Downstream, that value can end up
// stored verbatim in a `MarginAnchor.barycentric` (apps/client/src/engine/
// marginEditor.ts, via jobs/bvh.ts's `raycastMesh`), which the server's
// `marginAnchorSchema` enforces `minimum: 0` on — one epsilon-negative
// anchor 400s every subsequent save for that case forever. The fix clamps
// the returned barycentric to [0, 1] at this producer.
describe('rayTriangleIntersect — barycentric clamped to [0, 1] even for an accepted near-edge hit (Task-11-review Important 11)', () => {
  // Axis-aligned right triangle a=(0,0,0), b=(1,0,0), c=(0,1,0), scanned
  // along -Z from above — chosen so the intersection's (x, y) coordinates
  // equal (u, v) EXACTLY (every intermediate dot/cross product below only
  // ever multiplies by literal 0 or 1, so there is zero floating-point
  // rounding between the injected origin.x and the computed `u` — this
  // engineers a DETERMINISTIC epsilon-negative `u`, rather than hoping to
  // stumble on one via incidental rounding).
  const a: Vec3 = [0, 0, 0];
  const b: Vec3 = [1, 0, 0];
  const c: Vec3 = [0, 1, 0];
  const direction: Vec3 = [0, 0, -1];

  it('a ray landing exactly on the AB edge, offset -1e-13 outside it (within BARYCENTRIC_EPSILON), is accepted with u clamped to 0 — not returned negative', () => {
    const originX = -1e-13; // |originX| well under BARYCENTRIC_EPSILON (1e-12)
    expect(Math.abs(originX)).toBeLessThan(BARYCENTRIC_EPSILON);
    const origin: Vec3 = [originX, 0.3, 1];

    const hit = rayTriangleIntersect(origin, direction, a, b, c);

    expect(hit).not.toBeNull();
    const [w, u, v] = hit!.barycentric;
    // Every component clamped into [0, 1] — in particular u, which this
    // setup drives to exactly `originX` (negative) pre-clamp.
    expect(w).toBeGreaterThanOrEqual(0);
    expect(w).toBeLessThanOrEqual(1);
    expect(u).toBe(0); // clamped from the injected -1e-13
    expect(u).toBeGreaterThanOrEqual(0);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });

  it('a ray landing exactly on the AC edge, offset -1e-13 outside it, is accepted with v clamped to 0', () => {
    const originY = -1e-13;
    const origin: Vec3 = [0.3, originY, 1];

    const hit = rayTriangleIntersect(origin, direction, a, b, c);

    expect(hit).not.toBeNull();
    const [w, u, v] = hit!.barycentric;
    expect(v).toBe(0); // clamped from the injected -1e-13
    expect(w).toBeGreaterThanOrEqual(0);
    expect(w).toBeLessThanOrEqual(1);
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThanOrEqual(1);
  });

  it('a ray landing just OUTSIDE BARYCENTRIC_EPSILON is still rejected (the fix only clamps ACCEPTED hits, it does not widen acceptance)', () => {
    const origin: Vec3 = [-(BARYCENTRIC_EPSILON * 10), 0.3, 1];
    const hit = rayTriangleIntersect(origin, direction, a, b, c);
    expect(hit).toBeNull();
  });

  it('a normal, well-interior hit is unaffected by the clamp (components unchanged, still sum to ~1)', () => {
    const origin: Vec3 = [0.2, 0.3, 1];
    const hit = rayTriangleIntersect(origin, direction, a, b, c);
    expect(hit).not.toBeNull();
    const [w, u, v] = hit!.barycentric;
    expect(u).toBeCloseTo(0.2, 15);
    expect(v).toBeCloseTo(0.3, 15);
    expect(w + u + v).toBeCloseTo(1, 15);
  });
});
