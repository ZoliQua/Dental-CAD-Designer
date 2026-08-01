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

  // --- fold-in 3: the morph→shell heal bound is SUMMED onto each residual ------

  it('SUMS the morph→shell heal bound onto each contact residual (kernel healOuterAnatomy contract)', () => {
    // A contact 40 µm off target — comfortably within the 50 µm tolerance ALONE.
    const near: ContactResidualInput = { kind: 'antagonist', targetPenetrationMm: 0, achievedSignedDistanceMm: 0.04, contactResidualMm: 0.04, regionResidualMm: 0.04, clampBound: false };
    // Without the heal bound it PASSES (40 µm ≤ 50 µm).
    const noHeal = contactGate({ contacts: [near], contactClampWarning: false });
    expect(noHeal.passed).toBe(true);
    // A 20 µm heal shift (pitch/2) pushes the TRUE post-heal deviation to 60 µm —
    // now over tolerance. Pre-fix (bound ignored) this PASSED; the sum makes it FAIL.
    const healed = contactGate({ contacts: [near], contactClampWarning: false, outerShiftBoundMm: 0.02 });
    expect(healed.passed).toBe(false);
    expect(healed.value).toBeCloseTo(0.06, 6); // 40 µm residual + 20 µm heal shift
    expect(healed.message).toMatch(/heal shift/);
  });

  it('a zero/absent heal bound is byte-identical to the pre-heal gate (no message churn)', () => {
    const withZero = contactGate({ contacts: ALL_ON_TARGET, contactClampWarning: false, outerShiftBoundMm: 0 });
    const absent = contactGate({ contacts: ALL_ON_TARGET, contactClampWarning: false });
    expect(withZero).toEqual(absent);
    expect(absent.message).not.toMatch(/heal shift/);
  });

  it('CLAMPS a negative heal bound to 0 — a negative value can never subtract from a residual / loosen the gate', () => {
    // Pre-fix (`residual + healBound`, unclamped): a negative bound would make
    // r = 0.17 + (-5) = -4.83 ≤ tolerance → the OFF contact would PASS. The clamp
    // makes a negative bound behave exactly like 0, so the off contact still FAILS.
    const off: ContactResidualInput = { kind: 'proximalDistal', targetPenetrationMm: 0.02, achievedSignedDistanceMm: 0.15, contactResidualMm: 0.17, regionResidualMm: 0.17, clampBound: false };
    const withNegative = contactGate({ contacts: [off], contactClampWarning: false, outerShiftBoundMm: -5 });
    const withZero = contactGate({ contacts: [off], contactClampWarning: false, outerShiftBoundMm: 0 });
    expect(withNegative).toEqual(withZero);
    expect(withNegative.passed).toBe(false);
    expect(withNegative.value).toBeCloseTo(0.17, 5);
  });
});
