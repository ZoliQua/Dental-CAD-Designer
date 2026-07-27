// packages/cad-pipeline/src/gates/connectorCrossSection.test.ts
//
// Unit tests for the connector cross-section gate — the single-crown N/A stub
// (passes, carries the profile target, value null) and the Phase-6 bridge path
// (passing + failing connectors).
import { describe, expect, it } from 'vitest';
import {
  connectorCrossSectionGate,
  connectorPositionalTargetMm2,
  isPosteriorTooth,
  fdiPositionDigit,
  CONNECTOR_CROSS_SECTION_GATE_NAME,
} from './connectorCrossSection.ts';

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

// ---------------------------------------------------------------------------
// Phase 6 Task 4 — the FDI positional rule + the ACCEPTANCE falsifiable pair.
// ---------------------------------------------------------------------------
describe('connectorPositionalTargetMm2 — the documented FDI rule', () => {
  const TARGETS = { posteriorMm2: 9, anteriorMm2: 7 };

  it('classifies FDI position digits', () => {
    expect(fdiPositionDigit(16)).toBe(6);
    expect(fdiPositionDigit(11)).toBe(1);
    expect(isPosteriorTooth(16)).toBe(true); // first molar
    expect(isPosteriorTooth(14)).toBe(true); // first premolar
    expect(isPosteriorTooth(13)).toBe(false); // canine (anterior)
    expect(isPosteriorTooth(21)).toBe(false); // central incisor
  });

  it('posterior connector (both molars/premolars) → 9 mm²', () => {
    expect(connectorPositionalTargetMm2(14, 16, TARGETS)).toBe(9);
    expect(connectorPositionalTargetMm2(16, 15, TARGETS)).toBe(9);
  });

  it('anterior connector (both incisors/canines) → 7 mm²', () => {
    expect(connectorPositionalTargetMm2(11, 12, TARGETS)).toBe(7);
    expect(connectorPositionalTargetMm2(13, 12, TARGETS)).toBe(7);
  });

  it('boundary connector (canine ↔ premolar) → the STRICTER posterior 9 mm²', () => {
    expect(connectorPositionalTargetMm2(13, 14, TARGETS)).toBe(9);
  });
});

describe('connectorCrossSectionGate — Phase 6 ACCEPTANCE (falsifiable pair)', () => {
  it('ACCEPTANCE: a 5 mm² POSTERIOR connector BLOCKS (passed=false)', () => {
    const r = connectorCrossSectionGate({
      connectorAreaTargetMm2: 9, // posterior
      connectors: [{ label: '15–16', minAreaMm2: 5.0, teeth: [15, 16], targetMm2: 9 }],
    });
    expect(r.passed).toBe(false);
    expect(r.value).toBeCloseTo(5.0, 6);
    expect(r.threshold).toBe(9);
    expect(r.message).toMatch(/BELOW|fracture/i);
  });

  it('ACCEPTANCE: a healthy (≥ 9) posterior connector PASSES', () => {
    const r = connectorCrossSectionGate({
      connectorAreaTargetMm2: 9,
      connectors: [{ label: '15–16', minAreaMm2: 12.4, teeth: [15, 16], targetMm2: 9 }],
    });
    expect(r.passed).toBe(true);
    expect(r.value).toBeCloseTo(12.4, 6);
  });

  it('per-connector positional targets: an anterior connector at 8 mm² PASSES (7) while a posterior at 8 mm² BLOCKS (9)', () => {
    const anterior = connectorCrossSectionGate({
      connectorAreaTargetMm2: 7,
      connectors: [{ label: '12–13', minAreaMm2: 8.0, teeth: [12, 13], targetMm2: 7 }],
    });
    expect(anterior.passed).toBe(true);
    const posterior = connectorCrossSectionGate({
      connectorAreaTargetMm2: 9,
      connectors: [{ label: '15–16', minAreaMm2: 8.0, teeth: [15, 16], targetMm2: 9 }],
    });
    expect(posterior.passed).toBe(false);
  });

  it('mixed bridge: a passing posterior + a failing posterior → gate BLOCKS and names the offender', () => {
    const r = connectorCrossSectionGate({
      connectorAreaTargetMm2: 9,
      connectors: [
        { label: '14–15', minAreaMm2: 11.0, teeth: [14, 15], targetMm2: 9 },
        { label: '15–16', minAreaMm2: 5.0, teeth: [15, 16], targetMm2: 9 },
      ],
    });
    expect(r.passed).toBe(false);
    expect(r.value).toBeCloseTo(5.0, 6); // the minimum
    expect(r.message).toContain('15–16');
  });
});
