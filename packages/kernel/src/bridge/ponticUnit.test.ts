// packages/kernel/src/bridge/ponticUnit.test.ts
//
// Phase 9 Task 6 — `buildPonticUnit`: the closed pontic unit from a placed body
// and the per-style base. Closed-form cases first: a vertical cylinder body
// over the bridge fixture's analytic ridge, whose section on the cut surface is
// known exactly (stations ±ρ, angular extent asin(ρ / r_cut)). Then the
// invariants every style must keep (one watertight solid, the underside ON the
// configured style surface, nothing below it, the plate thickness as the
// measured wall), the relief acceptance on the as-built base, determinism, and
// the typed refusals.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildBvh } from '../bvh/index.ts';
import type { Vec3 } from '../bvh/geometry.ts';
import { analyzeMesh } from '../intake/analyze.ts';
import { orientNormalsConsistently } from '../intake/orient.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { computePseudonormals } from '../sdf/pseudonormals.ts';
import { measureWallThickness } from '../shell/shell.ts';
import { bridgeFixture } from './bridge.test-fixtures.ts';
import {
  crestSagittaBoundMm,
  measurePonticRelief,
  ponticStyleTargetField,
  type PonticBaseResolution,
  type PonticInterfaceParams,
  type PonticInterfaceStyle,
  type RidgeCrestCylinder,
} from './ponticInterface.ts';
import { buildPonticUnit, PonticUnitError, type PonticUnitParams } from './ponticUnit.ts';

const RES: PonticBaseResolution = { meshStations: 24, meshAngularSegments: 48, sampleStations: 40, sampleAngularSegments: 80 };
const UNIT: PonticUnitParams = { flangeMm: 0.2, plateThicknessMm: 1.0, seatOffsetMm: 0.3, resolution: RES };
const CREST: RidgeCrestCylinder = {
  axisPointMm: [0, 0, 1],
  mesialDistalDir: [1, 0, 0],
  buccalDir: [0, 1, 0],
  upDir: [0, 0, 1],
  radiusMm: 3,
};
const STYLE_PARAMS: Record<PonticInterfaceStyle, PonticInterfaceParams> = {
  hygienic: { clearanceMm: 2.0 },
  ridgeLap: { reliefMm: 0.05 },
  ovate: { depthMm: 1.0 },
};

/** A closed vertical capped cylinder (radius ρ, z ∈ [z0, z1]) about (cx, cy). */
function cylinder(cx: number, cy: number, rho: number, z0: number, z1: number, segments = 96): IndexedMesh {
  const positions: number[] = [];
  for (const z of [z0, z1]) {
    for (let s = 0; s < segments; s++) {
      const th = (2 * Math.PI * s) / segments;
      positions.push(cx + rho * Math.cos(th), cy + rho * Math.sin(th), z);
    }
  }
  const bottom = positions.length / 3;
  positions.push(cx, cy, z0);
  const top = positions.length / 3;
  positions.push(cx, cy, z1);
  const tris: number[] = [];
  for (let s = 0; s < segments; s++) {
    const s1 = (s + 1) % segments;
    tris.push(s, s1, segments + s1, s, segments + s1, segments + s);
    tris.push(bottom, s1, s);
    tris.push(top, segments + s, segments + s1);
  }
  const mesh = orientNormalsConsistently({ positions: Float64Array.from(positions), indices: Uint32Array.from(tris) }).mesh;
  const v = analyzeMesh(mesh).signedVolumeMm3 ?? 0;
  if (v >= 0) return mesh;
  const idx = mesh.indices.slice();
  for (let t = 0; t < idx.length; t += 3) {
    const tmp = idx[t + 1]!;
    idx[t + 1] = idx[t + 2]!;
    idx[t + 2] = tmp;
  }
  return { positions: mesh.positions, indices: idx };
}

function crestFrame(p: Vec3): { s: number; r: number; phi: number } {
  const dy = p[1] - CREST.axisPointMm[1];
  const dz = p[2] - CREST.axisPointMm[2];
  return { s: p[0] - CREST.axisPointMm[0], r: Math.hypot(dy, dz), phi: Math.atan2(dy, dz) };
}

function vertices(mesh: IndexedMesh): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < mesh.positions.length; i += 3) out.push([mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!]);
  return out;
}

/** One base-mesh chord sagitta at `radiusMm` over ±`halfSpanRad`, plus the
 * manifold-3d Float32 slack. */
function chordBound(halfSpanRad: number, radiusMm: number): number {
  return crestSagittaBoundMm(radiusMm, halfSpanRad, RES.meshAngularSegments) + 1e-5;
}

const RIDGE = bridgeFixture({ ridgeHalfLengthMm: 5, ridgeCrestSegments: 160, ridgeStations: 16 }).ridge.mesh;

describe('buildPonticUnit — hygienic, closed-form section', () => {
  const rho = 2;
  const body = cylinder(0, 0, rho, 4, 10);

  it('is one watertight solid whose underside lies on the clearance surface', async () => {
    const unit = await buildPonticUnit(body, CREST, 'hygienic', STYLE_PARAMS.hygienic, UNIT);
    const stats = analyzeMesh(unit.solid);
    expect(stats.watertight).toBe(true);
    expect(stats.componentCount).toBe(1);
    expect(unit.underside.indices.length).toBeGreaterThan(0);
    for (const p of vertices(unit.underside)) expect(Math.abs(crestFrame(p).r - 5)).toBeLessThan(1e-4);
    // The as-built base is the base MESH: chords between exact vertices, so a
    // dense base sample sits at most one chord sagitta off it.
    expect(unit.asBuiltDeviationMm).toBeLessThanOrEqual(chordBound(unit.footprint.angularHalfSpanRad, 5));
    expect(unit.discoveryRadiusMm).toBe(5);
  });

  it('takes the footprint from the body section, widened by the flange', async () => {
    const unit = await buildPonticUnit(body, CREST, 'hygienic', STYLE_PARAMS.hygienic, UNIT);
    // The vertical cylinder's extent in the plate band is widest in angle at
    // the band's bottom — the cut face, lifted 10 µm clear of the r = 5 base —
    // at stations ±ρ and angles up to asin(ρ / 5.01).
    expect(unit.footprint.stationMinMm).toBeCloseTo(-rho - UNIT.flangeMm, 3);
    expect(unit.footprint.stationMaxMm).toBeCloseTo(rho + UNIT.flangeMm, 3);
    expect(unit.footprint.angularHalfSpanRad).toBeCloseTo(Math.asin(rho / 5.01) + UNIT.flangeMm / 5, 3);
  });

  it('leaves no material between the ridge and the configured base', async () => {
    const unit = await buildPonticUnit(body, CREST, 'hygienic', STYLE_PARAMS.hygienic, UNIT);
    for (const p of vertices(unit.solid)) expect(crestFrame(p).r).toBeGreaterThan(5 - 1e-4);
  });

  it('measures the plate thickness as the thinnest wall once the rim is set aside', async () => {
    const unit = await buildPonticUnit(body, CREST, 'hygienic', STYLE_PARAMS.hygienic, UNIT);
    const thickness = measureWallThickness(unit.underside, unit.outer, { insertionAxis: [0, 0, 1] });
    expect(thickness.measured).toBe(true);
    expect(thickness.minThicknessMm).toBeGreaterThan(UNIT.plateThicknessMm - 1e-3);
    // Without the partition the closest-surface distance collapses at the rim.
    const naive = measureWallThickness(unit.underside, { positions: unit.solid.positions, indices: unit.solid.indices }, {
      insertionAxis: [0, 0, 1],
    });
    expect(naive.minThicknessMm).toBeLessThan(1e-6);
  });

  it('is deterministic', async () => {
    const a = await buildPonticUnit(body, CREST, 'hygienic', STYLE_PARAMS.hygienic, UNIT);
    const b = await buildPonticUnit(body, CREST, 'hygienic', STYLE_PARAMS.hygienic, UNIT);
    expect(Buffer.from(a.solid.positions.buffer).equals(Buffer.from(b.solid.positions.buffer))).toBe(true);
    expect(Buffer.from(a.solid.indices.buffer).equals(Buffer.from(b.solid.indices.buffer))).toBe(true);
  });
});

describe('buildPonticUnit — every style', () => {
  const body = cylinder(0, 0, 2, 4, 10);
  const pn = computePseudonormals(RIDGE);
  const bvh = buildBvh(RIDGE);

  for (const style of ['hygienic', 'ridgeLap', 'ovate'] as const) {
    it(`${style}: watertight, underside on the style surface, relief within ±20 µm on the as-built base`, async () => {
      const unit = await buildPonticUnit(body, CREST, style, STYLE_PARAMS[style], UNIT);
      const stats = analyzeMesh(unit.solid);
      expect(stats.watertight).toBe(true);
      expect(stats.componentCount).toBe(1);
      const target = ponticStyleTargetField(style, STYLE_PARAMS[style]);
      for (const p of vertices(unit.underside)) {
        const c = crestFrame(p);
        expect(Math.abs(c.r - (3 + target(c.phi)))).toBeLessThan(5e-3);
      }
      // A varying style field adds the base mesh's chord error across its
      // patch edges (the ovate seat's kink) — reported, and it stays far below
      // the ±20 µm acceptance once added to the design deviation.
      if (style === 'hygienic') expect(unit.asBuiltDeviationMm).toBeLessThanOrEqual(chordBound(unit.footprint.angularHalfSpanRad, 5));
      expect(unit.asBuiltDeviationMm).toBeLessThan(5e-3);
      const relief = measurePonticRelief(RIDGE, bvh, pn, unit.base.samples, CREST);
      expect(relief.primary.maxAbsDeviationMm + unit.asBuiltDeviationMm).toBeLessThanOrEqual(0.02);
      const thickness = measureWallThickness(unit.underside, unit.outer, { insertionAxis: [0, 0, 1] });
      expect(thickness.minThicknessMm).toBeGreaterThan(UNIT.plateThicknessMm - 1e-3);
    });
  }
});

describe('buildPonticUnit — property: any centred cylinder body', () => {
  it('keeps the invariants over body radius and height', async () => {
    await fc.assert(
      fc.asyncProperty(fc.double({ min: 1.2, max: 3, noNaN: true }), fc.double({ min: 4, max: 9, noNaN: true }), async (rho, height) => {
        const unit = await buildPonticUnit(cylinder(0, 0, rho, 4, 4 + height, 64), CREST, 'hygienic', STYLE_PARAMS.hygienic, UNIT);
        const stats = analyzeMesh(unit.solid);
        expect(stats.watertight && stats.componentCount === 1).toBe(true);
        expect(unit.asBuiltDeviationMm).toBeLessThanOrEqual(chordBound(unit.footprint.angularHalfSpanRad, 5));
        expect(unit.footprint.stationMaxMm - unit.footprint.stationMinMm).toBeGreaterThan(2 * rho);
      }),
      { numRuns: 8, seed: 20261025 },
    );
  });
});

describe('buildPonticUnit — refusals', () => {
  it('refuses a body that never reaches the base level', async () => {
    const floating = cylinder(0, 0, 2, 7, 12);
    await expect(buildPonticUnit(floating, CREST, 'hygienic', STYLE_PARAMS.hygienic, UNIT)).rejects.toThrow(PonticUnitError);
    await expect(buildPonticUnit(floating, CREST, 'hygienic', STYLE_PARAMS.hygienic, UNIT)).rejects.toMatchObject({
      reason: 'emptySection',
    });
  });

  it('refuses a non-positive construction parameter', async () => {
    const body = cylinder(0, 0, 2, 4, 10);
    await expect(buildPonticUnit(body, CREST, 'hygienic', STYLE_PARAMS.hygienic, { ...UNIT, flangeMm: 0 })).rejects.toThrow(RangeError);
    await expect(buildPonticUnit(body, CREST, 'hygienic', STYLE_PARAMS.hygienic, { ...UNIT, plateThicknessMm: -1 })).rejects.toThrow(RangeError);
  });
});
