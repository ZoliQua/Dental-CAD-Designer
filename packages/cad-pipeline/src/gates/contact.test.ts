// packages/cad-pipeline/src/gates/contact.test.ts
//
// Unit tests for the contact gate — a PASSING fixture (all contacts on target,
// no clamp) and FAILING fixtures (a contact off target; a clamped contact that
// must NOT read as passing). Consumes T6-shaped residual inputs. Pure (no WASM).
import { describe, expect, it } from 'vitest';
import { contactGate, CONTACT_GATE_NAME, CONTACT_GATE_DEFAULT_TOLERANCE_MM, type ContactResidualInput } from './contact.ts';

function onTarget(kind: string): ContactResidualInput {
  return { kind, targetPenetrationMm: kind === 'antagonist' ? 0 : 0.02, achievedSignedDistanceMm: kind === 'antagonist' ? 0 : -0.02, contactResidualMm: 0.000_2, regionResidualMm: 0.000_5, clampBound: false };
}

const ALL_ON_TARGET: ContactResidualInput[] = [onTarget('proximalMesial'), onTarget('proximalDistal'), onTarget('antagonist')];

describe('contactGate', () => {
  it('PASSES when every contact is on target and none clamped', () => {
    const r = contactGate({ contacts: ALL_ON_TARGET, contactClampWarning: false });
    expect(r.gate).toBe(CONTACT_GATE_NAME);
    expect(r.passed).toBe(true);
    expect(r.value).toBeCloseTo(0.000_5, 6);
    expect(r.threshold).toBe(CONTACT_GATE_DEFAULT_TOLERANCE_MM);
  });

  it('FAILS when a contact is off target beyond tolerance', () => {
    const off: ContactResidualInput = { kind: 'proximalDistal', targetPenetrationMm: 0.02, achievedSignedDistanceMm: 0.15, contactResidualMm: 0.17, regionResidualMm: 0.17, clampBound: false };
    const r = contactGate({ contacts: [onTarget('proximalMesial'), off, onTarget('antagonist')], contactClampWarning: false });
    expect(r.passed).toBe(false);
    expect(r.value).toBeCloseTo(0.17, 5);
    expect(r.message).toMatch(/proximalDistal/);
  });

  it('FAILS on a clamped contact and NEVER silently passes it (clamp surfaced)', () => {
    // Even with a small residual, a clamped contact = target unachieved → fail.
    const clamped: ContactResidualInput = { kind: 'proximalDistal', targetPenetrationMm: 0.02, achievedSignedDistanceMm: -0.019, contactResidualMm: 0.001, regionResidualMm: 0.001, clampBound: true };
    const r = contactGate({ contacts: [onTarget('proximalMesial'), clamped, onTarget('antagonist')], contactClampWarning: true });
    expect(r.passed).toBe(false);
    expect(r.message).toMatch(/CLAMP WARNING/);
    expect(r.message).toMatch(/proximalDistal/);
  });

  it('FAIL-SAFE: no contacts supplied → unverifiable → fails', () => {
    const r = contactGate({ contacts: [], contactClampWarning: false });
    expect(r.passed).toBe(false);
    expect(r.value).toBeNull();
  });
});
