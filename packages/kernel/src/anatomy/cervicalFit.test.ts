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
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Vec3 } from '../bvh/geometry.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { distanceToClosedPolyline } from '../offset/innerSurfaceOffset.ts';
import { DEFAULT_WALL_THICKNESS_SAMPLE_SPACING_MM } from '../shell/shell.ts';
import {
  CERVICAL_EMERGENCE_DESIGN_MARGIN_MM,
  cervicalEmergenceOffsetMm,
  CervicalFitError,
  DEFAULT_CERVICAL_BLEND_MM,
  emergenceLoop,
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

/** Closed form: where the ray from the origin (in XY) at the azimuth of
 * (x, y) crosses the closed XY polygon `loop` (heights linear along it). */
function rayHit(loop: readonly Vec3[], x: number, y: number): Vec3 {
  const len = Math.hypot(x, y);
  const ux = x / len, uy = y / len;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!, b = loop[(i + 1) % loop.length]!;
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const den = ux * ey - uy * ex;
    if (Math.abs(den) < 1e-15) continue;
    const s = (a[0] * uy - a[1] * ux) / den;
    const t = (a[0] * ey - a[1] * ex) / den;
    if (s >= -1e-12 && s <= 1 + 1e-12 && t > 0) return [a[0] + s * ex, a[1] + s * ey, a[2] + s * (b[2] - a[2])];
  }
  throw new Error('no hit');
}

const OFFSET_MM = 0.52;

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
      const expected = rayHit(target, before[0], before[1]);
      expect(Math.hypot(after[0] - expected[0], after[1] - expected[1], after[2] - expected[2])).toBeLessThan(1e-9);
      ringToLoop = Math.max(ringToLoop, distanceToClosedPolyline(after, target));
    }
    // The residual is the symmetric polyline distance, measured directly.
    let loopToRing = 0;
    const fittedRing = ring.map((v) => vertex(fit.mesh, v));
    for (const p of target) loopToRing = Math.max(loopToRing, distanceToClosedPolyline(p, fittedRing));
    expect(fit.errorBoundMm).toBeCloseTo(Math.max(ringToLoop, loopToRing), 12);
    // The fitted ring is inscribed in the emergence polygon at the ring
    // vertices' azimuths: bounded by the sagitta of its widest azimuth step
    // (the ellipse's vertices are denser in azimuth near its long axis), plus
    // the 192-gon's own sagitta (the chord ends lie on its edges).
    let maxStep = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = vertex(mesh, ring[i]!), b = vertex(mesh, ring[(i + 1) % ring.length]!);
      let d = Math.abs(Math.atan2(b[1], b[0]) - Math.atan2(a[1], a[0]));
      if (d > Math.PI) d = 2 * Math.PI - d;
      maxStep = Math.max(maxStep, d);
    }
    const r = 3 + OFFSET_MM;
    expect(fit.errorBoundMm).toBeLessThan(r * (1 - Math.cos(maxStep / 2)) + r * (1 - Math.cos(Math.PI / 192)) + 1e-9);
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
    for (const v of ring) {
      const before = vertex(mesh, v);
      const after = vertex(fit.mesh, v);
      const expected = rayHit(target, before[0], before[1]);
      expect(Math.hypot(after[0] - expected[0], after[1] - expected[1], after[2] - expected[2])).toBeLessThan(1e-9);
      // The emergence loop keeps each margin point's height: the fitted ring
      // reads the tilted plane at the margin point it came from.
      const marginY = (expected[1] * 3) / (3 + OFFSET_MM);
      expect(after[2]).toBeCloseTo(0.4 + marginY * tilt, 3);
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
