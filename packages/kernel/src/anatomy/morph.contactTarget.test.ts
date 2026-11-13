// packages/kernel/src/anatomy/morph.contactTarget.test.ts
//
// Phase 13 Task 1 (ADR-026 Decisions 1–2): the contact target is VERIFIED.
// The fixed-direction Newton steps are kept; a target they do not converge
// is finished by closest-point (level-set) projection, and a target that is
// still not on the −t level set is reported unreached (`clampBound`), never
// as a merely off-target success. A target whose penetration is provided
// only by synthetic neighbour surface (a capture's closure) is flagged.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildBvh } from '../bvh/build.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { computePseudonormals } from '../sdf/pseudonormals.ts';
import { signedClosestPoint } from '../sdf/signedDistance.ts';
import {
  CONTACT_PROJECTION_STEPS,
  CONTACT_TARGET_TOLERANCE_MM,
  DEFAULT_MORPH_OPTIONS,
  morphAnatomy,
  newtonContactTarget,
  refineContactTarget,
  type AnatomyMorphInput,
} from './morph.ts';

const T = 0.02; // proximalContactPenetrationMm (profile)
const ITER = DEFAULT_MORPH_OPTIONS.contactRefinementIterations;
const EXTRA = DEFAULT_MORPH_OPTIONS.contactMaxExtraTravelMm;

/** Closed, outward-wound prism over a CCW xy polygon, z ∈ [z0, z1]. Triangle
 * order: the side faces first (side i joins polygon vertices i and i+1, two
 * triangles each), then the bottom and top caps — so a prefix of the side
 * faces can be declared "real". */
function prism(poly: readonly [number, number][], z0: number, z1: number): IndexedMesh {
  const n = poly.length;
  const positions: number[] = [];
  for (const [x, y] of poly) positions.push(x, y, z0);
  for (const [x, y] of poly) positions.push(x, y, z1);
  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    indices.push(i, j, n + j, i, n + j, n + i);
  }
  for (let i = 1; i < n - 1; i++) indices.push(0, i + 1, i); // bottom (−z)
  for (let i = 1; i < n - 1; i++) indices.push(n, n + i, n + i + 1); // top (+z)
  return { positions: new Float64Array(positions), indices: Uint32Array.from(indices) };
}

function neighbour(mesh: IndexedMesh) {
  return { mesh, bvh: buildBvh(mesh), pn: computePseudonormals(mesh) };
}

function sdf(nb: ReturnType<typeof neighbour>, p: Vec3): number {
  return signedClosestPoint(nb.mesh, nb.bvh, nb.pn, p).signedDistance;
}

const deg = (a: number): number => (a * Math.PI) / 180;

describe('refineContactTarget — a slowly converging fixed line is finished by projection', () => {
  // A box with a 90° edge along z at (1, 0). The contact vertex sits off the
  // edge at 20°, so n₀ enters the box obliquely: inside, s = −travel_in·sin20°
  // and Newton's error shrinks only by (1 − sin20°) ≈ 0.66 per step.
  const box = neighbour(prism([[1, 0], [2, 0], [2, 1], [1, 1]], -1, 1));
  const center: Vec3 = [1 - 0.1 * Math.cos(deg(20)), -0.1 * Math.sin(deg(20)), 0];

  it('the fixed-direction Newton alone stops micrometres off the level set', () => {
    const { target } = newtonContactTarget(center, box.mesh, box.bvh, box.pn, 'proximalDistal', T, ITER, EXTRA);
    expect(Math.abs(sdf(box, target) + T)).toBeGreaterThan(1e-4);
  });

  it('the verified root-find reaches s = −t and accepts it', () => {
    const r = refineContactTarget(center, box.mesh, box.bvh, box.pn, 'proximalDistal', T, ITER, EXTRA);
    expect(r.accepted).toBe(true);
    expect(r.clampBound).toBe(false);
    expect(Math.abs(sdf(box, r.target) + T)).toBeLessThanOrEqual(1e-9);
  });
});

describe('refineContactTarget — a fixed line with no root is reported unreached', () => {
  // A 30° wedge with its sharp edge at (1, 0). The contact vertex's closest
  // point is the edge, but n₀ (70°) lies outside the wedge's 0–30° interior:
  // the line only grazes the edge (the real tooth 11 mesial case, ADR-026
  // Context 1). Near the edge the −t level set does not exist.
  const wedge = neighbour(prism([[1, 0], [2, 0], [2, Math.tan(deg(30))]], -1, 1));
  const center: Vec3 = [1 + 0.1 * Math.cos(deg(250)), 0.1 * Math.sin(deg(250)), 0];

  it('the old Newton drifted off target WITHOUT a clamp flag (the Phase 12 defect)', () => {
    const r = newtonContactTarget(center, wedge.mesh, wedge.bvh, wedge.pn, 'proximalDistal', T, ITER, EXTRA);
    expect(r.clampBound).toBe(false);
    expect(Math.abs(sdf(wedge, r.target) + T)).toBeGreaterThan(1e-3);
  });

  it('the verified root-find never returns an unflagged miss', () => {
    const r = refineContactTarget(center, wedge.mesh, wedge.bvh, wedge.pn, 'proximalDistal', T, ITER, EXTRA);
    const miss = Math.abs(sdf(wedge, r.target) + T);
    expect(r.accepted ? miss <= CONTACT_TARGET_TOLERANCE_MM : r.clampBound).toBe(true);
    expect(r.accepted).toBe(!r.clampBound);
  });
});

describe('refineContactTarget — a contact vertex on the neighbour surface up to rounding', () => {
  // The P4 coupling fixture's mesial contact: the barrel's widest ring vertex
  // lies on the box's +x face, its closest point 1e-15 mm away in a rounding-
  // noise direction (here tangent to the face). Newton then never moves
  // (s ≡ 0 along the tangent): Phase 4–12 left this contact 20 µm off target
  // unflagged.
  const box = neighbour(prism([[-3, -2], [-1.8, -2], [-1.8, 2], [-3, 2]], 1.2, 2.2));
  const center: Vec3 = [-1.8, 1.0197970015766364e-15, 1.6];

  it('the fixed-direction Newton alone does not move the target', () => {
    const { target } = newtonContactTarget(center, box.mesh, box.bvh, box.pn, 'proximalMesial', T, ITER, EXTRA);
    expect(Math.abs(sdf(box, target) + T)).toBeGreaterThan(0.019);
  });

  it('the projection steps along the outward normal below the noise floor and reaches s = −t', () => {
    const r = refineContactTarget(center, box.mesh, box.bvh, box.pn, 'proximalMesial', T, ITER, EXTRA);
    expect(r.accepted).toBe(true);
    expect(Math.abs(sdf(box, r.target) + T)).toBeLessThanOrEqual(1e-9);
    // Straight into the face: the target is t behind it.
    expect(r.target[0]).toBeCloseTo(-1.8 - T, 12);
  });
});

describe('refineContactTarget — byte-identical where Newton converges', () => {
  it('a flat face: the same target bits as the Newton loop alone', () => {
    const box = neighbour(prism([[1, -1], [2, -1], [2, 1], [1, 1]], -1, 1));
    const center: Vec3 = [0.9, 0.05, 0.1];
    const newton = newtonContactTarget(center, box.mesh, box.bvh, box.pn, 'proximalDistal', T, ITER, EXTRA);
    const r = refineContactTarget(center, box.mesh, box.bvh, box.pn, 'proximalDistal', T, ITER, EXTRA);
    expect(r.accepted).toBe(true);
    expect(Array.from(r.target)).toEqual(Array.from(newton.target));
  });
});

describe('refineContactTarget — property: accepted ⇒ on the level set within the travel bound', () => {
  it('random boxes and contact vertices', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.05, max: 1.5, noNaN: true }), // box width (x)
        fc.double({ min: 0.05, max: 1.5, noNaN: true }), // box depth (y)
        fc.double({ min: 0.01, max: 0.8, noNaN: true }), // gap
        fc.double({ min: 95, max: 265, noNaN: true }), // approach angle (deg), from outside
        (w, dpt, gap, angle) => {
          const nb = neighbour(prism([[0, 0], [w, 0], [w, dpt], [0, dpt]], -1, 1));
          const a = deg(angle);
          const center: Vec3 = [gap * Math.cos(a), dpt / 2 + gap * Math.sin(a), 0];
          const g0 = sdf(nb, center);
          const r = refineContactTarget(center, nb.mesh, nb.bvh, nb.pn, 'proximalDistal', T, ITER, EXTRA);
          if (r.accepted) {
            expect(Math.abs(sdf(nb, r.target) + T)).toBeLessThanOrEqual(CONTACT_TARGET_TOLERANCE_MM);
            const travel = Math.hypot(r.target[0] - center[0], r.target[1] - center[1], r.target[2] - center[2]);
            expect(travel).toBeLessThanOrEqual(Math.max(0, g0) + T + EXTRA + 1e-12);
          } else {
            expect(r.clampBound).toBe(true);
          }
        },
      ),
      { seed: 1313, numRuns: 200 },
    );
  });

  it('uses a fixed number of projection steps', () => {
    expect(CONTACT_PROJECTION_STEPS).toBe(8);
    expect(CONTACT_TARGET_TOLERANCE_MM).toBe(1e-6);
  });
});

// ---- the synthetic-surface flag, through the morph -----------------------

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
      indices.push(a, b, b + segments, a, b + segments, a + segments);
    }
  }
  const top = positions.length / 3;
  positions.push(0, 0, height);
  for (let s = 0; s < segments; s++) {
    const s1 = (s + 1) % segments;
    indices.push((rings - 1) * segments + s, (rings - 1) * segments + s1, top);
  }
  const bottom = positions.length / 3;
  positions.push(0, 0, 0);
  for (let s = 0; s < segments; s++) {
    const s1 = (s + 1) % segments;
    indices.push(s1, s, bottom);
  }
  return { positions: new Float64Array(positions), indices: Uint32Array.from(indices) };
}

const R = 1.2;
const H = 5;
// The distal neighbour: a prism whose side faces come first; side 3 (from
// (R+0.1, 2) to (R+0.1, −2)) is the face toward the tooth.
const distal = prism([[R + 0.1, -2], [3, -2], [3, 2], [R + 0.1, 2]], 2.3, 4.7);
const FACING_SIDE_END = 8; // sides 0–3 are triangles 0–7; side 3 = triangles 6, 7

function input(realTriangleCount: number | undefined): AnatomyMorphInput {
  const loop: Vec3[] = [];
  for (let i = 0; i < 48; i++) loop.push([R * Math.cos((2 * Math.PI * i) / 48), R * Math.sin((2 * Math.PI * i) / 48), 0]);
  return {
    placedMesh: cylinderTooth(R, H, 11, 24),
    marginLoop: loop,
    contacts: [
      {
        kind: 'proximalDistal',
        mesh: distal,
        targetPenetrationMm: T,
        ...(realTriangleCount === undefined ? {} : { realTriangleCount }),
      },
    ],
    options: { contactInfluenceRadiusMm: 0.8, contactFacingRadiusMm: 1.0, cervicalSealBandMm: 0.6 },
  };
}

describe('morphAnatomy — a contact counts only on real neighbour surface (ADR-026 Decision 2)', () => {
  it('the facing face real: the target is on real surface', () => {
    const c = morphAnatomy(input(FACING_SIDE_END)).contacts[0]!;
    expect(c.targetOnSyntheticSurface).toBe(false);
    expect(c.achievedSignedDistanceMm).toBeCloseTo(-T, 6);
  });

  it('the facing face synthetic: the target is flagged', () => {
    const c = morphAnatomy(input(6)).contacts[0]!;
    expect(c.targetOnSyntheticSurface).toBe(true);
  });

  it('no realTriangleCount: every triangle is real, byte-identical to declaring all of them', () => {
    const a = morphAnatomy(input(undefined));
    const b = morphAnatomy(input(distal.indices.length / 3));
    expect(a.contacts[0]!.targetOnSyntheticSurface).toBe(false);
    expect(Array.from(a.mesh.positions)).toEqual(Array.from(b.mesh.positions));
  });

  it('rejects a realTriangleCount outside [1, triangleCount]', () => {
    for (const bad of [0, -1, 1.5, distal.indices.length / 3 + 1]) {
      expect(() => morphAnatomy(input(bad))).toThrow(RangeError);
    }
  });
});
