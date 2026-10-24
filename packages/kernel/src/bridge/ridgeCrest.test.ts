// packages/kernel/src/bridge/ridgeCrest.test.ts
//
// Phase 9 Task 5 — `fitRidgeCrestCylinder`: the edentulous-ridge crest fitted
// from the gingiva MESH (the real-path replacement for the fixture's analytic
// crest). Tests first: an exact cylinder patch in an arbitrary pose (closed-
// form answer), the bridge fixture's own gingiva (the fit must reproduce the
// crest the fixture was built from, and the pontic shaped on it must still
// meet the ±20 µm relief acceptance), a seeded-noise property, equivariance,
// and the typed refusals.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildBvh } from '../bvh/index.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { computePseudonormals } from '../sdf/pseudonormals.ts';
import { bridgeFixture } from './bridge.test-fixtures.ts';
import {
  measurePonticRelief,
  shapePonticBase,
  type PonticBaseFootprint,
  type PonticBaseResolution,
} from './ponticInterface.ts';
import {
  fitRidgeCrestCylinder,
  RidgeCrestDegenerateError,
  RidgeCrestOrientationError,
  RidgeCrestRegionTooSmallError,
} from './ridgeCrest.ts';

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};
/** Angle between two lines (atan2 of |a×b| and |a·b| — precise near 0,
 * unlike acos). */
const angle = (a: Vec3, b: Vec3): number => {
  const c = cross(norm(a), norm(b));
  return Math.atan2(Math.hypot(c[0], c[1], c[2]), Math.abs(dot(norm(a), norm(b))));
};

/** Distance from `p` to the line through `o` along unit `d`. */
function distToLine(p: Vec3, o: Vec3, d: Vec3): number {
  const r: Vec3 = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
  const t = dot(r, d);
  return Math.hypot(r[0] - t * d[0], r[1] - t * d[1], r[2] - t * d[2]);
}

/**
 * An open crest patch on an exact cylinder: radius `r`, axis through `origin`
 * along `md`, apex toward `up` (⟂ md), angles φ ∈ [−span, span] from the apex,
 * stations x ∈ [−halfLen, halfLen]. Outward-wound. `noise(i)` perturbs vertex
 * i radially (0 ⇒ every vertex exactly on the cylinder).
 */
function cylinderPatch(
  origin: Vec3,
  md: Vec3,
  up: Vec3,
  r: number,
  opts: {
    span?: number;
    halfLen?: number;
    stations?: number;
    segments?: number;
    noise?: (i: number) => number;
  } = {},
): IndexedMesh {
  const span = opts.span ?? (70 * Math.PI) / 180;
  const halfLen = opts.halfLen ?? 4;
  const stations = opts.stations ?? 24;
  const segments = opts.segments ?? 48;
  const buccal = cross(up, md);
  const positions: number[] = [];
  let i = 0;
  for (let s = 0; s <= stations; s++) {
    const x = -halfLen + (2 * halfLen * s) / stations;
    for (let k = 0; k <= segments; k++) {
      const phi = -span + (2 * span * k) / segments;
      const rr = r + (opts.noise ? opts.noise(i) : 0);
      const radial: Vec3 = [
        up[0] * Math.cos(phi) + buccal[0] * Math.sin(phi),
        up[1] * Math.cos(phi) + buccal[1] * Math.sin(phi),
        up[2] * Math.cos(phi) + buccal[2] * Math.sin(phi),
      ];
      positions.push(
        origin[0] + md[0] * x + radial[0] * rr,
        origin[1] + md[1] * x + radial[1] * rr,
        origin[2] + md[2] * x + radial[2] * rr,
      );
      i++;
    }
  }
  const indices: number[] = [];
  const at = (s: number, k: number): number => s * (segments + 1) + k;
  for (let s = 0; s < stations; s++) {
    for (let k = 0; k < segments; k++) {
      // Outward: md × (dφ tangent) points away from the axis.
      indices.push(
        at(s, k),
        at(s + 1, k + 1),
        at(s, k + 1),
        at(s, k),
        at(s + 1, k),
        at(s + 1, k + 1),
      );
    }
  }
  return { positions: Float64Array.from(positions), indices: Uint32Array.from(indices) };
}

/** A deterministic PRNG (mulberry32) — seeded noise, never Math.random. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MD: Vec3 = norm([0.8, 0.3, -0.2]);
const UP: Vec3 = norm(cross(cross(MD, [0.1, 0.2, 1]), MD));
const BUCCAL: Vec3 = cross(UP, MD);
const ORIGIN: Vec3 = [12.5, -7.25, 3];

describe('fitRidgeCrestCylinder — exact cylinder in an arbitrary pose (closed form)', () => {
  const mesh = cylinderPatch(ORIGIN, MD, UP, 3);
  const apex: Vec3 = [ORIGIN[0] + UP[0] * 3, ORIGIN[1] + UP[1] * 3, ORIGIN[2] + UP[2] * 3];
  const fit = fitRidgeCrestCylinder(
    mesh,
    { centerMm: apex, radiusMm: 5 },
    { upHint: UP, buccalHint: BUCCAL },
  );

  it('recovers the radius, the axis line and the frame to rounding', () => {
    expect(Math.abs(fit.crest.radiusMm - 3)).toBeLessThan(1e-9);
    expect(angle(fit.crest.mesialDistalDir, MD)).toBeLessThan(1e-9);
    expect(distToLine(fit.crest.axisPointMm, ORIGIN, MD)).toBeLessThan(1e-9);
    expect(dot(fit.crest.upDir, UP)).toBeGreaterThan(1 - 1e-12);
    expect(dot(fit.crest.buccalDir, BUCCAL)).toBeGreaterThan(1 - 1e-12);
    // Right-handed: md × buccal = up (ponticInterface's convention).
    const c = cross(fit.crest.mesialDistalDir, fit.crest.buccalDir);
    expect(dot(c, fit.crest.upDir)).toBeGreaterThan(1 - 1e-12);
  });

  it('reports a zero radial residual and a zero axis spread (@errorBound)', () => {
    expect(fit.radialResidualMaxMm).toBeLessThan(1e-9);
    expect(fit.radialResidualRmsMm).toBeLessThan(1e-9);
    expect(fit.axisSpreadRad).toBeLessThan(1e-6);
    expect(fit.vertexCount).toBeGreaterThan(100);
  });

  it('places the axis point at the region centre’s foot on the axis', () => {
    // The apex projects onto the axis at ORIGIN (station 0).
    const d: Vec3 = [
      fit.crest.axisPointMm[0] - ORIGIN[0],
      fit.crest.axisPointMm[1] - ORIGIN[1],
      fit.crest.axisPointMm[2] - ORIGIN[2],
    ];
    expect(Math.hypot(...d)).toBeLessThan(1e-9);
  });

  it('is deterministic', () => {
    const again = fitRidgeCrestCylinder(
      mesh,
      { centerMm: apex, radiusMm: 5 },
      { upHint: UP, buccalHint: BUCCAL },
    );
    expect(again).toEqual(fit);
  });
});

describe('fitRidgeCrestCylinder — the bridge fixture gingiva (reproduces its crest; pontic relief still within ±20 µm)', () => {
  const RIDGE = {
    ridgeCrestRadiusMm: 3,
    ridgeCrestCenterZMm: 1,
    ridgeHalfLengthMm: 5,
    ridgeCrestSegments: 160,
    ridgeStations: 16,
  } as const;
  const fx = bridgeFixture(RIDGE);
  const gingiva = fx.ridge.mesh;
  const fit = fitRidgeCrestCylinder(
    gingiva,
    { centerMm: [0, 0, 4], radiusMm: 4 },
    { upHint: [0, 0, 1], buccalHint: [0, 1, 0] },
  );

  it('the walls and the base are excluded; the fitted crest is the fixture’s analytic one', () => {
    expect(Math.abs(fit.crest.radiusMm - 3)).toBeLessThan(1e-9);
    expect(angle(fit.crest.mesialDistalDir, [1, 0, 0])).toBeLessThan(1e-9);
    expect(distToLine(fit.crest.axisPointMm, [0, 0, 1], [1, 0, 0])).toBeLessThan(1e-9);
    expect(fit.radialResidualMaxMm).toBeLessThan(1e-9);
  });

  it('a hygienic pontic shaped on the FITTED crest meets the ±20 µm relief acceptance against the gingiva mesh', () => {
    const footprint: PonticBaseFootprint = {
      stationMinMm: -4,
      stationMaxMm: 4,
      angularHalfSpanRad: (60 * Math.PI) / 180,
    };
    const res: PonticBaseResolution = {
      meshStations: 24,
      meshAngularSegments: 48,
      sampleStations: 40,
      sampleAngularSegments: 80,
    };
    const shaped = shapePonticBase(fit.crest, 'hygienic', { clearanceMm: 2 }, footprint, res);
    const m = measurePonticRelief(
      gingiva,
      buildBvh(gingiva),
      computePseudonormals(gingiva),
      shaped.samples,
      fit.crest,
    );
    expect(m.primary.maxAbsDeviationMm).toBeLessThanOrEqual(0.02);
  });
});

describe('fitRidgeCrestCylinder — properties', () => {
  it('seeded radial noise of amplitude a: |ΔR| ≤ a, small axis error, and the reported residual covers the noise', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2 ** 31 - 1 }),
        fc.double({ min: 0, max: 0.05, noNaN: true }),
        (seed, a) => {
          const rand = mulberry32(seed);
          const mesh = cylinderPatch(ORIGIN, MD, UP, 3, { noise: () => (2 * rand() - 1) * a });
          const apex: Vec3 = [ORIGIN[0] + UP[0] * 3, ORIGIN[1] + UP[1] * 3, ORIGIN[2] + UP[2] * 3];
          const fit = fitRidgeCrestCylinder(
            mesh,
            { centerMm: apex, radiusMm: 5 },
            { upHint: UP, buccalHint: BUCCAL },
          );
          expect(Math.abs(fit.crest.radiusMm - 3)).toBeLessThanOrEqual(a + 1e-9);
          expect(angle(fit.crest.mesialDistalDir, MD)).toBeLessThan(0.05);
          // The measured residual stays on the order of the noise (a least-squares
          // circle may shift its centre slightly, so 2a is not a strict bound).
          expect(fit.radialResidualMaxMm).toBeLessThanOrEqual(3 * a + 1e-9);
        },
      ),
      { numRuns: 30 },
    );
  });

  it('is translation-equivariant', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -400, max: 400 }),
        fc.integer({ min: -400, max: 400 }),
        fc.integer({ min: -400, max: 400 }),
        (ix, iy, iz) => {
          const t: Vec3 = [ix / 8, iy / 8, iz / 8];
          const origin: Vec3 = [ORIGIN[0] + t[0], ORIGIN[1] + t[1], ORIGIN[2] + t[2]];
          const mesh = cylinderPatch(origin, MD, UP, 3);
          const apex: Vec3 = [origin[0] + UP[0] * 3, origin[1] + UP[1] * 3, origin[2] + UP[2] * 3];
          const fit = fitRidgeCrestCylinder(
            mesh,
            { centerMm: apex, radiusMm: 5 },
            { upHint: UP, buccalHint: BUCCAL },
          );
          expect(Math.abs(fit.crest.radiusMm - 3)).toBeLessThan(1e-8);
          expect(distToLine(fit.crest.axisPointMm, origin, MD)).toBeLessThan(1e-8);
        },
      ),
      { numRuns: 20 },
    );
  });
});

describe('fitRidgeCrestCylinder — refusals', () => {
  const mesh = cylinderPatch(ORIGIN, MD, UP, 3);
  const apex: Vec3 = [ORIGIN[0] + UP[0] * 3, ORIGIN[1] + UP[1] * 3, ORIGIN[2] + UP[2] * 3];

  it('a window holding too little crest', () => {
    expect(() =>
      fitRidgeCrestCylinder(
        mesh,
        { centerMm: apex, radiusMm: 0.1 },
        { upHint: UP, buccalHint: BUCCAL },
      ),
    ).toThrow(RidgeCrestRegionTooSmallError);
  });

  it('a flat window (no curvature across the ridge ⇒ no axis)', () => {
    // A 6 × 6 flat grid in z = 0, facing up.
    const pos: number[] = [];
    const idx: number[] = [];
    for (let j = 0; j <= 5; j++) for (let i = 0; i <= 5; i++) pos.push(i, j, 0);
    for (let j = 0; j < 5; j++) {
      for (let i = 0; i < 5; i++) {
        const v = j * 6 + i;
        idx.push(v, v + 1, v + 7, v, v + 7, v + 6);
      }
    }
    const flat: IndexedMesh = { positions: Float64Array.from(pos), indices: Uint32Array.from(idx) };
    expect(() =>
      fitRidgeCrestCylinder(
        flat,
        { centerMm: [2.5, 2.5, 0], radiusMm: 10 },
        { upHint: [0, 0, 1], buccalHint: [0, 1, 0], minUpCos: 0 },
      ),
    ).toThrow(RidgeCrestDegenerateError);
  });

  it('a buccal hint along the ridge axis cannot orient the frame', () => {
    expect(() =>
      fitRidgeCrestCylinder(mesh, { centerMm: apex, radiusMm: 5 }, { upHint: UP, buccalHint: MD }),
    ).toThrow(RidgeCrestOrientationError);
  });

  it('rejects invalid options', () => {
    expect(() =>
      fitRidgeCrestCylinder(
        mesh,
        { centerMm: apex, radiusMm: -1 },
        { upHint: UP, buccalHint: BUCCAL },
      ),
    ).toThrow(RangeError);
    expect(() =>
      fitRidgeCrestCylinder(
        mesh,
        { centerMm: apex, radiusMm: 5 },
        { upHint: [0, 0, 0], buccalHint: BUCCAL },
      ),
    ).toThrow(RangeError);
  });
});
