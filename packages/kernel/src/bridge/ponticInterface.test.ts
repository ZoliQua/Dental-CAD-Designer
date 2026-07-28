// packages/kernel/src/bridge/ponticInterface.test.ts
//
// Phase 6 Task 3 — the pontic gingival interface. The P5 seam-dihedral lesson
// made concrete: the MEASUREMENT INSTRUMENT is validated on closed-form offsets
// from the analytic crest cylinder BEFORE it judges any construction; then the
// per-style ±20 µm acceptance is measured + REPORTED (min/max/mean deviation),
// the relieved/non-patch regions reported SEPARATELY (never diluting the primary
// patch), and the acceptance is shown FALSIFIABLE (a raw / mis-configured base
// fails loudly).
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createHash } from 'node:crypto';
import { buildBvh } from '../bvh/index.ts';
import { computePseudonormals } from '../sdf/pseudonormals.ts';
import { signedClosestPoint } from '../sdf/signedDistance.ts';
import { bridgeFixture } from './bridge.test-fixtures.ts';
import {
  shapePonticBase,
  synthPonticSeatRing,
  measurePonticRelief,
  analyticCylinderSignedDistanceMm,
  crestSagittaBoundMm,
  PonticInterfaceParamError,
  type RidgeCrestCylinder,
  type PonticBaseSample,
  type PonticBaseFootprint,
  type PonticBaseResolution,
} from './ponticInterface.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import type { Vec3 } from '../bvh/geometry.ts';

const ACCEPTANCE_UM = 20;
const ACCEPTANCE_MM = ACCEPTANCE_UM / 1000;

// A FINE-crest ridge so the gingiva mesh's own inscribed-chord sagitta is small
// (the acceptance-fixture resolution; the fixture defaults use a coarser crest).
const RIDGE = { ridgeCrestRadiusMm: 3, ridgeCrestCenterZMm: 1, ridgeHalfLengthMm: 5, ridgeCrestSegments: 160, ridgeStations: 16 } as const;

/** The analytic crest cylinder matching the fixture's ridge. */
function fixtureCrest(): RidgeCrestCylinder {
  return {
    axisPointMm: [0, 0, RIDGE.ridgeCrestCenterZMm],
    mesialDistalDir: [1, 0, 0],
    buccalDir: [0, 1, 0],
    upDir: [0, 0, 1],
    radiusMm: RIDGE.ridgeCrestRadiusMm,
  };
}

const FOOTPRINT: PonticBaseFootprint = {
  stationMinMm: -4,
  stationMaxMm: 4,
  angularHalfSpanRad: (60 * Math.PI) / 180,
};
const RES: PonticBaseResolution = {
  meshStations: 24,
  meshAngularSegments: 48,
  sampleStations: 40,
  sampleAngularSegments: 80,
};

function hashMesh(mesh: IndexedMesh): string {
  const h = createHash('sha256');
  h.update(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  h.update(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength));
  return h.digest('hex');
}

function ridgeInstruments() {
  const fx = bridgeFixture(RIDGE);
  const gingiva = fx.ridge.mesh;
  const bvh = buildBvh(gingiva);
  const pn = computePseudonormals(gingiva);
  return { gingiva, bvh, pn };
}

// The crest mesh's WORST angular step over |φ|≤phiHalf → the sagitta bound the
// GINGIVA MESH contributes (the crest y-samples are linspace(-R,R,segs), so the
// angular step widens toward the flanks). This is the honest upper bound on how
// much larger a mesh-SDF reads than the analytic cylinder SDF over the band.
function sagittaBoundFor(radiusMm: number, phiHalf: number): number {
  const R = radiusMm;
  const segs = RIDGE.ridgeCrestSegments;
  // All crest sample angles (whole semicircle), from y = linspace(-R,R,segs).
  const angles: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const y = -R + (2 * R * i) / segs;
    const c = Math.max(-1, Math.min(1, y / R));
    angles.push(Math.asin(c)); // φ from apex toward +y
  }
  angles.sort((a, b) => a - b);
  // Max angular step over every chord (consecutive-sample pair) whose interval
  // INTERSECTS the band [-phiHalf, phiHalf] — a band sample can be nearest to a
  // chord that straddles the band edge, so those must be included.
  let maxStep = 0;
  for (let i = 1; i < angles.length; i++) {
    const lo = angles[i - 1]!;
    const hi = angles[i]!;
    if (hi >= -phiHalf && lo <= phiHalf) maxStep = Math.max(maxStep, hi - lo);
  }
  return R * (1 - Math.cos(maxStep / 2));
}
function gingivaSagittaBoundMm(phiHalf: number): number {
  return sagittaBoundFor(RIDGE.ridgeCrestRadiusMm, phiHalf);
}

// ===========================================================================
// 1. INSTRUMENT VALIDATION — validate the measurement on closed-form offsets
//    from the analytic cylinder BEFORE it judges any construction.
// ===========================================================================

describe('ponticInterface — MEASUREMENT instrument, validated closed-form FIRST', () => {
  it('signedClosestPoint reproduces a KNOWN offset from the analytic cylinder (BOUNDED by mesh sagitta), sign correct', () => {
    const { gingiva, bvh, pn } = ridgeInstruments();
    const crest = fixtureCrest();
    const phiHalf = (45 * Math.PI) / 180;
    const gingivaBound = gingivaSagittaBoundMm(phiHalf);

    // A synthetic surface at EXACT known offsets t0 from the cylinder (outside
    // AND inside), sampled over the apex band.
    for (const t0 of [1.5, 0.5, 0.05, -0.4, -1.0]) {
      let maxExcess = -Infinity;
      let minExcess = Infinity;
      let signOk = true;
      for (let i = 0; i <= 60; i++) {
        const phi = -phiHalf + (2 * phiHalf * i) / 60;
        for (const x of [-3, 0, 3]) {
          // point at radius R+t0 from the axis (exact offset t0).
          const p: Vec3 = [
            x,
            (RIDGE.ridgeCrestRadiusMm + t0) * Math.sin(phi),
            RIDGE.ridgeCrestCenterZMm + (RIDGE.ridgeCrestRadiusMm + t0) * Math.cos(phi),
          ];
          const measured = signedClosestPoint(gingiva, bvh, pn, p).signedDistance;
          const analytic = analyticCylinderSignedDistanceMm(crest, p); // == t0 exactly
          expect(Math.abs(analytic - t0)).toBeLessThan(1e-9);
          const excess = measured - t0; // mesh under-approximates the arc ⇒ excess ∈ [~0, sagitta]
          maxExcess = Math.max(maxExcess, excess);
          minExcess = Math.min(minExcess, excess);
          if (Math.sign(measured) !== Math.sign(t0)) signOk = false;
        }
      }
      // BOUNDED policy (one-sided): measured ∈ [t0 − ε, t0 + sagitta].
      expect(signOk).toBe(true);
      expect(minExcess).toBeGreaterThan(-1e-6);
      expect(maxExcess).toBeLessThanOrEqual(gingivaBound + 1e-6);
      console.log(
        `[pontic][instrument] t0=${t0} mm → measured−t0 ∈ [${(minExcess * 1000).toFixed(2)}, ${(maxExcess * 1000).toFixed(2)}] µm ` +
          `(gingiva-mesh sagitta bound ${(gingivaBound * 1000).toFixed(2)} µm)`,
      );
    }
  });

  it('analytic cylinder signed distance is EXACT for offset points (radial)', () => {
    const crest = fixtureCrest();
    for (const t0 of [-1, -0.05, 0.5, 2]) {
      for (const phi of [-1, -0.2, 0, 0.3, 1]) {
        const p: Vec3 = [
          2,
          (crest.radiusMm + t0) * Math.sin(phi),
          crest.axisPointMm[2] + (crest.radiusMm + t0) * Math.cos(phi),
        ];
        expect(analyticCylinderSignedDistanceMm(crest, p)).toBeCloseTo(t0, 12);
      }
    }
  });
});

// ===========================================================================
// 2. PER-STYLE ±20 µm ACCEPTANCE (measured + REPORTED), non-patch regions
//    reported SEPARATELY (never diluting the primary patch).
// ===========================================================================

describe('ponticInterface — per-style ±20 µm acceptance on the closed-form ridge', () => {
  it('HYGIENIC: uniform clearance == configured within ±20 µm; whole base is the patch', () => {
    const { gingiva, bvh, pn } = ridgeInstruments();
    const crest = fixtureCrest();
    const clearanceMm = 2.0; // configured (from profile in the stage); literal here (test)
    const shaped = shapePonticBase(crest, 'hygienic', { clearanceMm }, FOOTPRINT, RES);
    const m = measurePonticRelief(gingiva, bvh, pn, shaped.samples, crest);

    expect(m.primary.targetMm).toBeCloseTo(clearanceMm, 12);
    expect(m.primary.maxAbsDeviationMm).toBeLessThanOrEqual(ACCEPTANCE_MM);
    expect(Object.keys(m.secondary)).toHaveLength(0); // whole base is primary
    expect(m.analyticCrossCheckMaxGapMm!).toBeLessThanOrEqual(gingivaSagittaBoundMm(FOOTPRINT.angularHalfSpanRad) + 1e-6);
    console.log(
      `[pontic][hygienic] clearance ${clearanceMm} mm: dev min/mean/max = ` +
        `${(m.primary.minDeviationMm * 1000).toFixed(2)}/${(m.primary.meanDeviationMm * 1000).toFixed(2)}/${(m.primary.maxDeviationMm * 1000).toFixed(2)} µm ` +
        `(maxAbs ${(m.primary.maxAbsDeviationMm * 1000).toFixed(2)} µm ≤ 20); analytic gap ${(m.analyticCrossCheckMaxGapMm! * 1000).toFixed(2)} µm`,
    );
  });

  it('RIDGE-LAP: buccal contact patch == relief within ±20 µm; lingual relieved region reported SEPARATELY (larger, never diluting)', () => {
    const { gingiva, bvh, pn } = ridgeInstruments();
    const crest = fixtureCrest();
    const reliefMm = 0.05; // configured
    const shaped = shapePonticBase(crest, 'ridgeLap', { reliefMm, lingualOpeningMm: 0.5 }, FOOTPRINT, RES);
    const m = measurePonticRelief(gingiva, bvh, pn, shaped.samples, crest);

    // Primary = buccal contact patch, target = relief.
    expect(m.primary.targetMm).toBeCloseTo(reliefMm, 12);
    expect(m.primary.maxAbsDeviationMm).toBeLessThanOrEqual(ACCEPTANCE_MM);
    // The relieved (lingual) region is REPORTED SEPARATELY and is genuinely
    // OPEN (clearance strictly greater than the contact relief) — never folded
    // into the primary stat.
    expect(m.secondary.relieved).toBeDefined();
    expect(m.secondary.relieved!.minSignedMm).toBeGreaterThan(reliefMm + 0.1);
    console.log(
      `[pontic][ridgeLap] contact relief ${reliefMm} mm: dev min/mean/max = ` +
        `${(m.primary.minDeviationMm * 1000).toFixed(2)}/${(m.primary.meanDeviationMm * 1000).toFixed(2)}/${(m.primary.maxDeviationMm * 1000).toFixed(2)} µm ` +
        `(maxAbs ${(m.primary.maxAbsDeviationMm * 1000).toFixed(2)} µm ≤ 20). ` +
        `RELIEVED (lingual, separate): signed min/mean/max = ${(m.secondary.relieved!.minSignedMm).toFixed(3)}/${(m.secondary.relieved!.meanSignedMm).toFixed(3)}/${(m.secondary.relieved!.maxSignedMm).toFixed(3)} mm; ` +
        `transition n=${m.secondary.transition?.count ?? 0}`,
    );
  });

  it('OVATE: seat penetration == −depth within ±20 µm (measured NEGATIVE inside); outside-seat reported SEPARATELY', () => {
    const { gingiva, bvh, pn } = ridgeInstruments();
    const crest = fixtureCrest();
    const depthMm = 1.0; // configured
    // seat over the apex; keep the outside ramp within the footprint span.
    const shaped = shapePonticBase(
      crest,
      'ovate',
      { depthMm, seatHalfAngleRad: (18 * Math.PI) / 180, emergenceMm: 0.5 },
      FOOTPRINT,
      RES,
    );
    const m = measurePonticRelief(gingiva, bvh, pn, shaped.samples, crest);

    expect(m.primary.targetMm).toBeCloseTo(-depthMm, 12);
    expect(m.primary.maxSignedMm).toBeLessThan(0); // genuinely INSIDE the ridge
    expect(m.primary.maxAbsDeviationMm).toBeLessThanOrEqual(ACCEPTANCE_MM);
    expect(m.secondary.outside).toBeDefined();
    console.log(
      `[pontic][ovate] seat depth ${depthMm} mm: signed min/mean/max = ` +
        `${(m.primary.minSignedMm).toFixed(3)}/${(m.primary.meanSignedMm).toFixed(3)}/${(m.primary.maxSignedMm).toFixed(3)} mm; ` +
        `dev min/mean/max = ${(m.primary.minDeviationMm * 1000).toFixed(2)}/${(m.primary.meanDeviationMm * 1000).toFixed(2)}/${(m.primary.maxDeviationMm * 1000).toFixed(2)} µm ` +
        `(maxAbs ${(m.primary.maxAbsDeviationMm * 1000).toFixed(2)} µm ≤ 20). outside n=${m.secondary.outside!.count}`,
    );
  });
});

// ===========================================================================
// 3. FALSIFIABILITY — the measurement reports a violation LOUDLY.
// ===========================================================================

describe('ponticInterface — falsifiability (the acceptance CAN fail)', () => {
  it('a MIS-CONFIGURED base (wrong offset) fails the ±20 µm acceptance loudly', () => {
    const { gingiva, bvh, pn } = ridgeInstruments();
    const crest = fixtureCrest();
    // Build the base at 1.0 mm but MEASURE deviation against the intended 2.0 mm
    // clearance — the mis-configuration the instrument must catch.
    const wrong = shapePonticBase(crest, 'hygienic', { clearanceMm: 1.0 }, FOOTPRINT, RES);
    const misconfigured: PonticBaseSample[] = wrong.samples.map((s) => ({ ...s, targetMm: 2.0 }));
    const m = measurePonticRelief(gingiva, bvh, pn, misconfigured, crest);
    expect(m.primary.maxAbsDeviationMm).toBeGreaterThan(ACCEPTANCE_MM);
    expect(m.primary.maxAbsDeviationMm).toBeGreaterThan(0.9); // ~1.0 mm off
    console.log(`[pontic][falsify] mis-configured base: maxAbsDev ${(m.primary.maxAbsDeviationMm * 1000).toFixed(0)} µm ≫ 20 (FAILS, as required)`);
  });

  it('a RAW placed pontic base (unshaped library underside) fails the hygienic acceptance loudly', () => {
    const { gingiva, bvh, pn } = ridgeInstruments();
    const crest = fixtureCrest();
    // The "raw" base: samples AT the crest surface (offset 0) — the degenerate
    // stand-in for an unshaped underside sitting on the ridge; its clearance is
    // ~0, nowhere near the configured 2.0 mm.
    const raw = shapePonticBase(crest, 'hygienic', { clearanceMm: 1e-9 }, FOOTPRINT, RES);
    const asIfConfigured2: PonticBaseSample[] = raw.samples.map((s) => ({ ...s, targetMm: 2.0 }));
    const m = measurePonticRelief(gingiva, bvh, pn, asIfConfigured2, crest);
    expect(m.primary.maxAbsDeviationMm).toBeGreaterThan(ACCEPTANCE_MM);
    console.log(`[pontic][falsify] raw base (on ridge): maxAbsDev ${(m.primary.maxAbsDeviationMm * 1000).toFixed(0)} µm ≫ 20 (FAILS, as required)`);
  });
});

// ===========================================================================
// 4. DETERMINISM + fc.pre PROPERTIES.
// ===========================================================================

describe('ponticInterface — determinism + properties', () => {
  it('shapePonticBase is byte-identical across runs (deterministic)', () => {
    const crest = fixtureCrest();
    const a = shapePonticBase(crest, 'ridgeLap', { reliefMm: 0.05 }, FOOTPRINT, RES);
    const b = shapePonticBase(crest, 'ridgeLap', { reliefMm: 0.05 }, FOOTPRINT, RES);
    expect(hashMesh(a.mesh)).toBe(hashMesh(b.mesh));
    expect(a.samples.length).toBe(b.samples.length);
    for (let i = 0; i < a.samples.length; i++) {
      expect(a.samples[i]!.pointMm).toEqual(b.samples[i]!.pointMm);
      expect(a.samples[i]!.targetMm).toBe(b.samples[i]!.targetMm);
      expect(a.samples[i]!.patch).toBe(b.samples[i]!.patch);
    }
  });

  it('measurePonticRelief without a crest reports analyticCrossCheckMaxGapMm = null', () => {
    const { gingiva, bvh, pn } = ridgeInstruments();
    const crest = fixtureCrest();
    const shaped = shapePonticBase(crest, 'hygienic', { clearanceMm: 2.0 }, FOOTPRINT, RES);
    const m = measurePonticRelief(gingiva, bvh, pn, shaped.samples);
    expect(m.analyticCrossCheckMaxGapMm).toBeNull();
    expect(m.style).toBe('hygienic');
  });

  it('measurePonticRelief throws when there are no primary-patch samples', () => {
    const { gingiva, bvh, pn } = ridgeInstruments();
    expect(() => measurePonticRelief(gingiva, bvh, pn, [])).toThrow(PonticInterfaceParamError);
  });

  it('synthPonticSeatRing builds a ring on the crest apex; rejects bad radius/segments', () => {
    const crest = fixtureCrest();
    const ring = synthPonticSeatRing(crest, 0, 1.5, 32);
    expect(ring).toHaveLength(32);
    // apex over station 0 is (0,0,zc+R); ring points are radius 1.5 around it in the md/buccal plane.
    for (const p of ring) expect(Math.abs(p[2] - (RIDGE.ridgeCrestCenterZMm + RIDGE.ridgeCrestRadiusMm))).toBeLessThan(1e-9);
    expect(() => synthPonticSeatRing(crest, 0, 0, 32)).toThrow(PonticInterfaceParamError);
    expect(() => synthPonticSeatRing(crest, 0, 1.5, 2)).toThrow(PonticInterfaceParamError);
  });

  it('rejects invalid construction params (frame / radius / footprint / resolution / missing configured relief)', () => {
    const crest = fixtureCrest();
    const badFrame = { ...crest, buccalDir: [0, 2, 0] as Vec3 };
    expect(() => shapePonticBase(badFrame, 'hygienic', { clearanceMm: 2 }, FOOTPRINT, RES)).toThrow(PonticInterfaceParamError);
    expect(() => shapePonticBase({ ...crest, radiusMm: 0 }, 'hygienic', { clearanceMm: 2 }, FOOTPRINT, RES)).toThrow(PonticInterfaceParamError);
    expect(() => shapePonticBase(crest, 'hygienic', { clearanceMm: 2 }, { ...FOOTPRINT, stationMaxMm: -5 }, RES)).toThrow(PonticInterfaceParamError);
    expect(() => shapePonticBase(crest, 'hygienic', { clearanceMm: 2 }, { ...FOOTPRINT, angularHalfSpanRad: 2 }, RES)).toThrow(PonticInterfaceParamError);
    expect(() => shapePonticBase(crest, 'hygienic', { clearanceMm: 2 }, FOOTPRINT, { ...RES, meshStations: 0 })).toThrow(PonticInterfaceParamError);
    // missing/invalid configured relief per style (never defaulted).
    expect(() => shapePonticBase(crest, 'hygienic', {}, FOOTPRINT, RES)).toThrow(PonticInterfaceParamError);
    expect(() => shapePonticBase(crest, 'ridgeLap', {}, FOOTPRINT, RES)).toThrow(PonticInterfaceParamError);
    expect(() => shapePonticBase(crest, 'ridgeLap', { reliefMm: 0.05, lingualOpeningMm: -1 }, FOOTPRINT, RES)).toThrow(PonticInterfaceParamError);
    expect(() => shapePonticBase(crest, 'ridgeLap', { reliefMm: 0.05, contactTransitionHalfAngleRad: 0 }, FOOTPRINT, RES)).toThrow(PonticInterfaceParamError);
    expect(() => shapePonticBase(crest, 'ovate', {}, FOOTPRINT, RES)).toThrow(PonticInterfaceParamError);
    expect(() => shapePonticBase(crest, 'ovate', { depthMm: 1, seatHalfAngleRad: 0 }, FOOTPRINT, RES)).toThrow(PonticInterfaceParamError);
    expect(() => shapePonticBase(crest, 'ovate', { depthMm: 1, emergenceMm: -1 }, FOOTPRINT, RES)).toThrow(PonticInterfaceParamError);
  });

  it('crestSagittaBoundMm shrinks as angular resolution grows (monotone)', () => {
    let prev = Infinity;
    for (const segs of [8, 16, 32, 64, 128]) {
      const b = crestSagittaBoundMm(3, Math.PI / 3, segs);
      expect(b).toBeLessThan(prev);
      prev = b;
    }
  });

  it('PROPERTY: across ridge radii, footprints and configured clearances, HYGIENIC relief matches configured within the reported bound (fc.pre-guarded)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 2.5, max: 4.5, noNaN: true }), // crest radius
        fc.double({ min: 1.0, max: 3.0, noNaN: true }), // configured clearance
        fc.double({ min: (30 * Math.PI) / 180, max: (65 * Math.PI) / 180, noNaN: true }), // angular half-span
        (radiusMm, clearanceMm, phiHalf) => {
          fc.pre(radiusMm > 0 && clearanceMm > 0 && phiHalf > 0.4 && phiHalf < Math.PI / 2 - 0.05);
          const fx = bridgeFixture({ ...RIDGE, ridgeCrestRadiusMm: radiusMm });
          const gingiva = fx.ridge.mesh;
          const bvh = buildBvh(gingiva);
          const pn = computePseudonormals(gingiva);
          const crest: RidgeCrestCylinder = {
            axisPointMm: [0, 0, RIDGE.ridgeCrestCenterZMm],
            mesialDistalDir: [1, 0, 0],
            buccalDir: [0, 1, 0],
            upDir: [0, 0, 1],
            radiusMm,
          };
          const fp: PonticBaseFootprint = { stationMinMm: -3, stationMaxMm: 3, angularHalfSpanRad: phiHalf };
          const shaped = shapePonticBase(crest, 'hygienic', { clearanceMm }, fp, {
            meshStations: 8, meshAngularSegments: 16, sampleStations: 16, sampleAngularSegments: 40,
          });
          const m = measurePonticRelief(gingiva, bvh, pn, shaped.samples, crest);
          const bound = sagittaBoundFor(radiusMm, phiHalf) + 1e-6;
          // measured clearance is configured + [0, bound] (one-sided).
          expect(m.primary.maxDeviationMm).toBeLessThanOrEqual(bound);
          expect(m.primary.minDeviationMm).toBeGreaterThan(-1e-6);
        },
      ),
      { numRuns: 12 },
    );
  });
});
