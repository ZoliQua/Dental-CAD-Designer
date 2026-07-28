// packages/cad-pipeline/src/gates/minWallThickness.test.ts
//
// The min-wall-thickness gate: measures the shell's thinnest wall and BLOCKS
// a design below the profile minimum (an acceptance element — the gate must
// FAIL a deliberately-thin design, never silently pass). Thresholds come from
// the profile (0.5 mm zirconia), never hardcoded in the gate.
import { describe, expect, it } from 'vitest';
import { buildInnerSurface, type IndexedMesh, type Vec3 } from '@dqcad/kernel';
import {
  minWallThicknessGate,
  measureMinWallThickness,
  MinWallThicknessInputError,
  MIN_WALL_THICKNESS_GATE_NAME,
  EXCLUDED_DOMINANCE_FRACTION,
} from './minWallThickness.ts';

const MARGIN_R = 1.2;
const TOP_R = 0.8;
const MARGIN_Z = 0.5;
const TOP_Z = 2.0;
const AXIS: Vec3 = [0, 0, 1];
const MIN_WALL_MM = 0.5; // standard-zirconia restorationParams.minWallThicknessMm
const OCCLUSAL_MIN_MM = 0.5; // standard-zirconia occlusalMinWallThicknessMm

function buildFrustum(mR: number, tR: number, mZ: number, tZ: number, seg: number, capTop: boolean, capBot: boolean): IndexedMesh {
  const P: number[] = [];
  const push = (x: number, y: number, z: number): number => {
    P.push(x, y, z);
    return P.length / 3 - 1;
  };
  const b: number[] = [];
  const t: number[] = [];
  for (let s = 0; s < seg; s++) {
    const th = (2 * Math.PI * s) / seg;
    b.push(push(mR * Math.cos(th), mR * Math.sin(th), mZ));
  }
  for (let s = 0; s < seg; s++) {
    const th = (2 * Math.PI * s) / seg;
    t.push(push(tR * Math.cos(th), tR * Math.sin(th), tZ));
  }
  const tr: number[] = [];
  for (let s = 0; s < seg; s++) {
    const sn = (s + 1) % seg;
    tr.push(b[s]!, b[sn]!, t[sn]!);
    tr.push(b[s]!, t[sn]!, t[s]!);
  }
  if (capBot) {
    const bc = push(0, 0, mZ);
    for (let s = 0; s < seg; s++) {
      const sn = (s + 1) % seg;
      tr.push(bc, b[sn]!, b[s]!);
    }
  }
  if (capTop) {
    const tc = push(0, 0, tZ);
    for (let s = 0; s < seg; s++) {
      const sn = (s + 1) % seg;
      tr.push(tc, t[s]!, t[sn]!);
    }
  }
  return { positions: new Float64Array(P), indices: Uint32Array.from(tr) };
}

function marginCircle(r: number, z: number, n: number): Vec3[] {
  const l: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    l.push([r * Math.cos(th), r * Math.sin(th), z]);
  }
  return l;
}

async function intaglio(): Promise<IndexedMesh> {
  const die = buildFrustum(MARGIN_R, TOP_R, MARGIN_Z, TOP_Z, 96, true, true);
  return (
    await buildInnerSurface(die, {
      pitchMm: 0.08,
      marginalGapMm: 0.02,
      cementGapMm: 0.05,
      spacerStartMm: 0.8,
      blendWidthMm: 0.3,
      marginLoop: marginCircle(MARGIN_R, MARGIN_Z, 240),
      insertionAxis: AXIS,
    })
  ).mesh;
}

const outerDome = (out: number): IndexedMesh => buildFrustum(MARGIN_R + out, TOP_R + out, MARGIN_Z, TOP_Z + out, 96, true, false);

describe('minWallThicknessGate', () => {
  it('PASSES a shell whose walls exceed the profile minimum even after the sampling margin', async () => {
    const inner = await intaglio();
    const outer = outerDome(1.0);
    const res = minWallThicknessGate({
      innerSurfaceMesh: inner,
      outerSurfaceMesh: outer,
      minWallThicknessMm: MIN_WALL_MM,
      occlusalMinWallThicknessMm: OCCLUSAL_MIN_MM,
      insertionAxis: AXIS,
    });
    expect(res.gate).toBe(MIN_WALL_THICKNESS_GATE_NAME);
    expect(res.passed).toBe(true); // measured ~950 µm, conservative ~850 µm >= 500 µm
    expect(res.value!).toBeGreaterThan(0.5);
    expect(res.threshold).toBe(0.5);
    expect(res.unit).toBe('mm');
  }, 120000);

  it('BLOCKS a deliberately-thin design (acceptance: fails, not silently passed)', async () => {
    const inner = await intaglio();
    const thin = outerDome(0.3); // 0.25-0.3 mm walls, below the 0.5 mm minimum
    const res = minWallThicknessGate({
      innerSurfaceMesh: inner,
      outerSurfaceMesh: thin,
      minWallThicknessMm: MIN_WALL_MM,
      occlusalMinWallThicknessMm: OCCLUSAL_MIN_MM,
      insertionAxis: AXIS,
    });
    expect(res.passed).toBe(false); // <-- the gate BLOCKS
    expect(res.value!).toBeLessThan(0.5);
    expect(res.threshold).toBe(0.5);
    expect(res.message).toMatch(/BELOW minimum/);
    console.log(`[gate] thin design blocked: ${res.message}`);
  }, 120000);

  it('surfaces the conservative value + sampling margin (@errorBound) in the report message', async () => {
    const inner = await intaglio();
    const outer = outerDome(1.0);
    const res = minWallThicknessGate({
      innerSurfaceMesh: inner,
      outerSurfaceMesh: outer,
      minWallThicknessMm: MIN_WALL_MM,
      occlusalMinWallThicknessMm: OCCLUSAL_MIN_MM,
      insertionAxis: AXIS,
    });
    expect(res.message).toMatch(/conservative .* sampling margin/);
  }, 120000);

  it('FAILS a wall that measures above 500 µm but is within sampling error of it (fail-safe margin)', async () => {
    const inner = await intaglio();
    // ~0.55 mm radial wall: measured min is just above 0.5 mm, but the sampling
    // margin pulls the conservative value below 0.5 -> the gate must NOT pass.
    const borderline = outerDome(0.55);
    const m = measureMinWallThickness({
      innerSurfaceMesh: inner,
      outerSurfaceMesh: borderline,
      minWallThicknessMm: MIN_WALL_MM,
      occlusalMinWallThicknessMm: OCCLUSAL_MIN_MM,
      insertionAxis: AXIS,
    });
    // If (and only if) the measured min sits within one sampling margin of the
    // threshold, the conservative comparison must block it.
    if (m.minThicknessMm >= MIN_WALL_MM && m.minThicknessMm - m.sampleSpacingMm < MIN_WALL_MM) {
      expect(m.passed).toBe(false);
      expect(m.conservativeMinThicknessMm).toBeLessThan(MIN_WALL_MM);
    }
    // Regardless, the conservative value is always measured − margin.
    expect(m.conservativeMinThicknessMm).toBeCloseTo(m.minThicknessMm - m.sampleSpacingMm, 9);
  }, 120000);

  it('does NOT weaken the threshold to pass — the same thin design fails at the fixed 0.5 mm', async () => {
    const inner = await intaglio();
    const thin = outerDome(0.3);
    const m = measureMinWallThickness({
      innerSurfaceMesh: inner,
      outerSurfaceMesh: thin,
      minWallThicknessMm: MIN_WALL_MM,
      occlusalMinWallThicknessMm: OCCLUSAL_MIN_MM,
      insertionAxis: AXIS,
    });
    expect(m.passed).toBe(false);
    expect(m.minThicknessMm).toBeLessThan(MIN_WALL_MM);
  }, 120000);

  // ---- T6-review gate hardening: disclose the excluded margin band ----------

  it('surfaces the MAX EXCLUDED THINNESS + count when the margin band excludes samples', async () => {
    const inner = await intaglio();
    const outer = outerDome(1.0);
    const res = minWallThicknessGate({
      innerSurfaceMesh: inner,
      outerSurfaceMesh: outer,
      minWallThicknessMm: MIN_WALL_MM,
      occlusalMinWallThicknessMm: OCCLUSAL_MIN_MM,
      insertionAxis: AXIS,
      marginResampledPoints: marginCircle(MARGIN_R, MARGIN_Z, 240),
      marginExclusionMm: 0.5,
    });
    const m = measureMinWallThickness({
      innerSurfaceMesh: inner,
      outerSurfaceMesh: outer,
      minWallThicknessMm: MIN_WALL_MM,
      occlusalMinWallThicknessMm: OCCLUSAL_MIN_MM,
      insertionAxis: AXIS,
      marginResampledPoints: marginCircle(MARGIN_R, MARGIN_Z, 240),
      marginExclusionMm: 0.5,
    });
    expect(m.excludedCount).toBeGreaterThan(0);
    expect(Number.isFinite(m.minExcludedThicknessMm)).toBe(true);
    // The message names the excluded count AND how thin the excluded feather got.
    expect(res.message).toMatch(/excluded \d+ sample\(s\) down to .* µm \(marginal feather\/wedge, governed by marginFit\)/);
    console.log(`[gate] excluded-band disclosure: ${res.message}`);
  }, 120000);

  it('appends NO excluded detail when nothing is excluded (byte-identical base message)', async () => {
    const inner = await intaglio();
    const outer = outerDome(1.0);
    const withNoBand = minWallThicknessGate({
      innerSurfaceMesh: inner,
      outerSurfaceMesh: outer,
      minWallThicknessMm: MIN_WALL_MM,
      occlusalMinWallThicknessMm: OCCLUSAL_MIN_MM,
      insertionAxis: AXIS,
      // no marginResampledPoints / marginExclusionMm → 0 excluded
    });
    expect(withNoBand.message).not.toMatch(/down to/);
    expect(withNoBand.message).not.toMatch(/WARNING/);
    const m = measureMinWallThickness({
      innerSurfaceMesh: inner,
      outerSurfaceMesh: outer,
      minWallThicknessMm: MIN_WALL_MM,
      occlusalMinWallThicknessMm: OCCLUSAL_MIN_MM,
      insertionAxis: AXIS,
    });
    expect(m.excludedCount).toBe(0);
    expect(m.minExcludedThicknessMm).toBe(Infinity);
    expect(m.excludedFraction).toBe(0);
  }, 120000);

  it('WARNS (in the message) when the excluded band dominates the samples (> half)', async () => {
    const inner = await intaglio();
    const outer = outerDome(1.0);
    // Sweep a range of band widths; on this small intaglio a wide band excludes
    // the majority of samples — assert the dominance warning appears iff the
    // excluded fraction actually crosses the documented threshold (never a
    // pass/fail change — the gate still judges the included samples).
    let sawDominance = false;
    for (const marginExclusionMm of [0.5, 1.0, 1.5, 2.0]) {
      const args = {
        innerSurfaceMesh: inner,
        outerSurfaceMesh: outer,
        minWallThicknessMm: MIN_WALL_MM,
        occlusalMinWallThicknessMm: OCCLUSAL_MIN_MM,
        insertionAxis: AXIS,
        marginResampledPoints: marginCircle(MARGIN_R, MARGIN_Z, 240),
        marginExclusionMm,
      };
      const m = measureMinWallThickness(args);
      const res = minWallThicknessGate(args);
      const dominates = m.excludedFraction > EXCLUDED_DOMINANCE_FRACTION;
      // The invariant: warning text is present exactly when the band dominates.
      expect(res.message.includes('dominates the measurement')).toBe(dominates);
      if (dominates) {
        sawDominance = true;
        expect(res.message).toMatch(/WARNING: excluded \d+% of samples dominates the measurement/);
        console.log(`[gate] dominance warning at band ${marginExclusionMm}mm (frac ${(m.excludedFraction * 100).toFixed(0)}%): ${res.message}`);
      }
    }
    expect(sawDominance).toBe(true);
  }, 180000);

  it('throws when a required threshold is missing/non-finite (never defaults)', async () => {
    const inner = await intaglio();
    const outer = outerDome(0.7);
    expect(() =>
      minWallThicknessGate({
        innerSurfaceMesh: inner,
        outerSurfaceMesh: outer,
        minWallThicknessMm: Number.NaN,
        occlusalMinWallThicknessMm: OCCLUSAL_MIN_MM,
        insertionAxis: AXIS,
      }),
    ).toThrow(MinWallThicknessInputError);
  }, 120000);
});

// Phase 6 Task 5 — the mode-switched thickness gate (framework vs full-contour).
describe('minWallThicknessGate — framework mode (Phase 6 Task 5)', () => {
  const FRAMEWORK_MIN_MM = 0.5; // zirconia frameworkMinThicknessMm
  // e.max-style full-contour minimums (axial 0.8 / occlusal 1.0) — used to show
  // the SAME geometry flips verdict on the mode switch.
  const FC_AXIAL = 0.8;
  const FC_OCCLUSAL = 1.0;

  it('PASSES a healthy framework unit (wall ≥ frameworkMin) and BLOCKS a thin one — the falsifiable pair', async () => {
    const inner = await intaglio();
    const healthy = minWallThicknessGate({
      innerSurfaceMesh: inner,
      outerSurfaceMesh: outerDome(0.7), // ~0.7 mm walls ≥ 0.5
      minWallThicknessMm: MIN_WALL_MM,
      occlusalMinWallThicknessMm: OCCLUSAL_MIN_MM,
      insertionAxis: AXIS,
      frameworkMode: true,
      frameworkMinThicknessMm: FRAMEWORK_MIN_MM,
    });
    const thin = minWallThicknessGate({
      innerSurfaceMesh: inner,
      outerSurfaceMesh: outerDome(0.4), // ~0.4 mm walls < 0.5
      minWallThicknessMm: MIN_WALL_MM,
      occlusalMinWallThicknessMm: OCCLUSAL_MIN_MM,
      insertionAxis: AXIS,
      frameworkMode: true,
      frameworkMinThicknessMm: FRAMEWORK_MIN_MM,
    });
    expect(healthy.passed).toBe(true);
    expect(healthy.threshold).toBe(FRAMEWORK_MIN_MM);
    expect(thin.passed).toBe(false); // <-- the framework gate BLOCKS the thin cutback
    expect(thin.threshold).toBe(FRAMEWORK_MIN_MM);
    expect(thin.message).toMatch(/BELOW minimum/);
    console.log(`[gate] framework healthy=${healthy.value?.toFixed(4)}mm PASS / thin=${thin.value?.toFixed(4)}mm BLOCK (min ${FRAMEWORK_MIN_MM}mm)`);
  }, 120000);

  it('the mode switch FLIPS the verdict on identical geometry (full-contour blocks, framework passes)', async () => {
    const inner = await intaglio();
    const outer = outerDome(0.7); // ~0.7 mm walls
    const fullContour = minWallThicknessGate({
      innerSurfaceMesh: inner,
      outerSurfaceMesh: outer,
      minWallThicknessMm: FC_AXIAL,
      occlusalMinWallThicknessMm: FC_OCCLUSAL,
      insertionAxis: AXIS,
    });
    const framework = minWallThicknessGate({
      innerSurfaceMesh: inner,
      outerSurfaceMesh: outer,
      minWallThicknessMm: FC_AXIAL,
      occlusalMinWallThicknessMm: FC_OCCLUSAL,
      insertionAxis: AXIS,
      frameworkMode: true,
      frameworkMinThicknessMm: FRAMEWORK_MIN_MM,
    });
    expect(fullContour.passed).toBe(false); // 0.7 < 0.8 axial full-contour min
    expect(framework.passed).toBe(true); // 0.7 ≥ 0.5 framework min
    expect(framework.threshold).toBe(FRAMEWORK_MIN_MM);
  }, 120000);

  it('full-contour path is BYTE-UNCHANGED (frameworkMode omitted vs explicit false)', async () => {
    const inner = await intaglio();
    const outer = outerDome(1.0);
    const base = {
      innerSurfaceMesh: inner,
      outerSurfaceMesh: outer,
      minWallThicknessMm: MIN_WALL_MM,
      occlusalMinWallThicknessMm: OCCLUSAL_MIN_MM,
      insertionAxis: AXIS,
    };
    const omitted = minWallThicknessGate(base);
    const explicitFalse = minWallThicknessGate({ ...base, frameworkMode: false });
    expect(explicitFalse).toEqual(omitted); // identical result object (message, passed, threshold, value)
  }, 120000);

  it('throws when frameworkMode is set but frameworkMinThicknessMm is missing (never defaults)', async () => {
    const inner = await intaglio();
    expect(() =>
      minWallThicknessGate({
        innerSurfaceMesh: inner,
        outerSurfaceMesh: outerDome(0.7),
        minWallThicknessMm: MIN_WALL_MM,
        occlusalMinWallThicknessMm: OCCLUSAL_MIN_MM,
        insertionAxis: AXIS,
        frameworkMode: true,
      }),
    ).toThrow(MinWallThicknessInputError);
  }, 120000);
});
