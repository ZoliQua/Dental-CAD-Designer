// packages/io/src/export/narrowing.test.ts
//
// Unit tests for the f32-narrowing measurement helpers — the documented
// precision floor of the STL format (Phase 7 Task 2 deliverable 4).
// Closed-form cases first: values whose float32 ULP is known analytically.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { f32UlpAt, measureF32NarrowingError } from './narrowing.ts';

const PROPERTY_SEED = 20260718;

describe('f32UlpAt: closed-form float32 ULP values', () => {
  it('returns 2^-23 at 1.0 (|x| in [1, 2))', () => {
    expect(f32UlpAt(1)).toBe(2 ** -23);
    expect(f32UlpAt(1.5)).toBe(2 ** -23);
    expect(f32UlpAt(-1.9)).toBe(2 ** -23);
  });

  it('returns 2^-19 at 16 mm (|x| in [16, 32) — molar-scale coordinates)', () => {
    expect(f32UlpAt(16)).toBe(2 ** -19);
    expect(f32UlpAt(31.999)).toBe(2 ** -19);
  });

  it('returns 2^-16 at 128 mm (|x| in [128, 256) — full-arch-scale coordinates)', () => {
    expect(f32UlpAt(128)).toBe(2 ** -16);
  });

  it('handles zero and the subnormal range with the subnormal ULP 2^-149', () => {
    expect(f32UlpAt(0)).toBe(2 ** -149);
    expect(f32UlpAt(1e-40)).toBe(2 ** -149);
  });
});

describe('measureF32NarrowingError', () => {
  it('measures exactly zero error on float32-representable coordinates', () => {
    const report = measureF32NarrowingError(new Float64Array([-1, 0.5, 1024, 0.25, -0.75, 2]));
    expect(report.maxAbsErrorMm).toBe(0);
    expect(report.maxAbsCoordinateMm).toBe(1024);
    expect(report.maxHalfUlpBoundMm).toBeGreaterThan(0);
  });

  it('measures the exact narrowing error of 0.1 (not float32-representable)', () => {
    const report = measureF32NarrowingError(new Float64Array([0.1]));
    expect(report.maxAbsErrorMm).toBe(Math.abs(0.1 - Math.fround(0.1)));
    expect(report.maxAbsErrorMm).toBeGreaterThan(0);
    expect(report.maxAbsErrorMm).toBeLessThanOrEqual(report.maxHalfUlpBoundMm);
  });

  it('property: measured narrowing error never exceeds the documented half-ULP bound', () => {
    // The @errorBound claim itself, property-tested: for every finite
    // coordinate within float32 range, |x - fround(x)| <= ulp32(|x|) / 2.
    fc.assert(
      fc.property(
        fc.double({ noNaN: true, min: -3e38, max: 3e38 }),
        (x) => {
          const report = measureF32NarrowingError(new Float64Array([x]));
          expect(report.maxAbsErrorMm).toBeLessThanOrEqual(report.maxHalfUlpBoundMm);
          expect(report.maxAbsErrorMm).toBeLessThanOrEqual(Math.abs(x) * 2 ** -24 + 2 ** -150);
        },
      ),
      { seed: PROPERTY_SEED, numRuns: 2000 },
    );
  });
});
