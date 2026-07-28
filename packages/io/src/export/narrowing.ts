// packages/io/src/export/narrowing.ts
//
// Float64 → Float32 narrowing measurement — the documented precision floor
// of the binary STL format (Phase 7 Task 2 deliverable 4). The kernel is
// Float64 end to end; STL's on-disk coordinates are IEEE-754 float32, so
// writing narrows every coordinate once, at the byte boundary, and that
// narrowing is the ONLY geometric error the export path introduces. These
// helpers quantify it: the analytic worst-case bound (half a float32 ULP at
// the coordinate's magnitude) and the exact measured maximum over a real
// coordinate buffer — the numbers the QC traceability document (Task 5)
// surfaces per export.

/**
 * The float32 ULP (unit in the last place) at magnitude `|x|`:
 *  - normal range (2^-126 <= |x| < 2^128): `2^(e-23)` where
 *    `e = floor(log2 |x|)` — a float32 mantissa has 23 fraction bits;
 *  - subnormal range (|x| < 2^-126, including 0): the fixed subnormal
 *    spacing `2^-149`.
 * Pure closed-form arithmetic — no environment dependence.
 */
export function f32UlpAt(x: number): number {
  const magnitude = Math.abs(x);
  if (magnitude < 2 ** -126) {
    return 2 ** -149;
  }
  const exponent = Math.min(Math.floor(Math.log2(magnitude)), 127);
  return 2 ** (exponent - 23);
}

/** What `measureF32NarrowingError` measured over a coordinate buffer. All
 * values in mm (the package-wide unit). */
export interface F32NarrowingReport {
  /** Exact measured `max |x - fround(x)|` over every coordinate. */
  maxAbsErrorMm: number;
  /** The analytic worst-case bound at the magnitudes actually present:
   * `max f32UlpAt(x) / 2` over every coordinate (equivalently, half the
   * ULP at the largest |coordinate|, since ULP is monotone in magnitude).
   * The measured max can never exceed this (round-to-nearest-even rounds
   * by at most half a ULP). */
  maxHalfUlpBoundMm: number;
  /** Largest coordinate magnitude seen — the magnitude the bound is
   * anchored at. */
  maxAbsCoordinateMm: number;
}

/**
 * Measures the exact float32-narrowing error a buffer of Float64
 * coordinates incurs when written as binary STL, alongside the analytic
 * half-ULP bound the export TSDoc documents.
 *
 * @errorBound This function measures the bound rather than introducing
 * one: for every finite `x` within float32 range,
 * `|x - fround(x)| <= f32UlpAt(x) / 2` (round-to-nearest-even), i.e.
 * relative error `<= 2^-24` in the normal range. At dental coordinate
 * scales (|x| < 256 mm) the absolute error is `< 2^-17 mm ≈ 0.0076 µm` —
 * three orders of magnitude below the 1 µm clinical display resolution.
 */
export function measureF32NarrowingError(positions: Float64Array): F32NarrowingReport {
  let maxAbsErrorMm = 0;
  let maxHalfUlpBoundMm = 0;
  let maxAbsCoordinateMm = 0;
  for (let i = 0; i < positions.length; i++) {
    const x = positions[i]!;
    const error = Math.abs(x - Math.fround(x));
    if (error > maxAbsErrorMm) maxAbsErrorMm = error;
    const halfUlp = f32UlpAt(x) / 2;
    if (halfUlp > maxHalfUlpBoundMm) maxHalfUlpBoundMm = halfUlp;
    const magnitude = Math.abs(x);
    if (magnitude > maxAbsCoordinateMm) maxAbsCoordinateMm = magnitude;
  }
  return { maxAbsErrorMm, maxHalfUlpBoundMm, maxAbsCoordinateMm };
}
