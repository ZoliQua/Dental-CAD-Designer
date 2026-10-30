// packages/kernel/src/math/detMath.test.ts
//
// The deterministic transcendental functions (detMath.ts). Three claims:
//  1. accuracy — every result is within 1 ulp of the platform's `Math.*`
//     (both are faithful fdlibm-class implementations; neither is correctly
//     rounded, so they may legitimately differ by one ulp), and the
//     closed-form values are exact;
//  2. IEEE special values (NaN, ±0, ±Infinity, domain errors) follow C99
//     Annex F, as `Math.*` does;
//  3. platform independence — a pinned SHA-256 over a fixed input grid. This
//     is the claim `Math.*` itself fails: V8's C++ libm is compiled per
//     target, and its results differ in the last bit between arm64 and x64
//     (which is what made the goldens drift on Linux CI). The pin below must
//     hold on EVERY platform; a mismatch means the port is not pure IEEE
//     double arithmetic any more.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { detAcos, detAsin, detAtan, detAtan2, detCos, detExp, detPow, detSin } from './detMath.ts';

const f64 = new Float64Array(1);
const i64 = new BigInt64Array(f64.buffer);
function ordinal(x: number): bigint {
  f64[0] = x;
  const b = i64[0]!;
  return b < 0n ? -(b & 0x7fffffffffffffffn) : b;
}
/** Distance in units in the last place (adjacent doubles are 1 apart). */
function ulps(a: number, b: number): bigint {
  if (Number.isNaN(a) || Number.isNaN(b))
    return Number.isNaN(a) && Number.isNaN(b) ? 0n : 1n << 62n;
  const d = ordinal(a) - ordinal(b);
  return d < 0n ? -d : d;
}

const finite = fc.double({ noNaN: true, noDefaultInfinity: true });
const angle = fc.double({ min: -1e5, max: 1e5, noNaN: true });
const unit = fc.double({ min: -1, max: 1, noNaN: true });

describe('detMath — within 1 ulp of Math.*', () => {
  const cases: [string, (x: number) => number, (x: number) => number, fc.Arbitrary<number>][] = [
    ['sin', detSin, Math.sin, angle],
    ['cos', detCos, Math.cos, angle],
    ['atan', detAtan, Math.atan, finite],
    ['asin', detAsin, Math.asin, unit],
    ['acos', detAcos, Math.acos, unit],
    ['exp', detExp, Math.exp, fc.double({ min: -760, max: 720, noNaN: true })],
  ];
  for (const [name, det, ref, arb] of cases) {
    it(`${name}`, () => {
      fc.assert(
        fc.property(arb, (x) => ulps(det(x), ref(x)) <= 1n),
        { numRuns: 20_000, seed: 0x5eed },
      );
    });
  }
  it('atan2', () => {
    fc.assert(
      fc.property(finite, finite, (y, x) => ulps(detAtan2(y, x), Math.atan2(y, x)) <= 1n),
      { numRuns: 20_000, seed: 0x5eed },
    );
  });
  it('pow (positive base, any exponent; negative base, integer exponent)', () => {
    const base = fc.double({ min: 0, max: 1e6, noNaN: true });
    const expo = fc.double({ min: -40, max: 40, noNaN: true });
    fc.assert(
      fc.property(base, expo, (x, y) => ulps(detPow(x, y), Math.pow(x, y)) <= 1n),
      { numRuns: 20_000, seed: 0x5eed },
    );
    fc.assert(
      fc.property(
        fc.double({ min: -1e3, max: 0, noNaN: true }),
        fc.integer({ min: -60, max: 60 }),
        (x, n) => ulps(detPow(x, n), Math.pow(x, n)) <= 1n,
      ),
      { numRuns: 5_000, seed: 0x5eed },
    );
  });
  it('a dense sweep of the reduction boundaries (multiples of π/4)', () => {
    for (let k = -64; k <= 64; k++) {
      const c = (k * Math.PI) / 4;
      let x = c;
      for (let s = 0; s < 40; s++) {
        expect(ulps(detSin(x), Math.sin(x)), `sin(${x})`).toBeLessThanOrEqual(1n);
        expect(ulps(detCos(x), Math.cos(x)), `cos(${x})`).toBeLessThanOrEqual(1n);
        x = s % 2 === 0 ? c + (s + 1) * 1e-9 : c - s * 1e-9;
      }
    }
  });
});

describe('detMath — closed-form values', () => {
  it('is exact where the answer is exact', () => {
    expect(detSin(0)).toBe(0);
    expect(Object.is(detSin(-0), -0)).toBe(true);
    expect(detCos(0)).toBe(1);
    expect(detAtan(0)).toBe(0);
    expect(detAtan(1)).toBe(Math.PI / 4);
    expect(detAtan2(0, 1)).toBe(0);
    expect(detAtan2(1, 0)).toBe(Math.PI / 2);
    expect(detAtan2(0, -1)).toBe(Math.PI);
    expect(detAtan2(-0, -1)).toBe(-Math.PI);
    expect(detAtan2(1, 1)).toBe(Math.PI / 4);
    expect(detAtan2(-1, -1)).toBe((-3 * Math.PI) / 4);
    expect(detAsin(1)).toBe(Math.PI / 2);
    expect(detAcos(1)).toBe(0);
    expect(detAcos(-1)).toBe(Math.PI);
    expect(detAcos(0)).toBe(Math.PI / 2);
    expect(detExp(0)).toBe(1);
    // fdlibm's exp(1) is famously the double above e (within its < 1 ulp bound).
    expect(ulps(detExp(1), Math.E)).toBeLessThanOrEqual(1n);
    expect(detPow(2, 10)).toBe(1024);
    expect(detPow(9, 0.5)).toBe(3);
    expect(detPow(-2, 3)).toBe(-8);
    expect(detPow(2, -2)).toBe(0.25);
  });
});

describe('detMath — IEEE special values', () => {
  it('matches C99 Annex F like Math.* does', () => {
    const specials = [NaN, Infinity, -Infinity, 0, -0, 1, -1, 2, -2, 0.5, 1e-310, -1e-310, 1e308];
    for (const x of specials) {
      for (const [det, ref] of [
        [detSin, Math.sin],
        [detCos, Math.cos],
        [detAtan, Math.atan],
        [detAsin, Math.asin],
        [detAcos, Math.acos],
        [detExp, Math.exp],
      ] as const) {
        if (Math.abs(x) > 1e5 && (det === detSin || det === detCos) && Number.isFinite(x)) continue;
        expect(Object.is(det(x), ref(x)) || ulps(det(x), ref(x)) <= 1n, `${det.name}(${x})`).toBe(
          true,
        );
      }
      for (const y of specials) {
        expect(
          Object.is(detAtan2(y, x), Math.atan2(y, x)) ||
            ulps(detAtan2(y, x), Math.atan2(y, x)) <= 1n,
          `atan2(${y}, ${x})`,
        ).toBe(true);
        expect(
          Object.is(detPow(x, y), Math.pow(x, y)) || ulps(detPow(x, y), Math.pow(x, y)) <= 1n,
          `pow(${x}, ${y})`,
        ).toBe(true);
      }
    }
  });
  it('fails closed (RangeError) for a sin/cos argument beyond the medium reduction range', () => {
    expect(() => detSin(1e7)).toThrow(RangeError);
    expect(() => detCos(-1e7)).toThrow(RangeError);
  });
});

describe('detMath — platform independence', () => {
  it('a fixed input grid hashes to the pinned value on every platform', () => {
    const out: number[] = [];
    for (let i = -2000; i <= 2000; i++) {
      const x = i * 0.0123456789;
      out.push(
        detSin(x),
        detCos(x),
        detAtan(x),
        detAtan2(x, 0.7 - i * 1e-3),
        detExp(x / 40),
        detPow(Math.abs(x) + 1e-3, 0.85),
      );
      const u = i / 2000;
      out.push(detAsin(u), detAcos(u));
    }
    const hash = createHash('sha256')
      .update(Buffer.from(Float64Array.from(out).buffer))
      .digest('hex');
    expect(hash).toBe(PINNED_GRID_HASH);
  });
});

/** Recorded on darwin-arm64 AND verified identical on darwin-x64 (Rosetta). */
const PINNED_GRID_HASH = '933e3dfa2b46600cc67af05512e1030745432fcd39a331d9e11c31bc0f940718';
