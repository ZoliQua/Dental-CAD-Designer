// engine/provenance.ts — the export panel's per-restoration provenance
// summary (ADR-022 Decision 6): the banner follows the restoration's inputs,
// never an unconditional "demo data" claim.
import { describe, expect, it } from 'vitest';
import type { QcGateResult, QcReport, Restoration } from '@dqcad/shared-types';
import { restorationInputProvenance } from './provenance';

function gate(name: string, extra: Partial<QcGateResult> = {}): QcGateResult {
  return {
    gate: name,
    passed: true,
    acknowledged: false,
    value: null,
    threshold: null,
    unit: null,
    message: '',
    ...extra,
  };
}

function restoration(type: Restoration['type'], gates: QcGateResult[] | null): Restoration {
  const qc: QcReport | null = gates && {
    gates,
    passed: true,
    kernelVersion: 'k',
    profileVersion: 'p',
    journalHash: 'j',
  };
  return { id: 'r1', type, teeth: [16], qc } as unknown as Restoration;
}

describe('restorationInputProvenance', () => {
  it('a crown whose QC is fully case-derived claims nothing', () => {
    expect(
      restorationInputProvenance(restoration('crown', [gate('watertight'), gate('contact')])),
    ).toEqual({
      provenance: null,
      gates: [],
    });
  });

  it('a crown with no QC report yet claims nothing (no measurement exists)', () => {
    expect(restorationInputProvenance(restoration('crown', null)).provenance).toBeNull();
  });

  it('lists the gates measured on placeholder input', () => {
    const r = restoration('onlay', [
      gate('watertight'),
      gate('cuspCoverageThickness', { passed: false, inputProvenance: 'placeholder' }),
      gate('contact', { passed: false, inputProvenance: 'placeholder' }),
    ]);
    expect(restorationInputProvenance(r)).toEqual({
      provenance: 'placeholder',
      gates: ['cuspCoverageThickness', 'contact'],
    });
  });

  it('demo-fixture outranks placeholder', () => {
    const r = restoration('crown', [
      gate('contact', { passed: false, inputProvenance: 'placeholder' }),
      gate('marginFit', { passed: false, inputProvenance: 'demo-fixture' }),
    ]);
    expect(restorationInputProvenance(r).provenance).toBe('demo-fixture');
  });

  it('a bridge is demo-fixture as a whole (the workflow runs on the 14-15-16 asset until Phase 9 Task 6)', () => {
    expect(restorationInputProvenance(restoration('bridge', [gate('watertight')]))).toEqual({
      provenance: 'demo-fixture',
      gates: [],
    });
    expect(restorationInputProvenance(restoration('bridge', null)).provenance).toBe('demo-fixture');
  });
});
