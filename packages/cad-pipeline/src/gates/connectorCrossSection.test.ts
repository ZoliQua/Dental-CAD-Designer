// packages/cad-pipeline/src/gates/connectorCrossSection.test.ts
//
// Unit tests for the connector cross-section gate — the single-crown N/A stub
// (passes, carries the profile target, value null) and the Phase-6 bridge path
// (passing + failing connectors).
import { describe, expect, it } from 'vitest';
import { connectorCrossSectionGate, CONNECTOR_CROSS_SECTION_GATE_NAME } from './connectorCrossSection.ts';

describe('connectorCrossSectionGate', () => {
  it('single crown → N/A PASS, carries the profile target, value null', () => {
    const r = connectorCrossSectionGate({ connectorAreaTargetMm2: 7 });
    expect(r.gate).toBe(CONNECTOR_CROSS_SECTION_GATE_NAME);
    expect(r.passed).toBe(true);
    expect(r.value).toBeNull();
    expect(r.threshold).toBe(7);
    expect(r.message).toMatch(/N\/A|Phase 6/i);
  });

  it('Phase 6 bridge — PASSES when every connector ≥ target', () => {
    const r = connectorCrossSectionGate({
      connectorAreaTargetMm2: 7,
      connectors: [{ label: '21-22', minAreaMm2: 8.1 }, { label: '22-23', minAreaMm2: 9.4 }],
    });
    expect(r.passed).toBe(true);
    expect(r.value).toBeCloseTo(8.1, 5);
  });

  it('Phase 6 bridge — FAILS when a connector is below target', () => {
    const r = connectorCrossSectionGate({
      connectorAreaTargetMm2: 9,
      connectors: [{ label: '21-22', minAreaMm2: 6.2 }],
    });
    expect(r.passed).toBe(false);
    expect(r.value).toBeCloseTo(6.2, 5);
    expect(r.message).toMatch(/BELOW|fracture/i);
  });
});
