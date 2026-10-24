// packages/cad-pipeline/src/gates/ponticRelief.test.ts
//
// Phase 6 Task 6 — the pontic-relief gate: the ±20 µm acceptance turned into a
// pass/fail, falsifiable both ways.
import { describe, it, expect } from 'vitest';
import { ponticReliefGate, PONTIC_RELIEF_GATE_NAME, PONTIC_RELIEF_GATE_THRESHOLD_MM } from './ponticRelief.ts';

describe('ponticReliefGate', () => {
  it('PASSES when the measured deviation is within ±20 µm', () => {
    const g = ponticReliefGate({ maxAbsDeviationMm: 0.00016, style: 'hygienic', configuredReliefMm: 2.0 });
    expect(g.gate).toBe(PONTIC_RELIEF_GATE_NAME);
    expect(g.passed).toBe(true);
    expect(g.value).toBeCloseTo(0.00016, 9);
    expect(g.threshold).toBe(PONTIC_RELIEF_GATE_THRESHOLD_MM);
    expect(g.unit).toBe('mm');
    expect(g.message).toContain('within ±20 µm');
  });

  it('exactly AT the threshold passes (≤, not <)', () => {
    expect(ponticReliefGate({ maxAbsDeviationMm: 0.02, style: 'ovate', configuredReliefMm: -1.0 }).passed).toBe(true);
  });

  it('BLOCKS a deviation beyond ±20 µm (falsifiable — a mis-configured base)', () => {
    const g = ponticReliefGate({ maxAbsDeviationMm: 1.0, style: 'hygienic', configuredReliefMm: 2.0 });
    expect(g.passed).toBe(false);
    expect(g.value).toBe(1.0);
    expect(g.message).toContain('DEVIATES');
  });

  it('BLOCKS a non-finite deviation (unmeasurable → fail-safe)', () => {
    const g = ponticReliefGate({ maxAbsDeviationMm: Number.POSITIVE_INFINITY, style: 'modifiedRidgeLap', configuredReliefMm: 0.05 });
    expect(g.passed).toBe(false);
    expect(g.value).toBeNull();
    expect(g.message).toContain('∞');
  });

  it('honours a per-call threshold override (tighter bar blocks a formerly-passing value)', () => {
    expect(ponticReliefGate({ maxAbsDeviationMm: 0.015, style: 'hygienic', configuredReliefMm: 2.0, thresholdMm: 0.01 }).passed).toBe(false);
  });
});

describe('ponticReliefGate — fitted crest disclosure (Phase 9 Task 5)', () => {
  it('without a crest fit the result is byte-identical to before', () => {
    const plain = ponticReliefGate({ maxAbsDeviationMm: 0.005, style: 'hygienic', configuredReliefMm: 2 });
    expect(plain.message).not.toMatch(/crest/);
  });

  it('a crest fitted from the gingiva scan is disclosed (residual + axis spread); the verdict is the measured relief alone', () => {
    const r = ponticReliefGate({
      maxAbsDeviationMm: 0.005,
      style: 'hygienic',
      configuredReliefMm: 2,
      crestFit: { radialResidualMaxMm: 0.0123, axisSpreadRad: 0.01 },
    });
    expect(r.passed).toBe(true);
    expect(r.value).toBe(0.005);
    expect(r.message).toMatch(/ridge crest fitted to the gingiva scan: max radial residual 12\.30 µm, axis spread 0\.57°/);
  });
});
