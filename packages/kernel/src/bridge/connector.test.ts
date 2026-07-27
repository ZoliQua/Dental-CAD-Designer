// packages/kernel/src/bridge/connector.test.ts
//
// Phase 6 Task 4 — the connector op. Tests are INSTRUMENT-FIRST (the P5/P6
// discipline): the area instrument is validated against closed-form analytic
// areas (constant prism exact everywhere; linear taper min closed-form) and its
// station-spacing fail-safe is made FALSIFIABLE (a waist between stations makes
// the naive sampled min OVER-report — the exact closed-form gate value catches it
// and the guaranteed lower bound never over-reports) BEFORE any acceptance claim.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createHash } from 'node:crypto';
import { analyzeMesh } from '../intake/index.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import {
  makeEllipseConnectorProfile,
  ellipseConnectorProfileAreaMm2,
  validateConnectorProfile,
  connectorProfileSignedArea,
  buildConnectorFrame,
  loftConnectorProfiles,
  connectorAreaQuadratic,
  analyticConnectorMinArea,
  measureConnectorMinArea,
  connectorAxialLengthMm,
  NonClosedProfileError,
  DegenerateProfileError,
  SelfIntersectingProfileError,
  ProfileVertexCountMismatchError,
  ProfileWindingMismatchError,
  type ConnectorProfile2D,
  type Vec2,
} from './connector.ts';

function hashMesh(mesh: IndexedMesh): string {
  const h = createHash('sha256');
  h.update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  h.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return h.digest('hex');
}

/** A circle profile (semi-axes equal) at N equal angular steps — the twist demo. */
function circleProfile(r: number, n: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    out.push([r * Math.cos(th), r * Math.sin(th)]);
  }
  return out;
}

/** Same as `circleProfile` but each vertex angularly shifted by `phi` (the
 * index-paired twist that puts a waist at t=0.5). */
function twistedCircleProfile(r: number, n: number, phi: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n + phi;
    out.push([r * Math.cos(th), r * Math.sin(th)]);
  }
  return out;
}

const AXIS: Vec3 = [1, 0, 0];
const ORIGIN: Vec3 = [0, 0, 0];

// ===========================================================================
// 1. PROFILE VALIDATION + degenerate typed errors
// ===========================================================================
describe('connector — profile validation', () => {
  it('validates a default ellipse profile; signed area matches the closed form', () => {
    const prof = makeEllipseConnectorProfile(2.2, 1.8, 64);
    const info = validateConnectorProfile(prof);
    expect(info.vertexCount).toBe(64);
    expect(info.ccw).toBe(true);
    expect(info.signedAreaMm2).toBeCloseTo(ellipseConnectorProfileAreaMm2(2.2, 1.8, 64), 10);
    expect(connectorProfileSignedArea(prof)).toBeCloseTo(info.signedAreaMm2, 12);
  });

  it('rejects a non-closed profile (< 3 vertices)', () => {
    expect(() => validateConnectorProfile([[0, 0], [1, 0]])).toThrow(NonClosedProfileError);
  });

  it('rejects a degenerate (collinear/zero-area) profile', () => {
    expect(() => validateConnectorProfile([[0, 0], [1, 0], [2, 0]])).toThrow(DegenerateProfileError);
  });

  it('rejects a self-intersecting (bowtie) profile', () => {
    // A classic bowtie: (0,0)-(1,1)-(1,0)-(0,1) has crossing edges.
    const bowtie: ConnectorProfile2D = [[0, 0], [1, 1], [1, 0], [0, 1]];
    expect(() => validateConnectorProfile(bowtie)).toThrow(SelfIntersectingProfileError);
  });
});

// ===========================================================================
// 2. THE LOFT — watertight + manifold + deterministic + typed errors
// ===========================================================================
describe('connector — loft', () => {
  it('lofts a watertight, single-component manifold solid (analyzeMesh)', () => {
    const prof = makeEllipseConnectorProfile(2.2, 1.8, 48);
    const frame = buildConnectorFrame(ORIGIN, AXIS, 4);
    const { mesh } = loftConnectorProfiles(prof, prof, frame);
    const stats = analyzeMesh(mesh);
    expect(stats.watertight).toBe(true);
    expect(stats.manifoldEdges).toBe(true);
    expect(stats.componentCount).toBe(1);
    expect(stats.boundaryEdgeCount).toBe(0);
    expect(Math.abs(stats.signedVolumeMm3!)).toBeGreaterThan(0);
  });

  it('is byte-identical across runs (deterministic)', () => {
    const prof = makeEllipseConnectorProfile(2.0, 1.6, 40);
    const frame = buildConnectorFrame(ORIGIN, AXIS, 3.5);
    const a = loftConnectorProfiles(prof, twistedCircleProfile(1.8, 40, 0.3), frame);
    const b = loftConnectorProfiles(prof, twistedCircleProfile(1.8, 40, 0.3), frame);
    expect(hashMesh(a.mesh)).toBe(hashMesh(b.mesh));
  });

  it('rejects mismatched vertex counts (index-paired correspondence)', () => {
    const frame = buildConnectorFrame(ORIGIN, AXIS, 3);
    expect(() =>
      loftConnectorProfiles(makeEllipseConnectorProfile(2, 2, 32), makeEllipseConnectorProfile(2, 2, 33), frame),
    ).toThrow(ProfileVertexCountMismatchError);
  });

  it('lofts a CONCAVE (but simple) profile watertight — exercises the ear-clip reflex handling', () => {
    // An L-shape: simple, non-self-intersecting, concave at (1,1). CCW.
    const L: ConnectorProfile2D = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]];
    expect(() => validateConnectorProfile(L)).not.toThrow();
    const frame = buildConnectorFrame(ORIGIN, AXIS, 3);
    const { mesh } = loftConnectorProfiles(L, L, frame);
    const stats = analyzeMesh(mesh);
    expect(stats.watertight).toBe(true);
    expect(stats.manifoldEdges).toBe(true);
    expect(stats.componentCount).toBe(1);
    // The L-polygon area is 3 mm² (2×2 minus the 1×1 notch) — the straight-prism min.
    const min = analyticConnectorMinArea(L, L, 3);
    expect(min.minAreaMm2).toBeCloseTo(3, 10);
  });

  it('rejects mismatched winding', () => {
    const frame = buildConnectorFrame(ORIGIN, AXIS, 3);
    const ccw = makeEllipseConnectorProfile(2, 2, 24); // CCW
    const cw = [...makeEllipseConnectorProfile(2, 2, 24)].reverse(); // CW
    expect(() => loftConnectorProfiles(ccw, cw, frame)).toThrow(ProfileWindingMismatchError);
  });
});

// ===========================================================================
// 2b. FRAME + param guards
// ===========================================================================
describe('connector — frame + guards', () => {
  it('buildConnectorFrame rejects a non-positive span', () => {
    expect(() => buildConnectorFrame(ORIGIN, AXIS, 0)).toThrow(RangeError);
    expect(() => buildConnectorFrame(ORIGIN, AXIS, -1)).toThrow(RangeError);
  });

  it('buildConnectorFrame rejects a degenerate (zero) axis', () => {
    expect(() => buildConnectorFrame(ORIGIN, [0, 0, 0], 3)).toThrow(); // DegeneratePlaneError
  });

  it('connectorAxialLengthMm echoes the span for a unit axis', () => {
    const frame = buildConnectorFrame(ORIGIN, AXIS, 4.25);
    expect(connectorAxialLengthMm(frame)).toBeCloseTo(4.25, 12);
  });

  it('measureConnectorMinArea rejects an invalid stationCount', () => {
    const prof = makeEllipseConnectorProfile(2, 2, 24);
    const frame = buildConnectorFrame(ORIGIN, AXIS, 3);
    const { mesh } = loftConnectorProfiles(prof, prof, frame);
    expect(() => measureConnectorMinArea(mesh, frame, prof, prof, { stationCount: 0 })).toThrow(RangeError);
    expect(() => measureConnectorMinArea(mesh, frame, prof, prof, { stationCount: 1.5 })).toThrow(RangeError);
  });

  it('the loft validates BOTH profiles (a non-closed second profile is rejected)', () => {
    const frame = buildConnectorFrame(ORIGIN, AXIS, 3);
    const good = makeEllipseConnectorProfile(2, 2, 3);
    expect(() => loftConnectorProfiles(good, [[0, 0], [1, 0]] as ConnectorProfile2D, frame)).toThrow(NonClosedProfileError);
  });
});

// ===========================================================================
// 3. AREA INSTRUMENT — closed-form validation FIRST
// ===========================================================================
describe('connector — area instrument (closed-form validation)', () => {
  it('CONSTANT PRISM: sampled section area is EXACT everywhere (== profile polygon area)', () => {
    const a = 2.2;
    const b = 1.8;
    const n = 64;
    const prof = makeEllipseConnectorProfile(a, b, n);
    const frame = buildConnectorFrame(ORIGIN, AXIS, 5);
    const { mesh } = loftConnectorProfiles(prof, prof, frame);
    const polyArea = ellipseConnectorProfileAreaMm2(a, b, n);
    const result = measureConnectorMinArea(mesh, frame, prof, prof, { stationCount: 32 });
    // Closed-form min == the constant polygon area (a=b=0, c=polyArea).
    expect(result.analytic.quadratic.a).toBeCloseTo(0, 12);
    expect(result.analytic.quadratic.b).toBeCloseTo(0, 12);
    expect(result.minAreaMm2).toBeCloseTo(polyArea, 10);
    // Every sampled mesh section equals the polygon area (no wall-diagonal bow).
    for (const area of result.sampled.areasMm2) expect(area).toBeCloseTo(polyArea, 9);
    expect(result.sampledVsAnalyticMaxAbsMm2).toBeLessThan(1e-9);
  });

  it('LINEAR TAPER: analytic min is at the small end, closed-form k²·areaA', () => {
    const n = 64;
    const k = 0.6; // profileB = k·profileA (a smaller similar ellipse)
    const profA = makeEllipseConnectorProfile(2.4, 1.9, n);
    const profB: Vec2[] = profA.map((p) => [p[0] * k, p[1] * k]);
    const areaA = ellipseConnectorProfileAreaMm2(2.4, 1.9, n);
    const frame = buildConnectorFrame(ORIGIN, AXIS, 4);
    const { mesh } = loftConnectorProfiles(profA, profB, frame);
    const result = measureConnectorMinArea(mesh, frame, profA, profB, { stationCount: 40 });
    // A(t) = ((1-t)+t·k)²·areaA, decreasing on [0,1] (k<1) ⇒ min at t=1 = k²·areaA.
    expect(result.analytic.atT).toBeCloseTo(1, 6);
    expect(result.analytic.minAreaMm2).toBeCloseTo(k * k * areaA, 8); // exact closed form
    // The fail-safe gate value is at/just below the exact min (never above).
    expect(result.minAreaMm2).toBeLessThanOrEqual(result.analytic.minAreaMm2 + 1e-9);
    expect(result.minAreaMm2).toBeGreaterThan(k * k * areaA - 0.05);
    // Sampled mesh agrees within a small tessellation term.
    expect(result.sampledVsAnalyticMaxAbsMm2).toBeLessThan(0.01);
  });

  it('quadratic coefficients match the twist closed form (waist at t=0.5)', () => {
    const r = 2.0;
    const n = 64;
    const phi = (40 * Math.PI) / 180;
    const profA = circleProfile(r, n);
    const profB = twistedCircleProfile(r, n, phi);
    const p = ellipseConnectorProfileAreaMm2(r, r, n); // circle polygon area
    const q = connectorAreaQuadratic(profA, profB);
    // A(t) = p·[1 − 2(1−cosφ)(t − t²)]  ⇒ a = 2p(1−cosφ), b = −2p(1−cosφ), c = p.
    const twoP = 2 * p * (1 - Math.cos(phi));
    expect(q.c).toBeCloseTo(p, 8);
    expect(q.a).toBeCloseTo(twoP, 8);
    expect(q.b).toBeCloseTo(-twoP, 8);
    const min = analyticConnectorMinArea(profA, profB, 4);
    expect(min.atT).toBeCloseTo(0.5, 8);
    expect(min.minAreaMm2).toBeCloseTo(p * Math.cos(phi / 2) * Math.cos(phi / 2), 8);
  });
});

// ===========================================================================
// 4. THE STATION-SPACING FAIL-SAFE — falsifiable
// ===========================================================================
describe('connector — station-spacing fail-safe (falsifiable)', () => {
  it('a waist BETWEEN stations makes the naive sampled min OVER-report; the guaranteed bound never over-reports', () => {
    const r = 2.0;
    const n = 64;
    const phi = (45 * Math.PI) / 180; // a real waist (the twisted ruled solid bows inward)
    const profA = circleProfile(r, n);
    const profB = twistedCircleProfile(r, n, phi);
    const frame = buildConnectorFrame(ORIGIN, AXIS, 4);
    const { mesh } = loftConnectorProfiles(profA, profB, frame);
    // DENSE measurement = the ground-truth minimum cross-section of the real solid.
    const dense = measureConnectorMinArea(mesh, frame, profA, profB, { stationCount: 400 });
    const trueMin = dense.sampled.minAreaMm2; // the real triangulated waist
    // COARSE: stationCount = 2 ⇒ interior stations at t = 1/3, 2/3 — NEITHER lands
    // on the t=0.5 waist; the caps (t=0/1) are the wide ends.
    const coarse = measureConnectorMinArea(mesh, frame, profA, profB, { stationCount: 2 });
    // (a) the NAIVE coarse sampled min MISSES the waist → OVER-reports (reads larger).
    expect(coarse.sampled.minAreaMm2).toBeGreaterThan(trueMin + 0.05);
    // (b) the guaranteed lower bound NEVER over-reports (≤ the real solid's min).
    expect(coarse.sampled.guaranteedLowerBoundMm2).toBeLessThanOrEqual(trueMin + 1e-6);
    expect(coarse.minAreaMm2).toBeLessThanOrEqual(trueMin + 1e-6); // the gate value is that bound
    // (c) the exact closed-form ideal-ring min locates the waist at t≈0.5.
    expect(coarse.analytic.atT).toBeCloseTo(0.5, 6);
    console.log(
      `[connector fail-safe] realWaist(dense)=${trueMin.toFixed(4)} coarseSampledMin(naive)=${coarse.sampled.minAreaMm2.toFixed(4)} ` +
        `coarseMargin=${coarse.sampled.stationMarginMm2.toFixed(4)} coarseGuaranteed=${coarse.sampled.guaranteedLowerBoundMm2.toFixed(4)} ` +
        `idealMin(analytic@t=${coarse.analytic.atT.toFixed(3)})=${coarse.analytic.minAreaMm2.toFixed(4)}`,
    );
  });

  it('with DENSE stations the raw sampled min IS the real solid min and the margin → small', () => {
    const r = 2.0;
    const n = 64;
    const phi = (45 * Math.PI) / 180;
    const profA = circleProfile(r, n);
    const profB = twistedCircleProfile(r, n, phi);
    const frame = buildConnectorFrame(ORIGIN, AXIS, 4);
    const { mesh } = loftConnectorProfiles(profA, profB, frame);
    const result = measureConnectorMinArea(mesh, frame, profA, profB, { stationCount: 200 });
    // The real triangulated waist is BELOW the ideal ruled-ring min (inward bow) —
    // an honest reason the gate uses the mesh-based bound, not the ideal analytic.
    expect(result.sampled.minAreaMm2).toBeLessThan(result.analytic.minAreaMm2);
    expect(result.sampled.stationMarginMm2).toBeLessThan(0.02);
    expect(result.minAreaMm2).toBeLessThanOrEqual(result.sampled.minAreaMm2);
  });
});

// ===========================================================================
// 5. LIVE-READOUT timing
// ===========================================================================
describe('connector — live-readout timing', () => {
  it('measures a realistic connector well under 100 ms (interactive)', () => {
    const profA = makeEllipseConnectorProfile(2.2, 1.8, 64);
    const profB = makeEllipseConnectorProfile(2.0, 1.6, 64);
    const frame = buildConnectorFrame(ORIGIN, AXIS, 4);
    const { mesh } = loftConnectorProfiles(profA, profB, frame);
    const t0 = performance.now();
    const iters = 20;
    for (let i = 0; i < iters; i++) measureConnectorMinArea(mesh, frame, profA, profB, { stationCount: 63 });
    const perCall = (performance.now() - t0) / iters;
    console.log(`[connector live-readout] ${perCall.toFixed(2)} ms/measurement (63 stations, 64-gon profiles)`);
    expect(perCall).toBeLessThan(100);
  });
});

// ===========================================================================
// 6. PROPERTY — random straight prisms are watertight & area-exact (fc.pre)
// ===========================================================================
describe('connector — property', () => {
  it('PROPERTY: a straight elliptical prism is watertight and its closed-form min == the polygon area', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1.0, max: 3.0, noNaN: true }),
        fc.double({ min: 1.0, max: 3.0, noNaN: true }),
        fc.double({ min: 2.0, max: 6.0, noNaN: true }),
        (a, b, span) => {
          fc.pre(a > 0 && b > 0 && span > 0);
          const n = 48;
          const prof = makeEllipseConnectorProfile(a, b, n);
          const frame = buildConnectorFrame(ORIGIN, AXIS, span);
          const { mesh } = loftConnectorProfiles(prof, prof, frame);
          const stats = analyzeMesh(mesh);
          expect(stats.watertight).toBe(true);
          expect(stats.componentCount).toBe(1);
          const min = analyticConnectorMinArea(prof, prof, span);
          expect(min.minAreaMm2).toBeCloseTo(ellipseConnectorProfileAreaMm2(a, b, n), 8);
        },
      ),
      { numRuns: 25 },
    );
  });
});
