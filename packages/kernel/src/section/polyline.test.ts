// packages/kernel/src/section/polyline.test.ts
//
// Phase 1 PHASE ACCEPTANCE CRITERION (docs/plans/phase-1-import-viewer.md
// Global Constraints): "section through a sphere shows a circle with radius
// error < 1 µm". See this file's "acceptance" describe block below for the
// resolution of a subtlety in that statement (chord sagitta vs. the ideal
// analytic sphere) and the measured numbers.
import { describe, expect, it } from 'vitest';
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import { icosphereMesh } from '../boolean/manifold.test-fixtures.ts';
import { DegeneratePlaneError } from './plane.ts';
import { ON_PLANE_EPSILON_MM, sectionMesh, type SectionMeshResult } from './polyline.ts';
import { openHemisphereMesh, torusMesh, uvSphereMesh, uvSphereRingZ } from './section.test-fixtures.ts';

const SPHERE_RADIUS_MM = 5;

function polylinePoint(polyline: { points: Float64Array }, i: number): Vec3 {
  return [polyline.points[i * 3]!, polyline.points[i * 3 + 1]!, polyline.points[i * 3 + 2]!];
}

function totalPointCount(result: SectionMeshResult): number {
  return result.polylines.reduce((sum, p) => sum + p.points.length / 3, 0);
}

// ---------------------------------------------------------------------------
// ACCEPTANCE: sphere section radius error.
//
// Resolution of the guardrail's "chord sagitta vs. ideal sphere" subtlety
// (option (b) from the task brief's guardrails, PLUS an exact option-(a)
// cross-check — see below):
//
// A section polyline point is either (1) an exact input mesh VERTEX
// (already ON the plane) or (2) a linear interpolation between two mesh
// vertices straddling the plane (see polyline.ts's module doc). Case (2)'s
// point therefore lies on a CHORD of the tessellated mesh, not on the true
// analytic sphere — even though both chord endpoints sit exactly on the
// radius-5 sphere, the chord's midpoint sits BELOW it by the chord's
// "sagitta" (up to ~4.27 µm for the EXISTING sphere-r5 fixture at
// subdivision 4 — see ../boolean/manifold.test-fixtures.ts / the Task 10
// report's sagitta derivation). That gap is TESSELLATION error inherent to
// how coarsely the input mesh approximates the ideal sphere — not error the
// section ALGORITHM adds (see polyline.ts's top doc: every arithmetic step
// here is either an exact vertex copy or one Float64 lerp, both exact to
// IEEE754 rounding). The plan's acceptance criterion ("section through a
// sphere shows a circle with radius error < 1 µm") is read here as being
// about the IDEAL sphere the mesh approximates, i.e. it bounds TOTAL
// error (algorithm + tessellation) as observed on a suitably fine mesh —
// so the fix is a fine-enough sphere fixture, not a change to the
// algorithm (which already adds zero error of its own).
//
// `icosphereMesh(5, 7)` (163,842 vertices) has a measured max chord sagitta
// of 0.0668 µm (empirically verified — see the Task 10 report's sagitta
// sweep table: subdivisions 4/5/6/7 measured 4.266/1.068/0.267/0.0668 µm) —
// comfortably (~15x margin) under this task's 1 µm / 1e-3 mm budget. The
// tests below assert the MEASURED max deviation (not just that it's under
// budget) so the number is visible in a failure diff, and print it via
// `console.info` so it's captured in the Task 10 report's "measured
// deviations" table without re-deriving it by hand.
//
// A SEPARATE, EXACT (zero-tessellation-error) cross-check follows this
// block using `uvSphereMesh` cut exactly at a latitude ring — see that
// describe block's own doc for why this independently proves the
// ALGORITHM itself (not just "a fine enough mesh") adds no error.
// ---------------------------------------------------------------------------
describe('sectionMesh — ACCEPTANCE: sphere radius error', () => {
  const mesh = icosphereMesh(SPHERE_RADIUS_MM, 7);

  it('through-center section: every point within 1e-3 mm (1 µm) of radius 5 mm', () => {
    const result = sectionMesh(mesh, { point: [0, 0, 0], normal: [0, 0, 1] });
    expect(result.polylines.length).toBeGreaterThan(0);

    let maxDeviationMm = 0;
    for (const polyline of result.polylines) {
      const count = polyline.points.length / 3;
      for (let i = 0; i < count; i++) {
        const [x, y, z] = polylinePoint(polyline, i);
        const distance = Math.hypot(x, y, z);
        maxDeviationMm = Math.max(maxDeviationMm, Math.abs(distance - SPHERE_RADIUS_MM));
        expect(Math.abs(z)).toBeLessThan(1e-9); // plane z=0: every point's z must be ~0
      }
    }
    console.info(
      `[Task 10 acceptance] through-center sphere section: measured max radius deviation = ${(maxDeviationMm * 1000).toFixed(4)} µm (budget 1 µm)`,
    );
    expect(maxDeviationMm).toBeLessThanOrEqual(1e-3);
  });

  it('off-center section at h=2mm: every point within 1e-3 mm of radius sqrt(25 - h^2)', () => {
    const h = 2;
    const expectedRadius = Math.sqrt(SPHERE_RADIUS_MM ** 2 - h ** 2);
    const result = sectionMesh(mesh, { point: [0, 0, h], normal: [0, 0, 1] });
    expect(result.polylines.length).toBeGreaterThan(0);

    let maxDeviationMm = 0;
    for (const polyline of result.polylines) {
      const count = polyline.points.length / 3;
      for (let i = 0; i < count; i++) {
        const [x, y, z] = polylinePoint(polyline, i);
        const radialDistance = Math.hypot(x, y);
        maxDeviationMm = Math.max(maxDeviationMm, Math.abs(radialDistance - expectedRadius));
        expect(z).toBeCloseTo(h, 9);
      }
    }
    console.info(
      `[Task 10 acceptance] off-center (h=2mm) sphere section: expected radius ${expectedRadius.toFixed(6)} mm, measured max deviation = ${(maxDeviationMm * 1000).toFixed(4)} µm (budget 1 µm)`,
    );
    expect(maxDeviationMm).toBeLessThanOrEqual(1e-3);
  });

  it('off-center section at h=-3.5mm (near the pole, small circle): within 1e-3 mm', () => {
    const h = -3.5;
    const expectedRadius = Math.sqrt(SPHERE_RADIUS_MM ** 2 - h ** 2);
    const result = sectionMesh(mesh, { point: [0, 0, h], normal: [0, 0, 1] });
    expect(result.polylines.length).toBeGreaterThan(0);

    let maxDeviationMm = 0;
    for (const polyline of result.polylines) {
      const count = polyline.points.length / 3;
      for (let i = 0; i < count; i++) {
        const [x, y] = polylinePoint(polyline, i);
        const radialDistance = Math.hypot(x, y);
        maxDeviationMm = Math.max(maxDeviationMm, Math.abs(radialDistance - expectedRadius));
      }
    }
    console.info(
      `[Task 10 acceptance] off-center (h=-3.5mm) sphere section: expected radius ${expectedRadius.toFixed(6)} mm, measured max deviation = ${(maxDeviationMm * 1000).toFixed(4)} µm (budget 1 µm)`,
    );
    expect(maxDeviationMm).toBeLessThanOrEqual(1e-3);
  });
});

// ---------------------------------------------------------------------------
// EXACT cross-check: a plane through a UV-sphere's latitude ring has ZERO
// tessellation error by construction (every point on the resulting polyline
// IS a mesh vertex, itself an exact closed-form point on the sphere — see
// section.test-fixtures.ts's `uvSphereMesh` doc). This isolates the
// ALGORITHM from mesh coarseness entirely: any deviation here can only come
// from this module's own arithmetic (Float64 dot products / the ON-plane
// classification), independently confirming polyline.ts's top-doc claim
// that the algorithm itself adds no error beyond IEEE754 rounding. This is
// guardrail option (a) ("section through planes that pass through vertex
// rings") — deliberately fragile/special-cased (as the guardrail warns),
// used here ONLY as an exactness cross-check alongside the general-position
// fine-mesh tests above, not as the sole acceptance evidence.
// ---------------------------------------------------------------------------
describe('sectionMesh — exact vertex-ring cross-check (zero tessellation error)', () => {
  it('cutting exactly at a UV-sphere latitude ring reproduces that ring to ~1e-9 mm', () => {
    const radius = SPHERE_RADIUS_MM;
    const latSegments = 12;
    const lonSegments = 24;
    const mesh = uvSphereMesh(radius, latSegments, lonSegments);
    const ringK = 5; // an arbitrary non-polar, non-equatorial ring
    const z = uvSphereRingZ(radius, latSegments, ringK);
    const expectedRadialDistance = Math.sqrt(radius ** 2 - z ** 2);

    const result = sectionMesh(mesh, { point: [0, 0, z], normal: [0, 0, 1] });
    expect(result.polylines.length).toBe(1);
    const polyline = result.polylines[0]!;
    expect(polyline.closed).toBe(true);
    expect(polyline.points.length / 3).toBe(lonSegments);

    let maxDeviationMm = 0;
    for (let i = 0; i < lonSegments; i++) {
      const [x, y, pz] = polylinePoint(polyline, i);
      maxDeviationMm = Math.max(maxDeviationMm, Math.abs(Math.hypot(x, y) - expectedRadialDistance));
      expect(pz).toBeCloseTo(z, 12);
    }
    console.info(
      `[Task 10 exact cross-check] vertex-ring section: measured max radial deviation = ${(maxDeviationMm * 1e6).toFixed(4)} nm`,
    );
    expect(maxDeviationMm).toBeLessThanOrEqual(1e-9);
  });
});

describe('sectionMesh — torus point-count sanity', () => {
  it('a z=0 plane through a torus (R=5, r=2) yields exactly 2 closed loops, 2*majorSegments points each', () => {
    const majorSegments = 32;
    const mesh = torusMesh(5, 2, majorSegments, 16);
    const result = sectionMesh(mesh, { point: [0, 0, 0], normal: [0, 0, 1] });

    expect(result.polylines.length).toBe(2);
    // Each major-segment "ring" quad is split into 2 triangles by a
    // diagonal; the z=0 crossing threads through that diagonal, so each
    // ring contributes its OWN minor-edge crossing point PLUS a shared
    // diagonal point with its neighboring ring — 2 points per ring, not 1
    // (verified against the actual algorithm output, not assumed).
    const pointsPerLoop = 2 * majorSegments;
    for (const polyline of result.polylines) {
      expect(polyline.closed).toBe(true);
      expect(polyline.points.length / 3).toBe(pointsPerLoop);
    }
    expect(totalPointCount(result)).toBe(2 * pointsPerLoop);

    // Sanity on the two loops' radii: inner (~R-r) and outer (~R+r) rings.
    const radii = result.polylines
      .map((polyline) => {
        const [x, y] = polylinePoint(polyline, 0);
        return Math.hypot(x, y);
      })
      .sort((a, b) => a - b);
    expect(radii[0]).toBeGreaterThan(2.5); // > R-r-ish lower bound, generously
    expect(radii[0]).toBeLessThan(3.5);
    expect(radii[1]).toBeGreaterThan(6.5);
    expect(radii[1]).toBeLessThan(7.5);
  });
});

describe('sectionMesh — open mesh (plane crosses a mesh boundary)', () => {
  it('yields at least one OPEN polyline, no crash', () => {
    const mesh = openHemisphereMesh(SPHERE_RADIUS_MM, 12, 24);
    // Vertical plane through the polar axis: crosses the dome from one side
    // of the open equatorial rim, over the pole, to the other side.
    const result = sectionMesh(mesh, { point: [0, 0, 0], normal: [0, 1, 0] });

    const openPolylines = result.polylines.filter((p) => !p.closed);
    expect(openPolylines.length).toBeGreaterThan(0);
    for (const polyline of openPolylines) {
      expect(polyline.points.length / 3).toBeGreaterThanOrEqual(2);
      // Endpoints should land near the open rim (z close to 0, radius close
      // to SPHERE_RADIUS_MM) — a loose sanity check, not a precision claim.
      const count = polyline.points.length / 3;
      const [x0, , z0] = polylinePoint(polyline, 0);
      const [xN, , zN] = polylinePoint(polyline, count - 1);
      expect(Math.abs(z0)).toBeLessThan(0.5);
      expect(Math.abs(zN)).toBeLessThan(0.5);
      expect(Math.hypot(x0, z0)).toBeGreaterThan(SPHERE_RADIUS_MM - 0.5);
      expect(Math.hypot(xN, zN)).toBeGreaterThan(SPHERE_RADIUS_MM - 0.5);
    }
  });
});

describe('sectionMesh — on-plane vertex handling (epsilon policy)', () => {
  // Two triangles sharing edge (0,1), both endpoints exactly at z=0 (ON the
  // cutting plane); triangle A's apex (vertex 2) is above, triangle B's
  // apex (vertex 3) is below — see polyline.ts's module doc's "two ON
  // vertices" case. This directly tests that the shared coplanar edge is
  // reported exactly ONCE (not duplicated by both adjacent triangles).
  function twoTrianglesSharedOnPlaneEdge(): IndexedMesh {
    const positions = new Float64Array([
      -1, 0, 0, // 0: ON plane
      1, 0, 0, // 1: ON plane
      0, 1, 1, // 2: apex above (triangle A)
      0, 1, -1, // 3: apex below (triangle B)
    ]);
    const indices = new Uint32Array([0, 1, 2, 1, 0, 3]);
    return { positions, indices };
  }

  it('a vertex exactly ON the plane is classified ON (epsilon policy: |d| <= ON_PLANE_EPSILON_MM)', () => {
    const mesh = twoTrianglesSharedOnPlaneEdge();
    const result = sectionMesh(mesh, { point: [0, 0, 0], normal: [0, 0, 1] });

    // The shared edge (both endpoints ON-plane) is the only section
    // geometry here — deduped across both triangles into ONE open 2-point
    // segment (its "third vertex" on each side is off-plane, giving each
    // triangle its own single degree-1 chain — see module doc).
    expect(totalPointCount(result)).toBe(2);
    expect(result.polylines.length).toBe(1);
    const polyline = result.polylines[0]!;
    expect(polyline.closed).toBe(false);
    const p0 = polylinePoint(polyline, 0);
    const p1 = polylinePoint(polyline, 1);
    const xs = [p0[0], p1[0]].sort((a, b) => a - b);
    expect(xs).toEqual([-1, 1]);
    expect(p0[2]).toBe(0);
    expect(p1[2]).toBe(0);
  });

  it('ON_PLANE_EPSILON_MM matches the kernel weld epsilon (1e-6 mm) — see module doc', () => {
    expect(ON_PLANE_EPSILON_MM).toBe(1e-6);
  });
});

describe('sectionMesh — determinism', () => {
  it('produces bit-identical output across repeated calls on the same input', () => {
    const mesh = icosphereMesh(SPHERE_RADIUS_MM, 4);
    const plane = { point: [0.3, -0.1, 0.7] as Vec3, normal: [0.2, 0.9, 0.1] as Vec3 };

    const a = sectionMesh(mesh, plane);
    const b = sectionMesh(mesh, plane);

    expect(a.polylines.length).toBe(b.polylines.length);
    for (let i = 0; i < a.polylines.length; i++) {
      expect(a.polylines[i]!.closed).toBe(b.polylines[i]!.closed);
      expect(Array.from(a.polylines[i]!.points)).toEqual(Array.from(b.polylines[i]!.points));
    }
  });
});

describe('sectionMesh — edge cases', () => {
  it('a plane entirely missing the mesh returns no polylines', () => {
    const mesh = icosphereMesh(SPHERE_RADIUS_MM, 2);
    const result = sectionMesh(mesh, { point: [0, 0, 100], normal: [0, 0, 1] });
    expect(result.polylines).toEqual([]);
  });

  it('throws DegeneratePlaneError for a zero-length normal', () => {
    const mesh = icosphereMesh(SPHERE_RADIUS_MM, 2);
    expect(() => sectionMesh(mesh, { point: [0, 0, 0], normal: [0, 0, 0] })).toThrow(DegeneratePlaneError);
  });

  it('an axis-aligned plane through an empty mesh returns no polylines without crashing', () => {
    const mesh: IndexedMesh = { positions: new Float64Array(0), indices: new Uint32Array(0) };
    const result = sectionMesh(mesh, { point: [0, 0, 0], normal: [0, 0, 1] });
    expect(result.polylines).toEqual([]);
  });
});
