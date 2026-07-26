// packages/cad-pipeline/src/gates/cuspCoverageThickness.test.ts
//
// Phase 5 Task 7 — the ONLAY covered-cusp region-scoped min-wall gate. A simple
// analytic slab pair (inner + outer planes) with a known covered-cusp half-space
// gives a closed-form region-scoped thickness; the gate passes/blocks exactly at
// the profile minimum and never counts body-side samples.
import { describe, it, expect } from 'vitest';
import type { IndexedMesh, Vec3 } from '@dqcad/kernel';
import { cuspCoverageThicknessGate, measureCuspCoverageThickness, CUSP_COVERAGE_THICKNESS_GATE_NAME } from './cuspCoverageThickness.ts';

// A flat inner slab at z=0 and a flat outer slab at z=T over a square, split at
// y=0: the covered-cusp side is y<=0. Both slabs span x,y in [-4,4].
function slab(z: number): IndexedMesh {
  const pos: number[] = [];
  const idx: number[] = [];
  const n = 8; // grid
  const g = (i: number, j: number): number => i * (n + 1) + j;
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) pos.push(-4 + (8 * i) / n, -4 + (8 * j) / n, z);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { idx.push(g(i, j), g(i + 1, j), g(i + 1, j + 1)); idx.push(g(i, j), g(i + 1, j + 1), g(i, j + 1)); }
  return { positions: new Float64Array(pos), indices: new Uint32Array(idx) };
}

const AXIS: Vec3 = [0, 0, 1];
// coverage = y <= 0 : (p - point)·normal >= 0 with normal (0,-1,0), point (0,0,0)
const DIVIDER = { pointMm: [0, 0, 0] as Vec3, normalMm: [0, -1, 0] as Vec3 };
const OUTLINE: Vec3[] = [[-4, -4, 0], [4, -4, 0], [4, 4, 0], [-4, 4, 0]];

describe('cuspCoverageThicknessGate', () => {
  it('measures the covered-cusp (y<=0) wall thickness = the slab gap', () => {
    const inner = slab(0), outer = slab(1.6);
    const m = measureCuspCoverageThickness({
      fitSurfaceMesh: inner, patchMesh: outer, insertionAxis: AXIS,
      marginResampledPoints: OUTLINE, marginExclusionMm: 0.5, coverageDivider: DIVIDER, cuspCoverageMinThicknessMm: 1.5,
    });
    expect(m.minCoverageThicknessMm).toBeCloseTo(1.6, 3);
    expect(m.coverageSampleCount).toBeGreaterThan(0);
    expect(m.passed).toBe(true); // 1.6 - spacing >= 1.5
  });

  it('BLOCKS when the covered-cusp gap is below the minimum (falsifiable)', () => {
    const inner = slab(0), outer = slab(1.2);
    const g = cuspCoverageThicknessGate({
      fitSurfaceMesh: inner, patchMesh: outer, insertionAxis: AXIS,
      marginResampledPoints: OUTLINE, marginExclusionMm: 0.5, coverageDivider: DIVIDER, cuspCoverageMinThicknessMm: 1.5,
    });
    expect(g.gate).toBe(CUSP_COVERAGE_THICKNESS_GATE_NAME);
    expect(g.passed).toBe(false);
    expect(g.value as number).toBeCloseTo(1.2, 3);
    expect(g.threshold).toBe(1.5);
  });

  it('ignores body-side samples — a thin BODY (well away from the divider) does not fail the coverage gate', () => {
    // outer at 2.0 everywhere except a thin (0.9) BODY patch at y>2 (far from the
    // y=0 divider, so it never becomes the nearest point of a coverage sample).
    const inner = slab(0);
    const pos: number[] = [], idx: number[] = [];
    const n = 8; const gi = (i: number, j: number): number => i * (n + 1) + j;
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) { const y = -4 + (8 * j) / n; pos.push(-4 + (8 * i) / n, y, y > 2 ? 0.9 : 2.0); }
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { idx.push(gi(i, j), gi(i + 1, j), gi(i + 1, j + 1)); idx.push(gi(i, j), gi(i + 1, j + 1), gi(i, j + 1)); }
    const outer: IndexedMesh = { positions: new Float64Array(pos), indices: new Uint32Array(idx) };
    const g = cuspCoverageThicknessGate({
      fitSurfaceMesh: inner, patchMesh: outer, insertionAxis: AXIS,
      marginResampledPoints: OUTLINE, marginExclusionMm: 0.5, coverageDivider: DIVIDER, cuspCoverageMinThicknessMm: 1.5,
    });
    expect(g.passed).toBe(true); // coverage side is 2.0mm; the 0.9 body side is not counted
  });

  it('throws on a non-finite / non-positive minimum (profile must resolve it)', () => {
    const inner = slab(0), outer = slab(1.6);
    expect(() => measureCuspCoverageThickness({
      fitSurfaceMesh: inner, patchMesh: outer, insertionAxis: AXIS,
      marginResampledPoints: OUTLINE, marginExclusionMm: 0.5, coverageDivider: DIVIDER, cuspCoverageMinThicknessMm: Number.NaN,
    })).toThrow(TypeError);
  });
});
