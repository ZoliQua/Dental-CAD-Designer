// packages/cad-pipeline/src/gates/minWallThickness.test.ts
//
// The min-wall-thickness gate: measures the shell's thinnest wall and BLOCKS
// a design below the profile minimum (an acceptance element — the gate must
// FAIL a deliberately-thin design, never silently pass). Thresholds come from
// the profile (0.5 mm zirconia), never hardcoded in the gate.
import { describe, expect, it } from 'vitest';
import { buildInnerSurface, type IndexedMesh, type Vec3 } from '@dqcad/kernel';
import { minWallThicknessGate, measureMinWallThickness, MinWallThicknessInputError, MIN_WALL_THICKNESS_GATE_NAME } from './minWallThickness.ts';

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
  it('PASSES a shell whose walls exceed the profile minimum', async () => {
    const inner = await intaglio();
    const outer = outerDome(0.7);
    const res = minWallThicknessGate({
      innerSurfaceMesh: inner,
      outerSurfaceMesh: outer,
      minWallThicknessMm: MIN_WALL_MM,
      occlusalMinWallThicknessMm: OCCLUSAL_MIN_MM,
      insertionAxis: AXIS,
    });
    expect(res.gate).toBe(MIN_WALL_THICKNESS_GATE_NAME);
    expect(res.passed).toBe(true);
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

  it('surfaces the measurement resolution (@errorBound) in the report message', async () => {
    const inner = await intaglio();
    const outer = outerDome(0.7);
    const res = minWallThicknessGate({
      innerSurfaceMesh: inner,
      outerSurfaceMesh: outer,
      minWallThicknessMm: MIN_WALL_MM,
      occlusalMinWallThicknessMm: OCCLUSAL_MIN_MM,
      insertionAxis: AXIS,
    });
    expect(res.message).toMatch(/resolution ±/);
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
