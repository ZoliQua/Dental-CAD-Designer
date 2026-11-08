// packages/kernel/src/anatomy/cervicalFit.test.ts
//
// Phase 10 Task 4 (ADR-023 Decision 2) — the cervical fit, tests first:
//
//  - ANALYTIC: an elliptic-cylinder template fitted to a circular margin, and
//    a circular template fitted to a tilted (non-planar) margin; the fitted
//    ring is checked against the closed-form emergence loop (each ring vertex
//    on the ray at its own azimuth, on the offset polygon) and the reported
//    residual against a direct measurement;
//  - PROPERTY: determinism (byte-identical), equivariance under rigid motions,
//    and no motion at or above the blend height;
//  - the typed refusals (a ring that is not an edge loop, a margin that is
//    not star-shaped around its centroid, a template too short to anchor).
//
// Phase 11 Task 1 (ADR-024 Decision 1) — the emergence outline is the exact
// outer boundary of the margin's projection dilated by the offset:
//
//  - ANALYTIC: a circle (R = r + d), a square (the rounded square), the
//    regular 192-gon between its vertices (the offset edge and the vertex
//    arc, in closed form), a notched "plus" whose concave corners the old
//    pointwise offset folds on, a near-radial segment, the ±π seam;
//  - PROPERTY: random star-shaped polygons — monotone azimuths over one
//    turn, every point exactly the offset from the projection (1e-12),
//    equivariance, repeated points ignored;
//  - the REAL margin: arch-case-01 tooth 11's committed reference trace, on
//    which the old offset folded (50 of 450 steps) and the fit refused.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Vec3 } from '../bvh/geometry.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { distanceToClosedPolyline } from '../offset/innerSurfaceOffset.ts';
import { dedupLoop, MARGIN_DEDUP_EPSILON_MM } from '../offset/innerSurfaceSolid.ts';
import { DEFAULT_WALL_THICKNESS_SAMPLE_SPACING_MM } from '../shell/shell.ts';
import {
  CERVICAL_EMERGENCE_DESIGN_MARGIN_MM,
  cervicalEmergenceOffsetMm,
  CervicalFitError,
  DEFAULT_CERVICAL_BLEND_MM,
  emergenceLoop,
  emergenceRadius,
  fitCervicalRing,
} from './cervicalFit.ts';

const SEGMENTS = 72;

/** A closed "template": rings of `SEGMENTS` vertices from z = 0 to `heightMm`
 * every `stepMm`, the cross-section `section(z, θ)`, fan-capped at both ends.
 * Ring 0 (z = 0) is the cervical ring; its indices are returned. */
function loftTemplate(
  section: (z: number, theta: number) => [number, number],
  heightMm = 8,
  stepMm = 0.5,
): { mesh: IndexedMesh; ring: number[] } {
  const positions: number[] = [];
  const indices: number[] = [];
  const rings: number[][] = [];
  const count = Math.round(heightMm / stepMm);
  for (let k = 0; k <= count; k++) {
    const z = k * stepMm;
    const ring: number[] = [];
    for (let s = 0; s < SEGMENTS; s++) {
      const th = (2 * Math.PI * s) / SEGMENTS;
      const [x, y] = section(z, th);
      ring.push(positions.length / 3);
      positions.push(x, y, z);
    }
    rings.push(ring);
  }
  for (let k = 0; k < count; k++) {
    for (let s = 0; s < SEGMENTS; s++) {
      const sn = (s + 1) % SEGMENTS;
      const l0 = rings[k]![s]!, l1 = rings[k]![sn]!, u0 = rings[k + 1]![s]!, u1 = rings[k + 1]![sn]!;
      indices.push(l0, l1, u1, l0, u1, u0);
    }
  }
  const bottom = positions.length / 3;
  positions.push(0, 0, 0);
  const top = positions.length / 3;
  positions.push(0, 0, heightMm);
  for (let s = 0; s < SEGMENTS; s++) {
    const sn = (s + 1) % SEGMENTS;
    indices.push(bottom, rings[0]![sn]!, rings[0]![s]!);
    indices.push(top, rings[count]![s]!, rings[count]![sn]!);
  }
  return { mesh: { positions: Float64Array.from(positions), indices: Uint32Array.from(indices) }, ring: rings[0]! };
}

function circle(r: number, n: number, z: (x: number, y: number) => number = () => 0): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    const x = r * Math.cos(th);
    const y = r * Math.sin(th);
    out.push([x, y, z(x, y)]);
  }
  return out;
}

function vertex(mesh: IndexedMesh, v: number): Vec3 {
  return [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!];
}

const OFFSET_MM = 0.52;

/** Distance from 2-D point (x, y) to the segment a–b. */
function segmentDistance2d(x: number, y: number, a: readonly number[], b: readonly number[]): number {
  const ex = b[0]! - a[0]!, ey = b[1]! - a[1]!;
  const ll = ex * ex + ey * ey;
  let s = ll > 0 ? ((x - a[0]!) * ex + (y - a[1]!) * ey) / ll : 0;
  s = Math.max(0, Math.min(1, s));
  return Math.hypot(x - (a[0]! + s * ex), y - (a[1]! + s * ey));
}

/** Even-odd point-in-polygon. */
function insidePolygon2d(x: number, y: number, poly: ReadonlyArray<readonly number[]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if (a[1]! > y !== b[1]! > y && x < ((b[0]! - a[0]!) * (y - a[1]!)) / (b[1]! - a[1]!) + a[0]!) inside = !inside;
  }
  return inside;
}

/** dist((x, y), P) for the region P bounded by the closed polygon `poly`. */
function distanceToRegion2d(x: number, y: number, poly: ReadonlyArray<readonly number[]>): number {
  if (insidePolygon2d(x, y, poly)) return 0;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) best = Math.min(best, segmentDistance2d(x, y, poly[i]!, poly[(i + 1) % poly.length]!));
  return best;
}

/** +1 / −1 when the azimuths around (cx, cy) are strictly monotone over
 * exactly one turn, else 0. */
function windsOnce(points: ReadonlyArray<readonly number[]>, cx = 0, cy = 0): number {
  let total = 0;
  let sign = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    let d = Math.atan2(b[1]! - cy, b[0]! - cx) - Math.atan2(a[1]! - cy, a[0]! - cx);
    if (d > Math.PI) d -= 2 * Math.PI;
    else if (d <= -Math.PI) d += 2 * Math.PI;
    if (d === 0 || (sign !== 0 && Math.sign(d) !== sign)) return 0;
    sign = Math.sign(d);
    total += d;
  }
  return Math.abs(Math.abs(total) - 2 * Math.PI) < 1e-9 ? sign : 0;
}

/** ADR-023's pointwise offset (the regression reference): each point moved
 * by `d` along the outward normal of its central difference. */
function pointwiseOffset2d(poly: ReadonlyArray<readonly number[]>, d: number): Array<[number, number]> {
  const n = poly.length;
  const orientation = windsOnce(poly, 0, 0);
  return poly.map((p, i) => {
    const a = poly[(i - 1 + n) % n]!, b = poly[(i + 1) % n]!;
    const tx = b[0]! - a[0]!, ty = b[1]! - a[1]!;
    const len = Math.hypot(tx, ty);
    return [p[0]! + (d * orientation * ty) / len, p[1]! + (-d * orientation * tx) / len];
  });
}

/** The closed polygon through `corners`, each edge split into `perEdge`
 * equal steps. */
function densify(corners: ReadonlyArray<readonly [number, number]>, perEdge: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i]!, b = corners[(i + 1) % corners.length]!;
    for (let k = 0; k < perEdge; k++) out.push([a[0] + ((b[0] - a[0]) * k) / perEdge, a[1] + ((b[1] - a[1]) * k) / perEdge]);
  }
  return out;
}

/** Closed form: the exact emergence outline of the regular n-gon with
 * circumradius r (a vertex at azimuth 0) dilated by d, at azimuth φ — the
 * offset edge where the ray meets it within the edge's slab, else the arc
 * around the nearer vertex. */
function regularPolygonOutlineRadius(r: number, n: number, d: number, phi: number): number {
  const step = (2 * Math.PI) / n;
  const beta = Math.PI / n;
  let alpha = phi - Math.floor(phi / step) * step;
  if (alpha >= step) alpha -= step;
  const tEdge = (r * Math.cos(beta) + d) / Math.cos(alpha - beta);
  if (Math.abs(tEdge * Math.sin(alpha - beta)) <= r * Math.sin(beta)) return tEdge;
  const a = Math.min(alpha, step - alpha);
  return r * Math.cos(a) + Math.sqrt(d * d - r * r * Math.sin(a) * Math.sin(a));
}

function to2d(points: readonly Vec3[]): Array<[number, number]> {
  return points.map((p) => [p[0], p[1]]);
}

function to3d(points: ReadonlyArray<readonly [number, number]>): Vec3[] {
  return points.map((p) => [p[0], p[1], 0]);
}

describe('cervicalEmergenceOffsetMm', () => {
  it('is the larger gap + the minimum wall + the wall gate\'s sampling margin + the design margin', () => {
    expect(cervicalEmergenceOffsetMm({ marginalGapMm: 0.02, cementGapMm: 0.05, minWallThicknessMm: 0.5 })).toBeCloseTo(
      0.05 + 0.5 + DEFAULT_WALL_THICKNESS_SAMPLE_SPACING_MM + CERVICAL_EMERGENCE_DESIGN_MARGIN_MM,
      15,
    );
    expect(cervicalEmergenceOffsetMm({ marginalGapMm: 0.08, cementGapMm: 0.05, minWallThicknessMm: 0.7 })).toBeCloseTo(
      0.08 + 0.7 + DEFAULT_WALL_THICKNESS_SAMPLE_SPACING_MM + CERVICAL_EMERGENCE_DESIGN_MARGIN_MM,
      15,
    );
  });

  it('refuses a non-finite or negative value', () => {
    expect(() => cervicalEmergenceOffsetMm({ marginalGapMm: NaN, cementGapMm: 0.05, minWallThicknessMm: 0.5 })).toThrow(RangeError);
    expect(() => cervicalEmergenceOffsetMm({ marginalGapMm: 0.02, cementGapMm: 0.05, minWallThicknessMm: -1 })).toThrow(RangeError);
  });
});

describe('emergenceLoop — the margin pushed outward, normal to the axis', () => {
  it('on a regular polygon each vertex moves radially by exactly the offset, at its own height', () => {
    const margin = circle(3, 192);
    const loop = emergenceLoop(margin, [0, 0, 1], OFFSET_MM);
    expect(loop).toHaveLength(192);
    for (let i = 0; i < 192; i++) {
      expect(Math.hypot(loop[i]![0], loop[i]![1])).toBeCloseTo(3 + OFFSET_MM, 12);
      expect(loop[i]![2]).toBe(0);
    }
  });

  it('is outward whatever the loop orientation', () => {
    const cw = circle(3, 96).reverse();
    for (const p of emergenceLoop(cw, [0, 0, 1], OFFSET_MM)) expect(Math.hypot(p[0], p[1])).toBeCloseTo(3 + OFFSET_MM, 12);
  });
});

/** The real-margin regression's insertion axis: what the golden real lane
 * (`crown-open-arch-acceptance`, RUN_CROWN_REAL_DIE=1) derives on
 * arch-case-01 tooth 11 with `suggestInsertionAxis` at kernel 0.36.0,
 * printed once and recorded — this test needs only the committed margin. */
const REAL_11_AXIS: Vec3 = [-0.22110068731611165, -0.6139895195305715, -0.7577145610155324];

/** `points` projected onto the plane ⟂ `axis` through their own centroid
 * (an orthonormal basis of the test's choosing). */
function projectToAxisPlane(points: readonly Vec3[], axis: Vec3, centre: Vec3): Array<[number, number]> {
  const al = Math.hypot(axis[0], axis[1], axis[2]);
  const a: Vec3 = [axis[0] / al, axis[1] / al, axis[2] / al];
  let u: Vec3 = [0, a[2], -a[1]];
  if (Math.hypot(u[0], u[1], u[2]) < 0.5) u = [-a[2], 0, a[0]];
  const ul = Math.hypot(u[0], u[1], u[2]);
  u = [u[0] / ul, u[1] / ul, u[2] / ul];
  const v: Vec3 = [a[1] * u[2] - a[2] * u[1], a[2] * u[0] - a[0] * u[2], a[0] * u[1] - a[1] * u[0]];
  return points.map((p) => {
    const d = [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]];
    return [d[0]! * u[0] + d[1]! * u[1] + d[2]! * u[2], d[0]! * v[0] + d[1]! * v[1] + d[2]! * v[2]];
  });
}

function meanOf(points: readonly Vec3[]): Vec3 {
  const s = points.reduce<Vec3>((acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]], [0, 0, 0]);
  return [s[0] / points.length, s[1] / points.length, s[2] / points.length];
}

/** Asserts the ADR-024 outline invariants for `loop` against `margin`: one
 * monotone turn around the margin centroid, and every point exactly `d`
 * from the margin's projection. */
function expectExactOutline(margin: readonly Vec3[], loop: readonly Vec3[], axis: Vec3, d: number, tol = 1e-12): void {
  const clean = dedupLoop(margin, MARGIN_DEDUP_EPSILON_MM);
  const c = meanOf(clean);
  const region = projectToAxisPlane(clean, axis, c);
  const outline = projectToAxisPlane(loop, axis, c);
  expect(loop).toHaveLength(clean.length);
  expect(windsOnce(outline)).not.toBe(0);
  for (const [x, y] of outline) expect(Math.abs(distanceToRegion2d(x, y, region) - d)).toBeLessThanOrEqual(tol);
}

describe('emergenceRadius / emergenceLoop — the exact outline of the dilated projection (ADR-024)', () => {
  const zeros = (n: number): number[] => new Array<number>(n).fill(0);

  it('on a regular 192-gon: r + d at every vertex azimuth, and the offset edge or the vertex arc between them (closed form)', () => {
    const q = to2d(circle(3, 192));
    for (let k = 0; k < 192; k++) {
      const th = (2 * Math.PI * k) / 192;
      expect(emergenceRadius(q, zeros(192), [Math.cos(th), Math.sin(th)], OFFSET_MM).radius).toBeCloseTo(3 + OFFSET_MM, 12);
    }
    for (let k = 0; k < 1000; k++) {
      const phi = (2 * Math.PI * (k + 0.37)) / 1000;
      const got = emergenceRadius(q, zeros(192), [Math.cos(phi), Math.sin(phi)], OFFSET_MM).radius;
      expect(Math.abs(got - regularPolygonOutlineRadius(3, 192, OFFSET_MM, phi))).toBeLessThan(1e-12);
    }
  });

  it('on a square: the rounded square — half-diagonal + d along a corner, half-side + d along an edge normal', () => {
    const q = densify([[2, 2], [-2, 2], [-2, -2], [2, -2]], 8);
    const h = zeros(q.length);
    const s = Math.SQRT1_2;
    for (const [dx, dy] of [[s, s], [-s, s], [-s, -s], [s, -s]] as const) {
      expect(Math.abs(emergenceRadius(q, h, [dx, dy], OFFSET_MM).radius - (2 * Math.SQRT2 + OFFSET_MM))).toBeLessThan(1e-12);
    }
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
      expect(Math.abs(emergenceRadius(q, h, [dx, dy], OFFSET_MM).radius - (2 + OFFSET_MM))).toBeLessThan(1e-12);
    }
    // 30°: on the offset edge x = 2 + d.
    const c30 = Math.cos(Math.PI / 6), s30 = Math.sin(Math.PI / 6);
    expect(Math.abs(emergenceRadius(q, h, [c30, s30], OFFSET_MM).radius - (2 + OFFSET_MM) / c30)).toBeLessThan(1e-12);
  });

  // A "plus": arms of half-width 1 reaching 3 from the centre. Its four
  // concave corners have radius 0 < d.
  const plus = densify(
    [[3, -1], [3, 1], [1, 1], [1, 3], [-1, 3], [-1, 1], [-3, 1], [-3, -1], [-1, -1], [-1, -3], [1, -3], [1, -1]],
    20,
  );

  it('a notched "plus": the old pointwise offset folds; the exact outline fills the notches and stays star-shaped, every point d from the margin', () => {
    // The regression: ADR-023's pointwise offset reverses at the notches.
    expect(windsOnce(plus)).toBe(1);
    expect(windsOnce(pointwiseOffset2d(plus, OFFSET_MM))).toBe(0);
    const margin = to3d(plus);
    const loop = emergenceLoop(margin, [0, 0, 1], OFFSET_MM);
    expectExactOutline(margin, loop, [0, 0, 1], OFFSET_MM);
    // In a notch, along its diagonal: the corner of the two offset arm edges
    // x = 1 + d and y = 1 + d.
    const s = Math.SQRT1_2;
    expect(Math.abs(emergenceRadius(plus, zeros(plus.length), [s, s], OFFSET_MM).radius - Math.SQRT2 * (1 + OFFSET_MM))).toBeLessThan(1e-12);
  });

  it('a tilted notched margin: the height is the nearest margin point\'s, on the margin\'s plane', () => {
    const tilt = 0.15;
    const margin: Vec3[] = plus.map(([x, y]) => [x, y, 0.3 + tilt * y]);
    const loop = emergenceLoop(margin, [0, 0, 1], OFFSET_MM);
    expectExactOutline(margin, loop, [0, 0, 1], OFFSET_MM);
    for (const p of loop) {
      // The nearest point of the planar margin lies on z = 0.3 + tilt·y.
      let best = Infinity;
      let z = NaN;
      for (let i = 0; i < margin.length; i++) {
        const a = margin[i]!, b = margin[(i + 1) % margin.length]!;
        const ex = b[0] - a[0], ey = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / (ex * ex + ey * ey)));
        const dist = Math.hypot(p[0] - a[0] - t * ex, p[1] - a[1] - t * ey);
        if (dist < best - 1e-12) {
          best = dist;
          z = 0.3 + tilt * (a[1] + t * ey);
        }
      }
      expect(p[2]).toBeCloseTo(z, 9);
    }
  });

  it('a near-radial segment stays exact and finite', () => {
    const q: Array<[number, number]> = [];
    for (let k = 0; k < 64; k++) {
      const th = (2 * Math.PI * k) / 64;
      const r = k === 10 ? 1.5 : 3;
      q.push([r * Math.cos(th), r * Math.sin(th)]);
      if (k === 10) q.push([4.5 * Math.cos(th + 1e-6), 4.5 * Math.sin(th + 1e-6)]);
    }
    const margin = to3d(q);
    const loop = emergenceLoop(margin, [0, 0, 1], OFFSET_MM);
    for (const p of loop) for (const x of p) expect(Number.isFinite(x)).toBe(true);
    expectExactOutline(margin, loop, [0, 0, 1], OFFSET_MM);
  });

  it('a margin point exactly on the ±π seam: its outline point is on the same ray, d out', () => {
    const q = densify([[2, 0], [0, 2], [-2, 0], [0, -2]], 4);
    const margin = to3d(q);
    const loop = emergenceLoop(margin, [0, 0, 1], OFFSET_MM);
    const seam = q.findIndex(([x, y]) => x === -2 && y === 0);
    expect(seam).toBeGreaterThan(0);
    expect(Math.abs(loop[seam]![0] + 2 + OFFSET_MM)).toBeLessThan(1e-12);
    expect(Math.abs(loop[seam]![1])).toBeLessThan(1e-12);
    // Continuous across the seam.
    const h = zeros(q.length);
    const above = emergenceRadius(q, h, [-Math.cos(1e-9), Math.sin(1e-9)], OFFSET_MM).radius;
    const below = emergenceRadius(q, h, [-Math.cos(1e-9), -Math.sin(1e-9)], OFFSET_MM).radius;
    expect(Math.abs(above - below)).toBeLessThan(1e-9);
    expectExactOutline(margin, loop, [0, 0, 1], OFFSET_MM);
  });

  /** A random star-shaped polygon around the origin: `n` azimuths jittered
   * within their slots, radii 3 mm ± `amplitude`. */
  const starPolygon = fc
    .record({
      n: fc.integer({ min: 16, max: 600 }),
      amplitude: fc.double({ min: 0, max: 0.4, noNaN: true }),
      jitter: fc.array(fc.tuple(fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true })), {
        minLength: 600,
        maxLength: 600,
      }),
    })
    .map(({ n, amplitude, jitter }) =>
      Array.from({ length: n }, (_, i): Vec3 => {
        const [aj, rj] = jitter[i]!;
        const th = (2 * Math.PI * (i + 0.45 * aj)) / n;
        const r = 3 * (1 + amplitude * rj);
        return [r * Math.cos(th), r * Math.sin(th), 0.1 * Math.sin(3 * th)];
      }),
    );
  const starAroundCentroid = (m: readonly Vec3[]): boolean => {
    const c = meanOf(m);
    return windsOnce(m.map((p) => [p[0], p[1]]), c[0], c[1]) !== 0;
  };

  it('property: on random star-shaped polygons the outline winds once, monotonically, and every point is exactly d from the projection', () => {
    fc.assert(
      fc.property(starPolygon, (margin) => {
        fc.pre(starAroundCentroid(margin));
        expectExactOutline(margin, emergenceLoop(margin, [0, 0, 1], OFFSET_MM), [0, 0, 1], OFFSET_MM);
      }),
      { numRuns: 25, seed: 11 },
    );
  });

  it('property: equivariant under rigid motions, and unchanged by repeated points', () => {
    const rotate = (q: Vec3, ax: number, az: number, t: Vec3): Vec3 => {
      let [x, y, z] = q;
      [y, z] = [y * Math.cos(ax) - z * Math.sin(ax), y * Math.sin(ax) + z * Math.cos(ax)];
      [x, y] = [x * Math.cos(az) - y * Math.sin(az), x * Math.sin(az) + y * Math.cos(az)];
      return [x + t[0], y + t[1], z + t[2]];
    };
    fc.assert(
      fc.property(
        starPolygon,
        fc.double({ min: -1.2, max: 1.2, noNaN: true }),
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        fc.tuple(fc.double({ min: -20, max: 20, noNaN: true }), fc.double({ min: -20, max: 20, noNaN: true }), fc.double({ min: -20, max: 20, noNaN: true })),
        fc.integer({ min: 1, max: 7 }),
        (margin, ax, az, t, every) => {
          fc.pre(starAroundCentroid(margin));
          const reference = emergenceLoop(margin, [0, 0, 1], OFFSET_MM);
          const moved = emergenceLoop(
            margin.map((p) => rotate(p, ax, az, t)),
            rotate([0, 0, 1], ax, az, [0, 0, 0]),
            OFFSET_MM,
          );
          reference.forEach((p, i) => {
            const e = rotate(p, ax, az, t);
            const g = moved[i]!;
            expect(Math.hypot(g[0] - e[0], g[1] - e[1], g[2] - e[2])).toBeLessThan(1e-9);
          });
          const repeated: Vec3[] = [];
          margin.forEach((p, i) => {
            repeated.push(p);
            if (i % every === 0) repeated.push([p[0], p[1], p[2]]);
          });
          expect(emergenceLoop(repeated, [0, 0, 1], OFFSET_MM)).toEqual(reference);
        },
      ),
      { numRuns: 12, seed: 29 },
    );
  });

  it('the REAL margin (arch-case-01 tooth 11, committed reference trace): the old offset folded; the outline is star-shaped and exact', () => {
    const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    const reference = JSON.parse(
      readFileSync(join(repoRoot, 'test-fixtures', 'margins', 'arch-case-01', '11.reference.json'), 'utf8'),
    ) as { resampledPoints: number[][] };
    const margin: Vec3[] = reference.resampledPoints.map((p) => [p[0]!, p[1]!, p[2]!]);
    const d = 0.651; // zirconia's emergence offset (Phase 10 demo)
    // The regression: the pointwise offset of the projection reverses.
    const clean = dedupLoop(margin, MARGIN_DEDUP_EPSILON_MM);
    const projected = projectToAxisPlane(clean, REAL_11_AXIS, meanOf(clean));
    expect(windsOnce(projected)).not.toBe(0);
    expect(windsOnce(pointwiseOffset2d(projected, d))).toBe(0);
    const loop = emergenceLoop(margin, REAL_11_AXIS, d);
    expectExactOutline(margin, loop, REAL_11_AXIS, d);
  });
});

describe('fitCervicalRing — analytic', () => {
  it('an elliptic cylinder fitted to a circular margin: every ring vertex lands on the closed-form emergence polygon at its azimuth', () => {
    const { mesh, ring } = loftTemplate((_z, th) => [3.0 * Math.cos(th), 2.2 * Math.sin(th)]);
    const margin = circle(3, 192);
    const fit = fitCervicalRing({ mesh, cervicalRing: ring, marginLoop: margin, insertionAxis: [0, 0, 1], emergenceOffsetMm: OFFSET_MM });
    const target = emergenceLoop(margin, [0, 0, 1], OFFSET_MM);
    let ringToLoop = 0;
    for (const v of ring) {
      const before = vertex(mesh, v);
      const after = vertex(fit.mesh, v);
      // ADR-024: the target is the EXACT outline at the vertex's azimuth (the
      // 192-gon's offset edge or vertex arc), not the sampled loop's chord.
      const phi = Math.atan2(before[1], before[0]);
      const radius = regularPolygonOutlineRadius(3, 192, OFFSET_MM, phi < 0 ? phi + 2 * Math.PI : phi);
      const len = Math.hypot(before[0], before[1]);
      const expected: Vec3 = [(radius * before[0]) / len, (radius * before[1]) / len, 0];
      expect(Math.hypot(after[0] - expected[0], after[1] - expected[1], after[2] - expected[2])).toBeLessThan(1e-9);
      ringToLoop = Math.max(ringToLoop, distanceToClosedPolyline(after, target));
    }
    // The residual is the symmetric polyline distance, measured directly.
    let loopToRing = 0;
    const fittedRing = ring.map((v) => vertex(fit.mesh, v));
    for (const p of target) loopToRing = Math.max(loopToRing, distanceToClosedPolyline(p, fittedRing));
    expect(fit.errorBoundMm).toBeCloseTo(Math.max(ringToLoop, loopToRing), 12);
    // The fitted ring is inscribed in the emergence outline at the ring
    // vertices' azimuths: bounded by the sagitta of its widest azimuth step
    // (the ellipse's vertices are denser in azimuth near its long axis), plus
    // the 192-gon's own sagitta, plus how far the exact outline bulges past
    // the sampled loop's chord (d(1 − cos(π/192)), ADR-024).
    let maxStep = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = vertex(mesh, ring[i]!), b = vertex(mesh, ring[(i + 1) % ring.length]!);
      let d = Math.abs(Math.atan2(b[1], b[0]) - Math.atan2(a[1], a[0]));
      if (d > Math.PI) d = 2 * Math.PI - d;
      maxStep = Math.max(maxStep, d);
    }
    const r = 3 + OFFSET_MM;
    expect(fit.errorBoundMm).toBeLessThan(
      r * (1 - Math.cos(maxStep / 2)) + r * (1 - Math.cos(Math.PI / 192)) + OFFSET_MM * (1 - Math.cos(Math.PI / 192)) + 1e-9,
    );
    expect(fit.ringVertexCount).toBe(SEGMENTS);
    expect(fit.anchorCount).toBeGreaterThanOrEqual(4);
  });

  it('a circular template fitted to a tilted margin: the ring follows the margin heights', () => {
    const tilt = Math.tan((10 * Math.PI) / 180);
    const { mesh, ring } = loftTemplate((_z, th) => [2.5 * Math.cos(th), 2.5 * Math.sin(th)]);
    // The margin: a circle in the plane z = y·tan10°, lifted 0.4 mm.
    const margin = circle(3, 192, (_x, y) => 0.4 + y * tilt);
    const fit = fitCervicalRing({ mesh, cervicalRing: ring, marginLoop: margin, insertionAxis: [0, 0, 1], emergenceOffsetMm: OFFSET_MM });
    const target = emergenceLoop(margin, [0, 0, 1], OFFSET_MM);
    const margin2d = to2d(margin);
    for (const v of ring) {
      const before = vertex(mesh, v);
      const after = vertex(fit.mesh, v);
      // Horizontally: the exact outline at the vertex's azimuth.
      const phi = Math.atan2(before[1], before[0]);
      const radius = regularPolygonOutlineRadius(3, 192, OFFSET_MM, phi < 0 ? phi + 2 * Math.PI : phi);
      const len = Math.hypot(before[0], before[1]);
      expect(Math.hypot(after[0] - (radius * before[0]) / len, after[1] - (radius * before[1]) / len)).toBeLessThan(1e-9);
      // Vertically: the height of its NEAREST margin point (ADR-024), which
      // lies on the tilted plane — the fitted ring reads the plane there.
      let nearY = 0;
      let nearDist = Infinity;
      for (let i = 0; i < margin2d.length; i++) {
        const a = margin2d[i]!, b = margin2d[(i + 1) % margin2d.length]!;
        const ex = b[0] - a[0], ey = b[1] - a[1];
        const s = Math.max(0, Math.min(1, ((after[0] - a[0]) * ex + (after[1] - a[1]) * ey) / (ex * ex + ey * ey)));
        const dist = Math.hypot(after[0] - a[0] - s * ex, after[1] - a[1] - s * ey);
        if (dist < nearDist) {
          nearDist = dist;
          nearY = a[1] + s * ey;
        }
      }
      expect(nearDist).toBeCloseTo(OFFSET_MM, 12);
      expect(after[2]).toBeCloseTo(0.4 + nearY * tilt, 9);
    }
    // Horizontally the emergence loop is the offset distance from the margin.
    for (let i = 0; i < target.length; i++) {
      expect(Math.hypot(target[i]![0] - margin[i]![0], target[i]![1] - margin[i]![1])).toBeCloseTo(OFFSET_MM, 12);
    }
    expect(fit.errorBoundMm).toBeLessThan(0.01);
  });
});

describe('fitCervicalRing — properties', () => {
  const base = loftTemplate((_z, th) => [3.0 * Math.cos(th), 2.4 * Math.sin(th)]);
  const margin = circle(3.2, 128, (x) => 0.2 + 0.05 * x);

  it('is deterministic (byte-identical)', () => {
    const input = { mesh: base.mesh, cervicalRing: base.ring, marginLoop: margin, insertionAxis: [0, 0, 1] as Vec3, emergenceOffsetMm: OFFSET_MM };
    const a = fitCervicalRing(input);
    const b = fitCervicalRing(input);
    expect(Buffer.from(a.mesh.positions.buffer).equals(Buffer.from(b.mesh.positions.buffer))).toBe(true);
    expect(a.mesh.indices).toEqual(base.mesh.indices);
  });

  it('nothing moves at or above the blend height; the input is not mutated', () => {
    const snapshot = base.mesh.positions.slice();
    const fit = fitCervicalRing({ mesh: base.mesh, cervicalRing: base.ring, marginLoop: margin, insertionAxis: [0, 0, 1], emergenceOffsetMm: OFFSET_MM });
    expect(base.mesh.positions).toEqual(snapshot);
    let checked = 0;
    for (let v = 0; v < snapshot.length / 3; v++) {
      if (snapshot[v * 3 + 2]! - fit.marginCentroid[2] >= fit.blendHeightMm) {
        expect(fit.mesh.positions[v * 3]).toBe(snapshot[v * 3]);
        expect(fit.mesh.positions[v * 3 + 1]).toBe(snapshot[v * 3 + 1]);
        expect(fit.mesh.positions[v * 3 + 2]).toBe(snapshot[v * 3 + 2]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(fit.blendHeightMm).toBeGreaterThanOrEqual(DEFAULT_CERVICAL_BLEND_MM);
  });

  it('a margin with repeated points (as the UI resamples it: one shared point per segment boundary, and the closing point) fits exactly like the clean one', () => {
    // Regression (Phase 10 Task 5): a duplicate gives a zero azimuth step,
    // which refused the margin as "not star-shaped".
    const dup: Vec3[] = [];
    margin.forEach((p, i) => {
      dup.push(p);
      if (i % 16 === 0) dup.push([p[0], p[1], p[2]]);
    });
    dup.push([margin[0]![0], margin[0]![1], margin[0]![2]]);
    const clean = fitCervicalRing({ mesh: base.mesh, cervicalRing: base.ring, marginLoop: margin, insertionAxis: [0, 0, 1], emergenceOffsetMm: OFFSET_MM });
    const withDup = fitCervicalRing({ mesh: base.mesh, cervicalRing: base.ring, marginLoop: dup, insertionAxis: [0, 0, 1], emergenceOffsetMm: OFFSET_MM });
    expect(Buffer.from(withDup.mesh.positions.buffer).equals(Buffer.from(clean.mesh.positions.buffer))).toBe(true);
    expect(withDup.errorBoundMm).toBe(clean.errorBoundMm);
    expect(emergenceLoop(dup, [0, 0, 1], OFFSET_MM)).toEqual(emergenceLoop(margin, [0, 0, 1], OFFSET_MM));
  });

  it('is equivariant under rigid motions', () => {
    const rotate = (q: Vec3, ax: number, ay: number, az: number, t: Vec3): Vec3 => {
      let [x, y, z] = q;
      [y, z] = [y * Math.cos(ax) - z * Math.sin(ax), y * Math.sin(ax) + z * Math.cos(ax)];
      [x, z] = [x * Math.cos(ay) + z * Math.sin(ay), -x * Math.sin(ay) + z * Math.cos(ay)];
      [x, y] = [x * Math.cos(az) - y * Math.sin(az), x * Math.sin(az) + y * Math.cos(az)];
      return [x + t[0], y + t[1], z + t[2]];
    };
    const reference = fitCervicalRing({ mesh: base.mesh, cervicalRing: base.ring, marginLoop: margin, insertionAxis: [0, 0, 1], emergenceOffsetMm: OFFSET_MM });
    fc.assert(
      fc.property(
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        fc.double({ min: -1.2, max: 1.2, noNaN: true }),
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        fc.tuple(fc.double({ min: -20, max: 20, noNaN: true }), fc.double({ min: -20, max: 20, noNaN: true }), fc.double({ min: -20, max: 20, noNaN: true })),
        (ax, ay, az, t) => {
          const move = (q: Vec3): Vec3 => rotate(q, ax, ay, az, t);
          const turn = (q: Vec3): Vec3 => rotate(q, ax, ay, az, [0, 0, 0]);
          const positions = new Float64Array(base.mesh.positions.length);
          for (let v = 0; v < positions.length / 3; v++) positions.set(move(vertex(base.mesh, v)), v * 3);
          const fit = fitCervicalRing({
            mesh: { positions, indices: base.mesh.indices },
            cervicalRing: base.ring,
            marginLoop: margin.map(move),
            insertionAxis: turn([0, 0, 1]),
            emergenceOffsetMm: OFFSET_MM,
          });
          for (let v = 0; v < positions.length / 3; v++) {
            const expected = move(vertex(reference.mesh, v));
            const got = vertex(fit.mesh, v);
            expect(Math.hypot(got[0] - expected[0], got[1] - expected[1], got[2] - expected[2])).toBeLessThan(1e-8);
          }
          expect(fit.errorBoundMm).toBeCloseTo(reference.errorBoundMm, 9);
        },
      ),
      { numRuns: 12, seed: 23 },
    );
  });
});

describe('fitCervicalRing — refusals', () => {
  const { mesh, ring } = loftTemplate((_z, th) => [3 * Math.cos(th), 3 * Math.sin(th)]);
  const margin = circle(3, 96);

  it('refuses a ring that is not a closed edge loop of the mesh', () => {
    const broken = [...ring];
    [broken[3], broken[4]] = [broken[4]!, broken[3]!];
    expect(() => fitCervicalRing({ mesh, cervicalRing: broken, marginLoop: margin, insertionAxis: [0, 0, 1], emergenceOffsetMm: OFFSET_MM })).toThrow(
      expect.objectContaining({ name: 'CervicalFitError', reason: 'ring-not-edge-loop' }),
    );
  });

  it('refuses a margin that is not star-shaped around its centroid', () => {
    // A loop that winds around twice.
    const twice: Vec3[] = [];
    for (let i = 0; i < 96; i++) {
      const th = (4 * Math.PI * i) / 96;
      twice.push([(3 + 0.01 * i) * Math.cos(th), (3 + 0.01 * i) * Math.sin(th), 0]);
    }
    expect(() => fitCervicalRing({ mesh, cervicalRing: ring, marginLoop: twice, insertionAxis: [0, 0, 1], emergenceOffsetMm: OFFSET_MM })).toThrow(CervicalFitError);
  });

  it('refuses a template with nothing to anchor above the blend', () => {
    const short = loftTemplate((_z, th) => [3 * Math.cos(th), 3 * Math.sin(th)], 1.5);
    expect(() =>
      fitCervicalRing({ mesh: short.mesh, cervicalRing: short.ring, marginLoop: margin, insertionAxis: [0, 0, 1], emergenceOffsetMm: OFFSET_MM }),
    ).toThrow(expect.objectContaining({ reason: 'no-anchors' }));
  });

  it('refuses a non-positive emergence offset', () => {
    expect(() => fitCervicalRing({ mesh, cervicalRing: ring, marginLoop: margin, insertionAxis: [0, 0, 1], emergenceOffsetMm: 0 })).toThrow(RangeError);
  });
});
