// packages/cad-pipeline/src/gates/marginFit.test.ts
//
// Unit tests for the margin-fit gate (marginFit.ts) — the ≤10 µm acceptance
// gate. Uses small SYNTHETIC meshes with hand-known boundaries (a square
// patch whose boundary is its own perimeter) so the measured distance is
// exactly derivable; the REAL construction-fidelity acceptance (a
// buildInnerSurface intaglio whose boundary == the margin) is measured in the
// kernel analytic test and the stage test.
import { describe, expect, it } from 'vitest';
import type { IndexedMesh, Vec3 } from '@dqcad/kernel';
import {
  marginFitGate,
  measureMarginFit,
  MarginFitInputError,
  MARGIN_FIT_GATE_THRESHOLD_MM,
  MARGIN_FIT_GATE_NAME,
  runQcGates,
} from './index.ts';

/** A unit square patch (2 triangles) — its boundary loop is the perimeter. */
function squarePatch(scale = 1): IndexedMesh {
  return {
    positions: new Float64Array([0, 0, 0, scale, 0, 0, scale, scale, 0, 0, scale, 0]),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
  };
}

/** A closed tetrahedron (no boundary). */
function tetra(): IndexedMesh {
  return {
    positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
  };
}

/** Dense sampling of the perimeter of a `scale`x`scale` square at z=0. */
function squarePerimeter(scale: number, perSide: number): Vec3[] {
  const pts: Vec3[] = [];
  const edge = (ax: number, ay: number, bx: number, by: number): void => {
    for (let i = 0; i < perSide; i++) {
      const t = i / perSide;
      pts.push([ax + (bx - ax) * t, ay + (by - ay) * t, 0]);
    }
  };
  edge(0, 0, scale, 0);
  edge(scale, 0, scale, scale);
  edge(scale, scale, 0, scale);
  edge(0, scale, 0, 0);
  return pts;
}

describe('measureMarginFit', () => {
  it('is ~0 when the margin polyline coincides with the mesh boundary', () => {
    const m = measureMarginFit(squarePatch(1), squarePerimeter(1, 20));
    expect(m.boundaryLoopCount).toBe(1);
    expect(m.maxMm).toBeLessThan(1e-9);
  });

  it('equals the offset when the margin is shifted off the boundary', () => {
    // Margin square inset by 0.05 on all sides (centred at 0.5,0.5): the
    // boundary vertices sit 0.05 outside the margin -> fit 0.05 mm.
    const inset: Vec3[] = squarePerimeter(0.9, 20).map((p) => [p[0]! + 0.05, p[1]! + 0.05, 0]);
    const m = measureMarginFit(squarePatch(1), inset);
    // The boundary's (0,0) corner is farthest from the inset square's (0.05,
    // 0.05) corner: sqrt(2)*0.05 ~= 0.0707 mm.
    expect(m.maxMm).toBeGreaterThan(0.069);
    expect(m.maxMm).toBeLessThan(0.072);
  });

  it('reports UNBOUNDED (margin->boundary = Infinity) for a closed mesh (no boundary)', () => {
    const m = measureMarginFit(tetra(), squarePerimeter(1, 8));
    expect(m.boundaryLoopCount).toBe(0);
    expect(m.marginToBoundaryMm).toBe(Number.POSITIVE_INFINITY);
    expect(m.maxMm).toBe(Number.POSITIVE_INFINITY);
  });

  it('rejects a too-short (anchor-chord-like) margin input (CHORD-CAP guard)', () => {
    expect(() => measureMarginFit(squarePatch(1), [[0, 0, 0], [1, 0, 0]] as Vec3[])).toThrow(MarginFitInputError);
  });
});

describe('marginFitGate', () => {
  it('PASSES at ~0 fit: value/threshold/unit set correctly', () => {
    const r = marginFitGate({ innerSurfaceMesh: squarePatch(1), marginResampledPoints: squarePerimeter(1, 20) });
    expect(r.gate).toBe(MARGIN_FIT_GATE_NAME);
    expect(r.passed).toBe(true);
    expect(r.acknowledged).toBe(false);
    expect(r.value).toBeLessThan(1e-9);
    expect(r.threshold).toBe(MARGIN_FIT_GATE_THRESHOLD_MM);
    expect(r.unit).toBe('mm');
  });

  it('FAILS when the fit exceeds 10 µm (value carries the measured max)', () => {
    const inset: Vec3[] = squarePerimeter(0.9, 20).map((p) => [p[0]! + 0.05, p[1]! + 0.05, 0]);
    const r = marginFitGate({ innerSurfaceMesh: squarePatch(1), marginResampledPoints: inset });
    expect(r.passed).toBe(false);
    expect(r.value).toBeGreaterThan(0.010);
  });

  it('FAILS (value null) for a closed mesh with no margin boundary', () => {
    const r = marginFitGate({ innerSurfaceMesh: tetra(), marginResampledPoints: squarePerimeter(1, 8) });
    expect(r.passed).toBe(false);
    expect(r.value).toBeNull();
    expect(r.message).toContain('UNBOUNDED');
  });

  it('is acknowledgeable-with-warning through the runner (never silently bypassed)', () => {
    const inset: Vec3[] = squarePerimeter(0.9, 20).map((p) => [p[0]! + 0.05, p[1]! + 0.05, 0]);
    const gate = () => marginFitGate({ innerSurfaceMesh: squarePatch(1), marginResampledPoints: inset });
    const report = runQcGates(null, [gate], {
      kernelVersion: 'test',
      profileVersion: 'test',
      journalHash: 'h',
      acknowledgedGates: [MARGIN_FIT_GATE_NAME],
    });
    expect(report.gates[0]!.passed).toBe(false);
    expect(report.gates[0]!.acknowledged).toBe(true);
    expect(report.passed).toBe(true); // acknowledged failure lets the report pass
  });

  it('is deterministic (same inputs -> identical value)', () => {
    const a = marginFitGate({ innerSurfaceMesh: squarePatch(1), marginResampledPoints: squarePerimeter(1, 20) });
    const b = marginFitGate({ innerSurfaceMesh: squarePatch(1), marginResampledPoints: squarePerimeter(1, 20) });
    expect(b.value).toBe(a.value);
  });
});
