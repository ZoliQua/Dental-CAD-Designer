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
