// packages/cad-pipeline/src/gates/seamDihedral.test.ts
//
// Phase 5 Task 4 — the seam-dihedral (G1) gate WIRING: it wraps the kernel
// `measureSeamDihedral` instrument (validated on closed-form inputs in the
// kernel's cavity/seamDihedral.test.ts) into a QcGateResult. Here we prove the
// gate's own logic on small self-contained meshes: PASSES on a G1 (coplanar)
// seam, FAILS on a large-angle (wedge) seam, FAILS on an empty seam set (never
// a silent pass), and honours a tightened threshold. (The full
// buildOcclusalPatch → gate coupling on a break-through MOD fixture is in the
// stage test.)
import { describe, it, expect } from 'vitest';
import type { IndexedMesh, Vec3, SeamEdge } from '@dqcad/kernel';
import { seamDihedralGate, SEAM_DIHEDRAL_GATE_NAME, SEAM_DIHEDRAL_GATE_THRESHOLD_DEG } from './seamDihedral.ts';

function mesh(positions: number[], indices: number[]): IndexedMesh {
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

const seamEdge = (a: Vec3, b: Vec3, segment: string): SeamEdge => ({ a, b, segment });

describe('seamDihedralGate', () => {
  // Patch (+y half, z=0) normal +Z; tooth (-y half) shares the x-axis seam edge.
  const patch = mesh([0, 0, 0, 1, 0, 0, 0.5, 1, 0], [0, 1, 2]);
  const coplanarTooth = mesh([0, 0, 0, 1, 0, 0, 0.5, -1, 0], [1, 0, 2]);
  const seam = [seamEdge([0, 0, 0], [1, 0, 0], 'buccal')];

  it('PASSES on a G1 (coplanar) seam and emits a QcGateResult', () => {
    const r = seamDihedralGate({ patchMesh: patch, toothMesh: coplanarTooth, seamEdges: seam, cavityTriangleIndices: new Set() });
    expect(r.gate).toBe(SEAM_DIHEDRAL_GATE_NAME);
    expect(r.passed).toBe(true);
    expect(r.unit).toBe('deg');
    expect(r.threshold).toBe(SEAM_DIHEDRAL_GATE_THRESHOLD_DEG);
    expect(r.value).toBe(0);
    expect(r.message).toMatch(/buccal/);
  });

  it('FAILS on a large-angle (24.775°) seam (a deliberately-unblended lid)', () => {
    const beta = (24.775 * Math.PI) / 180;
    const wedgeTooth = mesh([0, 0, 0, 1, 0, 0, 0.5, -Math.cos(beta), Math.sin(beta)], [1, 0, 2]);
    const r = seamDihedralGate({ patchMesh: patch, toothMesh: wedgeTooth, seamEdges: seam, cavityTriangleIndices: new Set() });
    expect(r.passed).toBe(false);
    expect(r.value).toBeGreaterThan(20);
    expect(r.message).toMatch(/exceeds 5/);
  });

  it('FAILS on an empty seam set (never a silent pass)', () => {
    const r = seamDihedralGate({ patchMesh: patch, toothMesh: coplanarTooth, seamEdges: [], cavityTriangleIndices: new Set() });
    expect(r.passed).toBe(false);
    expect(r.value).toBe(null);
    expect(r.message).toMatch(/UNMEASURED/);
  });

  it('accepts a Uint32Array exclusion set and honours a tightened threshold', () => {
    // 3° wedge: passes at the 5° default, fails at a 2° tightened bar.
    const beta = (3 * Math.PI) / 180;
    const wedgeTooth = mesh([0, 0, 0, 1, 0, 0, 0.5, -Math.cos(beta), Math.sin(beta)], [1, 0, 2]);
    const base = seamDihedralGate({ patchMesh: patch, toothMesh: wedgeTooth, seamEdges: seam, cavityTriangleIndices: new Uint32Array() });
    expect(base.passed).toBe(true);
    const tight = seamDihedralGate({ patchMesh: patch, toothMesh: wedgeTooth, seamEdges: seam, cavityTriangleIndices: new Uint32Array(), thresholdDeg: 2 });
    expect(tight.passed).toBe(false);
  });
});
