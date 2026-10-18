// packages/cad-pipeline/src/gates/provenance.test.ts
//
// ADR-022 Decision 2: a gate measured on a non-`case` input never passes. The
// shared fail-closed wrapper + the contact and cusp-coverage gates that consume
// stand-in geometry today (crown/inlay proximal boxes, the onlay coverage
// divider). Case-derived inputs must leave every result byte-identical.
import { describe, expect, it } from 'vitest';
import type { IndexedMesh, Vec3 } from '@dqcad/kernel';
import type { QcGateResult } from '@dqcad/shared-types';
import { NON_CASE_INPUT_MARKER, failClosedOnNonCaseInput, worstProvenance } from './provenance.ts';
import { contactGate, type ContactResidualInput } from './contact.ts';
import { cuspCoverageThicknessGate } from './cuspCoverageThickness.ts';

const PASSING: QcGateResult = {
  gate: 'contact',
  passed: true,
  acknowledged: false,
  value: 0.001,
  threshold: 0.05,
  unit: 'mm',
  message: 'contacts achieved',
};

describe('worstProvenance', () => {
  it('is null when every input is case-derived (absent = case)', () => {
    expect(worstProvenance([])).toBeNull();
    expect(worstProvenance([undefined, 'case'])).toBeNull();
  });
  it('demo-fixture outranks placeholder', () => {
    expect(worstProvenance(['case', 'placeholder'])).toBe('placeholder');
    expect(worstProvenance(['placeholder', 'demo-fixture', 'case'])).toBe('demo-fixture');
  });
});

describe('failClosedOnNonCaseInput', () => {
  it('turns a pass into a fail, keeps the measurement, tags the provenance and names the stand-in', () => {
    const r = failClosedOnNonCaseInput(
      PASSING,
      'placeholder',
      'synthetic proximal neighbour boxes',
    );
    expect(r.passed).toBe(false);
    expect(r.acknowledged).toBe(false);
    expect(r.value).toBe(PASSING.value);
    expect(r.threshold).toBe(PASSING.threshold);
    expect(r.inputProvenance).toBe('placeholder');
    expect(r.message.startsWith(NON_CASE_INPUT_MARKER)).toBe(true);
    expect(r.message).toContain('synthetic proximal neighbour boxes');
    expect(r.message).toContain(PASSING.message);
  });
  it('keeps an already-failing gate failing', () => {
    const r = failClosedOnNonCaseInput({ ...PASSING, passed: false }, 'demo-fixture', 'demo asset');
    expect(r.passed).toBe(false);
    expect(r.inputProvenance).toBe('demo-fixture');
  });
});

function onTarget(
  kind: string,
  provenance?: ContactResidualInput['provenance'],
): ContactResidualInput {
  return {
    kind,
    targetPenetrationMm: kind === 'antagonist' ? 0 : 0.02,
    achievedSignedDistanceMm: kind === 'antagonist' ? 0 : -0.02,
    contactResidualMm: 0.000_2,
    regionResidualMm: 0.000_5,
    clampBound: false,
    ...(provenance === undefined ? {} : { provenance }),
  };
}

describe('contactGate — provenance (ADR-022)', () => {
  it('case-derived contacts: byte-identical to the pre-provenance result (no inputProvenance key)', () => {
    const plain = contactGate({
      contacts: [onTarget('proximalMesial'), onTarget('antagonist')],
      contactClampWarning: false,
    });
    const tagged = contactGate({
      contacts: [onTarget('proximalMesial', 'case'), onTarget('antagonist', 'case')],
      contactClampWarning: false,
    });
    expect(plain.passed).toBe(true);
    expect(JSON.stringify(tagged)).toBe(JSON.stringify(plain));
    expect('inputProvenance' in plain).toBe(false);
  });

  it('a placeholder proximal contact fails closed even when on target', () => {
    const r = contactGate({
      contacts: [
        onTarget('proximalMesial', 'placeholder'),
        onTarget('proximalDistal', 'placeholder'),
        onTarget('antagonist', 'case'),
      ],
      contactClampWarning: false,
    });
    expect(r.passed).toBe(false);
    expect(r.inputProvenance).toBe('placeholder');
    expect(r.message.startsWith(NON_CASE_INPUT_MARKER)).toBe(true);
    expect(r.message).toMatch(/proximalMesial, proximalDistal/);
    expect(r.message).not.toMatch(/antagonist\]/);
    expect(r.value).toBeCloseTo(0.000_5, 6);
  });
});

function slab(z: number): IndexedMesh {
  const pos: number[] = [];
  const idx: number[] = [];
  const n = 8;
  const g = (i: number, j: number): number => i * (n + 1) + j;
  for (let i = 0; i <= n; i++)
    for (let j = 0; j <= n; j++) pos.push(-4 + (8 * i) / n, -4 + (8 * j) / n, z);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      idx.push(g(i, j), g(i + 1, j), g(i + 1, j + 1));
      idx.push(g(i, j), g(i + 1, j + 1), g(i, j + 1));
    }
  return { positions: new Float64Array(pos), indices: new Uint32Array(idx) };
}

describe('cuspCoverageThicknessGate — provenance (ADR-022)', () => {
  const base = {
    fitSurfaceMesh: slab(0),
    patchMesh: slab(1.6),
    insertionAxis: [0, 0, 1] as Vec3,
    marginResampledPoints: [
      [-4, -4, 0],
      [4, -4, 0],
      [4, 4, 0],
      [-4, 4, 0],
    ] as Vec3[],
    marginExclusionMm: 0.5,
    coverageDivider: { pointMm: [0, 0, 0] as Vec3, normalMm: [0, -1, 0] as Vec3 },
    cuspCoverageMinThicknessMm: 1.5,
  };

  it('a case-derived divider is byte-identical to an untagged one and passes', () => {
    const plain = cuspCoverageThicknessGate(base);
    const tagged = cuspCoverageThicknessGate({ ...base, dividerProvenance: 'case' });
    expect(plain.passed).toBe(true);
    expect(JSON.stringify(tagged)).toBe(JSON.stringify(plain));
  });

  it('a placeholder divider fails closed (the covered region is not the patient’s cusp)', () => {
    const r = cuspCoverageThicknessGate({ ...base, dividerProvenance: 'placeholder' });
    expect(r.passed).toBe(false);
    expect(r.inputProvenance).toBe('placeholder');
    expect(r.message).toMatch(/coverage divider/);
    expect(r.value as number).toBeCloseTo(1.6, 3);
  });
});
