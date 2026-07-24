// packages/cad-pipeline/src/gates/seating.test.ts
//
// Unit tests for the seating gate — a PASSING fixture (die clear of the crown
// walls → empty interference → 0 mm³) and a FAILING fixture (die overlapping the
// walls → nonzero interference volume). Also the fail-safe (non-watertight input
// → unverifiable → fails) and determinism. Uses the manifold-3d wrapper (WASM).
import { describe, expect, it } from 'vitest';
import type { IndexedMesh } from '@dqcad/kernel';
import { measureSeating, seatingGate, SEATING_GATE_NAME } from './seating.ts';

/** A closed, watertight axis-aligned box. */
function box(cx: number, cy: number, cz: number, s: number): IndexedMesh {
  const h = s / 2;
  const v = [
    cx - h, cy - h, cz - h, cx + h, cy - h, cz - h, cx + h, cy + h, cz - h, cx - h, cy + h, cz - h,
    cx - h, cy - h, cz + h, cx + h, cy - h, cz + h, cx + h, cy + h, cz + h, cx - h, cy + h, cz + h,
  ];
  const idx = [0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  return { positions: new Float64Array(v), indices: Uint32Array.from(idx) };
}

/** An open (non-watertight) box — the last triangle removed. */
function openBox(): IndexedMesh {
  const b = box(0, 0, 0, 1);
  return { positions: b.positions, indices: b.indices.slice(0, b.indices.length - 3) };
}

describe('measureSeating + seatingGate', () => {
  it('PASSES when the die is clear of the crown walls (empty interference → 0)', async () => {
    const crown = box(0, 0, 0, 2);
    const die = box(5, 0, 0, 1); // far away — disjoint
    const m = await measureSeating(crown, die);
    expect(m.seatable).toBe(true);
    expect(m.empty).toBe(true);
    expect(m.interferenceVolumeMm3).toBe(0);
    const r = seatingGate({ measurement: m });
    expect(r.gate).toBe(SEATING_GATE_NAME);
    expect(r.passed).toBe(true);
    expect(r.value).toBe(0);
  }, 60000);

  it('FAILS when the die overlaps the crown walls (nonzero interference)', async () => {
    const crown = box(0, 0, 0, 1);
    const die = box(0.5, 0, 0, 1); // overlaps by a 0.5×1×1 slab → 0.5 mm³
    const m = await measureSeating(crown, die);
    expect(m.seatable).toBe(true);
    expect(m.empty).toBe(false);
    expect(m.interferenceVolumeMm3).toBeCloseTo(0.5, 5);
    const r = seatingGate({ measurement: m });
    expect(r.passed).toBe(false);
    expect(r.value).toBeCloseTo(0.5, 5);
  }, 60000);

  it('a nonzero interference within an explicit tolerance PASSES (tolerance is overridable)', async () => {
    const crown = box(0, 0, 0, 1);
    const die = box(0.5, 0, 0, 1);
    const m = await measureSeating(crown, die);
    const r = seatingGate({ measurement: m, interferenceVolumeToleranceMm3: 1 });
    expect(r.passed).toBe(true);
  }, 60000);

  it('FAIL-SAFE: a non-watertight input is unverifiable → fails (never silently passes)', async () => {
    const m = await measureSeating(openBox(), box(0, 0, 0, 1));
    expect(m.seatable).toBe(false);
    expect(m.interferenceVolumeMm3).toBe(Number.POSITIVE_INFINITY);
    const r = seatingGate({ measurement: m });
    expect(r.passed).toBe(false);
    expect(r.value).toBeNull();
  }, 60000);

  it('is deterministic (same interference volume across two runs)', async () => {
    const crown = box(0, 0, 0, 1);
    const die = box(0.5, 0, 0, 1);
    const a = await measureSeating(crown, die);
    const b = await measureSeating(crown, die);
    expect(b.interferenceVolumeMm3).toBe(a.interferenceVolumeMm3);
  }, 60000);
});
