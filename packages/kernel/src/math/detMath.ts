// packages/kernel/src/math/detMath.ts
//
// Deterministic transcendental functions — a pure-TypeScript port of the
// FreeBSD msun (fdlibm 5.3) implementations of sin, cos, atan, atan2, asin,
// acos, exp and pow.
//
// Why: the kernel's determinism invariant (CLAUDE.md, hard invariant 2) is
// "same inputs + params + kernel version ⇒ bit-identical outputs". `Math.sin`
// and friends do not honour it across platforms: ECMAScript leaves their
// results implementation-approximated, and V8 computes them with a C++ libm
// compiled per target. The same Node version returns results that differ in
// the last bit on darwin-arm64 and linux-x64 (the compiler fuses
// multiply-adds on one target and not the other). Every golden hash that
// went through a sine drifted on Linux CI for that reason, and a server
// re-validating on another architecture than the client's browser could not
// reproduce the client's bits.
//
// ECMAScript's `+ - * /` and `Math.sqrt` ARE exactly specified (IEEE 754
// binary64, round to nearest even, no contraction), and so are the
// typed-array bit views used here — so this port returns the same bits on
// every conforming engine. Kernel, io, cad-pipeline and tooth-library code
// call these instead of `Math.*` (lint-enforced); `Math.sqrt`, `Math.hypot`,
// `Math.abs`, `Math.floor` etc. stay (exact or pure-double by spec/V8).
//
// @errorBound fdlibm's: every function < 1 ulp from the exact value (sin/cos
// ≤ 0.5 ulp + the kernel polynomial's 2^-58 relative error; pow < 0.77 ulp
// near overflow, < 0.5 ulp + ε elsewhere). Tested within 1 ulp of `Math.*`.
//
// Range: `detSin`/`detCos` reduce |x| ≤ 2^20·π/2 (≈ 1.6e6 rad) with fdlibm's
// three-step Cody–Waite reduction (exact to 151 bits); beyond that they throw
// a RangeError rather than port the Payne–Hanek large-argument path no kernel
// angle needs (fail-closed, never a silent wrong answer).

const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);
if (new Uint8Array(Float64Array.of(1).buffer)[7] !== 0x3f) {
  throw new Error('detMath: a little-endian platform is required for the double word views');
}

/** The high 32 bits of `x` as a signed int32 (fdlibm's GET_HIGH_WORD). */
function hiWord(x: number): number {
  F64[0] = x;
  return U32[1]! | 0;
}
/** The low 32 bits of `x` as an unsigned int (GET_LOW_WORD). */
function loWord(x: number): number {
  F64[0] = x;
  return U32[0]!;
}
/** INSERT_WORDS. */
function fromWords(hi: number, lo: number): number {
  U32[1] = hi >>> 0;
  U32[0] = lo >>> 0;
  return F64[0]!;
}
/** SET_LOW_WORD(x, 0): `x` with the low 32 bits cleared. */
function clearLow(x: number): number {
  F64[0] = x;
  U32[0] = 0;
  return F64[0]!;
}
/** SET_HIGH_WORD. */
function withHigh(x: number, hi: number): number {
  F64[0] = x;
  U32[1] = hi >>> 0;
  return F64[0]!;
}

// ── sin / cos ──────────────────────────────────────────────────────────

const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;

/** __kernel_sin on [-π/4, π/4]; `y` is the tail of x, `iy` 0 when y is 0. */
function kernelSin(x: number, y: number, iy: number): number {
  const z = x * x;
  const w = z * z;
  const r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6);
  const v = z * x;
  if (iy === 0) return x + v * (S1 + z * r);
  return x - (z * (0.5 * y - v * r) - y - v * S1);
}

const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.0875723212981748279e-9;
const C6 = -1.13596475577881948265e-11;

/** __kernel_cos on [-π/4, π/4]. */
function kernelCos(x: number, y: number): number {
  const z = x * x;
  let w = z * z;
  const r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6));
  const hz = 0.5 * z;
  w = 1 - hz;
  return w + (1 - w - hz + (z * r - x * y));
}

const INV_PIO2 = 6.36619772367581382433e-1;
const PIO2_1 = 1.57079632673412561417;
const PIO2_1T = 6.07710050650619224932e-11;
const PIO2_2 = 6.0771005063039659766e-11;
const PIO2_2T = 2.02226624879595063154e-21;
const PIO2_3 = 2.0222662487111664558e-21;
const PIO2_3T = 8.47842766036889956997e-32;
/** 1.5·2^52: adding and subtracting it rounds to the nearest integer (even). */
const TO_INT = 6755399441055744;

/** The reduced argument: x = n·π/2 + (y0 + y1), |y0 + y1| ≤ π/4. */
const REM: [number, number] = [0, 0];

/** __ieee754_rem_pio2 for |x| < 2^20·π/2 (the medium path, plus fdlibm's
 * shortcuts for |x| ≤ 9π/4). Writes REM, returns n. */
function remPio2(x: number): number {
  const hx = hiWord(x);
  const ix = hx & 0x7fffffff;
  if (ix <= 0x400f6a7a) {
    // |x| ≲ 5π/4
    if ((ix & 0xfffff) !== 0x921fb) {
      // not |x| ≈ π/2 or 2π/2 (those need the careful medium path)
      const k = ix <= 0x4002d97c ? 1 : 2; // |x| ≲ 3π/4 : 5π/4
      if (hx > 0) {
        const z = x - k * PIO2_1;
        REM[0] = z - k * PIO2_1T;
        REM[1] = z - REM[0] - k * PIO2_1T;
        return k;
      }
      const z = x + k * PIO2_1;
      REM[0] = z + k * PIO2_1T;
      REM[1] = z - REM[0] + k * PIO2_1T;
      return -k;
    }
  } else if (ix <= 0x401c463b) {
    // |x| ≲ 9π/4
    const k = ix <= 0x4015fdbc ? 3 : 4; // |x| ≲ 7π/4 : 9π/4
    if (!(k === 3 && ix === 0x4012d97c) && !(k === 4 && ix === 0x401921fb)) {
      // not |x| ≈ 3π/2 or 4π/2
      if (hx > 0) {
        const z = x - k * PIO2_1;
        REM[0] = z - k * PIO2_1T;
        REM[1] = z - REM[0] - k * PIO2_1T;
        return k;
      }
      const z = x + k * PIO2_1;
      REM[0] = z + k * PIO2_1T;
      REM[1] = z - REM[0] + k * PIO2_1T;
      return -k;
    }
  } else if (ix >= 0x413921fb) {
    throw new RangeError(
      `detMath: |x| = ${Math.abs(x)} is beyond the 2^20·π/2 sin/cos reduction range`,
    );
  }
  // medium: |x| < 2^20·π/2
  const fn = x * INV_PIO2 + TO_INT - TO_INT;
  const n = fn | 0;
  let r = x - fn * PIO2_1;
  let w = fn * PIO2_1T; // first round, good to 85 bits
  const j = ix >> 20;
  REM[0] = r - w;
  let i = j - ((hiWord(REM[0]) >> 20) & 0x7ff);
  if (i > 16) {
    // second iteration, good to 118 bits
    let t = r;
    w = fn * PIO2_2;
    r = t - w;
    w = fn * PIO2_2T - (t - r - w);
    REM[0] = r - w;
    i = j - ((hiWord(REM[0]) >> 20) & 0x7ff);
    if (i > 49) {
      // third iteration, 151 bits: covers every case
      t = r;
      w = fn * PIO2_3;
      r = t - w;
      w = fn * PIO2_3T - (t - r - w);
      REM[0] = r - w;
    }
  }
  REM[1] = r - REM[0] - w;
  return n;
}

/** sin(x), deterministic on every platform. */
export function detSin(x: number): number {
  const ix = hiWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) {
    // |x| ≲ π/4
    if (ix < 0x3e500000) return x; // |x| < 2^-26
    return kernelSin(x, 0, 0);
  }
  if (ix >= 0x7ff00000) return NaN; // ±Infinity or NaN
  const n = remPio2(x);
  switch (n & 3) {
    case 0:
      return kernelSin(REM[0], REM[1], 1);
    case 1:
      return kernelCos(REM[0], REM[1]);
    case 2:
      return -kernelSin(REM[0], REM[1], 1);
    default:
      return -kernelCos(REM[0], REM[1]);
  }
}

/** cos(x), deterministic on every platform. */
export function detCos(x: number): number {
  const ix = hiWord(x) & 0x7fffffff;
  if (ix <= 0x3fe921fb) {
    // |x| ≲ π/4
    if (ix < 0x3e46a09e) return 1; // |x| < 2^-27·√2
    return kernelCos(x, 0);
  }
  if (ix >= 0x7ff00000) return NaN;
  const n = remPio2(x);
  switch (n & 3) {
    case 0:
      return kernelCos(REM[0], REM[1]);
    case 1:
      return -kernelSin(REM[0], REM[1], 1);
    case 2:
      return -kernelCos(REM[0], REM[1]);
    default:
      return kernelSin(REM[0], REM[1], 1);
  }
}

// ── atan / atan2 ───────────────────────────────────────────────────────

const ATAN_HI = [
  4.63647609000806093515e-1, 7.85398163397448278999e-1, 9.82793723247329054082e-1,
  1.570796326794896558,
];
const ATAN_LO = [
  2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17,
  6.12323399573676603587e-17,
];
const AT0 = 3.33333333333329318027e-1;
const AT1 = -1.99999999998764832476e-1;
const AT2 = 1.42857142725034663711e-1;
const AT3 = -1.1111110405462355788e-1;
const AT4 = 9.09088713343650656196e-2;
const AT5 = -7.69187620504482999495e-2;
const AT6 = 6.66107313738753120669e-2;
const AT7 = -5.83357013379057348645e-2;
const AT8 = 4.97687799461593236017e-2;
const AT9 = -3.6531572744216915527e-2;
const AT10 = 1.62858201153657823623e-2;

/** atan(x), deterministic on every platform. */
export function detAtan(x: number): number {
  const hx = hiWord(x);
  const ix = hx & 0x7fffffff;
  let id: number;
  if (ix >= 0x44100000) {
    // |x| ≥ 2^66 (or NaN/Infinity)
    if (x !== x) return x + x;
    return hx > 0 ? ATAN_HI[3]! + ATAN_LO[3]! : -ATAN_HI[3]! - ATAN_LO[3]!;
  }
  if (ix < 0x3fdc0000) {
    // |x| < 0.4375
    if (ix < 0x3e400000) return x; // |x| < 2^-27
    id = -1;
  } else {
    x = Math.abs(x);
    if (ix < 0x3ff30000) {
      // |x| < 1.1875
      if (ix < 0x3fe60000) {
        id = 0; // 7/16 ≤ |x| < 11/16
        x = (2 * x - 1) / (2 + x);
      } else {
        id = 1; // 11/16 ≤ |x| < 19/16
        x = (x - 1) / (x + 1);
      }
    } else if (ix < 0x40038000) {
      id = 2; // |x| < 2.4375
      x = (x - 1.5) / (1 + 1.5 * x);
    } else {
      id = 3; // 2.4375 ≤ |x| < 2^66
      x = -1 / x;
    }
  }
  const z = x * x;
  const w = z * z;
  const s1 = z * (AT0 + w * (AT2 + w * (AT4 + w * (AT6 + w * (AT8 + w * AT10)))));
  const s2 = w * (AT1 + w * (AT3 + w * (AT5 + w * (AT7 + w * AT9))));
  if (id < 0) return x - x * (s1 + s2);
  const r = ATAN_HI[id]! - (x * (s1 + s2) - ATAN_LO[id]! - x);
  return hx < 0 ? -r : r;
}

const PI = 3.141592653589793116;
const PI_LO = 1.2246467991473532e-16; // 0x3CA1A626, 0x33145C07
const PI_O_2 = 1.570796326794896558;
const PI_O_4 = 7.85398163397448279e-1;

/** atan2(y, x), deterministic on every platform. */
export function detAtan2(y: number, x: number): number {
  if (x !== x || y !== y) return x + y;
  const hx = hiWord(x);
  const lx = loWord(x);
  const ix = hx & 0x7fffffff;
  const hy = hiWord(y);
  const ly = loWord(y);
  const iy = hy & 0x7fffffff;
  if (hx === 0x3ff00000 && lx === 0) return detAtan(y); // x = 1
  let m = ((hy >> 31) & 1) | ((hx >> 30) & 2); // 2·sign(x) + sign(y)
  if ((iy | ly) === 0) {
    // y = ±0
    if (m < 2) return y;
    return m === 2 ? PI : -PI;
  }
  if ((ix | lx) === 0) return hy < 0 ? -PI_O_2 : PI_O_2; // x = ±0
  if (ix === 0x7ff00000) {
    // x = ±Infinity
    if (iy === 0x7ff00000) {
      return [PI_O_4, -PI_O_4, 3 * PI_O_4, -3 * PI_O_4][m]!;
    }
    return [0, -0, PI, -PI][m]!;
  }
  if (iy === 0x7ff00000) return hy < 0 ? -PI_O_2 : PI_O_2; // y = ±Infinity
  const k = (iy - ix) >> 20;
  let z: number;
  if (k > 60) {
    // |y/x| > 2^60
    z = PI_O_2 + 0.5 * PI_LO;
    m &= 1;
  } else if (hx < 0 && k < -60) {
    z = 0; // 0 > |y|/x > -2^-60
  } else {
    z = detAtan(Math.abs(y / x));
  }
  switch (m) {
    case 0:
      return z;
    case 1:
      return -z;
    case 2:
      return PI - (z - PI_LO);
    default:
      return z - PI_LO - PI;
  }
}

// ── asin / acos ────────────────────────────────────────────────────────

const PIO2_HI = 1.570796326794896558;
const PIO2_LO = 6.12323399573676603587e-17;
const PIO4_HI = 7.85398163397448278999e-1;
const PS0 = 1.66666666666666657415e-1;
const PS1 = -3.25565818622400915405e-1;
const PS2 = 2.01212532134862925881e-1;
const PS3 = -4.00555345006794114027e-2;
const PS4 = 7.91534994289814532176e-4;
const PS5 = 3.4793310759602116757e-5;
const QS1 = -2.40339491173441421878;
const QS2 = 2.02094576023350569471;
const QS3 = -6.8828397160545329303e-1;
const QS4 = 7.70381505559019352791e-2;

/** The rational approximation R(t) = p(t)/q(t) shared by asin and acos. */
function asinRational(t: number): number {
  const p = t * (PS0 + t * (PS1 + t * (PS2 + t * (PS3 + t * (PS4 + t * PS5)))));
  const q = 1 + t * (QS1 + t * (QS2 + t * (QS3 + t * QS4)));
  return p / q;
}

/** asin(x), deterministic on every platform. */
export function detAsin(x: number): number {
  const hx = hiWord(x);
  const ix = hx & 0x7fffffff;
  if (ix >= 0x3ff00000) {
    // |x| ≥ 1
    if (((ix - 0x3ff00000) | loWord(x)) === 0) return x * PIO2_HI + x * PIO2_LO;
    return NaN;
  }
  if (ix < 0x3fe00000) {
    // |x| < 0.5
    if (ix < 0x3e500000) return x; // |x| < 2^-26
    return x + x * asinRational(x * x);
  }
  // 0.5 ≤ |x| < 1
  const w = 1 - Math.abs(x);
  let t = w * 0.5;
  const r = asinRational(t);
  const s = Math.sqrt(t);
  if (ix >= 0x3fef3333) {
    // |x| > 0.975
    t = PIO2_HI - (2 * (s + s * r) - PIO2_LO);
  } else {
    const sHi = clearLow(s);
    const c = (t - sHi * sHi) / (s + sHi);
    const p = 2 * s * r - (PIO2_LO - 2 * c);
    const q = PIO4_HI - 2 * sHi;
    t = PIO4_HI - (p - q);
  }
  return hx > 0 ? t : -t;
}

/** acos(x), deterministic on every platform. */
export function detAcos(x: number): number {
  const hx = hiWord(x);
  const ix = hx & 0x7fffffff;
  if (ix >= 0x3ff00000) {
    // |x| ≥ 1
    if (((ix - 0x3ff00000) | loWord(x)) === 0) return hx > 0 ? 0 : PI + 2 * PIO2_LO;
    return NaN;
  }
  if (ix < 0x3fe00000) {
    // |x| < 0.5
    if (ix <= 0x3c600000) return PIO2_HI + PIO2_LO; // |x| < 2^-57
    return PIO2_HI - (x - (PIO2_LO - x * asinRational(x * x)));
  }
  if (hx < 0) {
    // x < -0.5
    const z = (1 + x) * 0.5;
    const s = Math.sqrt(z);
    const w = asinRational(z) * s - PIO2_LO;
    return PI - 2 * (s + w);
  }
  // x > 0.5
  const z = (1 - x) * 0.5;
  const s = Math.sqrt(z);
  const df = clearLow(s);
  const c = (z - df * df) / (s + df);
  const w = asinRational(z) * s + c;
  return 2 * (df + w);
}

// ── exp ────────────────────────────────────────────────────────────────

const O_THRESHOLD = 7.09782712893383973096e2;
const U_THRESHOLD = -7.4513321910194110842e2;
const LN2_HI = 6.9314718036912381649e-1;
const LN2_LO = 1.90821492927058770002e-10;
const INV_LN2 = 1.442695040888963387;
const P1 = 1.66666666666666019037e-1;
const P2 = -2.77777777770155933842e-3;
const P3 = 6.61375632143793436117e-5;
const P4 = -1.6533902205465251539e-6;
const P5 = 4.13813679705723846039e-8;
const TWO_M1000 = 9.3326361850321887899e-302; // 2^-1000

/** exp(x), deterministic on every platform. */
export function detExp(x: number): number {
  let hx = hiWord(x);
  const xsb = (hx >> 31) & 1;
  hx &= 0x7fffffff;
  if (hx >= 0x40862e42) {
    // |x| ≥ 709.78…
    if (hx >= 0x7ff00000) {
      if (x !== x) return x + x;
      return xsb === 0 ? x : 0; // exp(±Infinity) = Infinity, 0
    }
    if (x > O_THRESHOLD) return Infinity;
    if (x < U_THRESHOLD) return 0;
  }
  let hi = 0;
  let lo = 0;
  let k = 0;
  if (hx > 0x3fd62e42) {
    // |x| > 0.5·ln2
    if (hx < 0x3ff0a2b2) {
      // and |x| < 1.5·ln2
      hi = xsb === 0 ? x - LN2_HI : x + LN2_HI;
      lo = xsb === 0 ? LN2_LO : -LN2_LO;
      k = 1 - xsb - xsb;
    } else {
      k = Math.trunc(INV_LN2 * x + (xsb === 0 ? 0.5 : -0.5));
      hi = x - k * LN2_HI; // exact here
      lo = k * LN2_LO;
    }
    x = hi - lo;
  } else if (hx < 0x3e300000) {
    // |x| < 2^-28
    return 1 + x;
  }
  const t = x * x;
  const twopk =
    k >= -1021 ? fromWords((0x3ff + k) << 20, 0) : fromWords((0x3ff + k + 1000) << 20, 0);
  const c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k === 0) return 1 - ((x * c) / (c - 2) - x);
  const y = 1 - (lo - (x * c) / (2 - c) - hi);
  if (k >= -1021) {
    if (k === 1024) return y * 2 * 8.98846567431158e307; // 2^1023
    return y * twopk;
  }
  return y * twopk * TWO_M1000;
}

// ── pow ────────────────────────────────────────────────────────────────

const BP = [1, 1.5];
const DP_H = [0, 5.84962487220764160156e-1];
const DP_L = [0, 1.35003920212974897128e-8];
const TWO53 = 9007199254740992;
const L1 = 5.99999999999994648725e-1;
const L2 = 4.28571428578550184252e-1;
const L3 = 3.33333329818377432918e-1;
const L4 = 2.72728123808534006489e-1;
const L5 = 2.30660745775561754067e-1;
const L6 = 2.06975017800338417784e-1;
const LG2 = 6.93147180559945286227e-1;
const LG2_H = 6.93147182464599609375e-1;
const LG2_L = -1.90465429995776804525e-9;
const OVT = 8.008566259537294e-17; // -(1024 - log2(overflow + 0.5 ulp))
const CP = 9.61796693925975554329e-1;
const CP_H = 9.61796700954437255859e-1;
const CP_L = -7.02846165095275826516e-9;
const IVLN2 = 1.442695040888963387;
const IVLN2_H = 1.44269502162933349609;
const IVLN2_L = 1.92596299112661746887e-8;

/** z·2^n for a z near 1 whose scaled result is subnormal — one rounding. */
function scaleToSubnormal(z: number, n: number): number {
  return z * fromWords((0x3ff + n + 100) << 20, 0) * fromWords((0x3ff - 100) << 20, 0);
}

/** pow(x, y) (x^y), deterministic on every platform. */
export function detPow(x: number, y: number): number {
  const hx = hiWord(x);
  const lx = loWord(x);
  const hy = hiWord(y);
  const ly = loWord(y);
  let ix = hx & 0x7fffffff;
  const iy = hy & 0x7fffffff;

  if ((iy | ly) === 0) return 1; // x^0 = 1
  // ECMAScript departs from C99 here (Number::exponentiate): a NaN exponent
  // and (±1)^±Infinity are NaN, so 1^y is 1 only for a finite y.
  if (x !== x || y !== y) return NaN;
  if (iy === 0x7ff00000 && ly === 0 && ((ix - 0x3ff00000) | lx) === 0) return NaN;
  if (hx === 0x3ff00000 && lx === 0) return 1; // 1^y = 1

  // yisint: 0 not an integer, 1 odd integer, 2 even integer (only for x < 0)
  let yisint = 0;
  if (hx < 0) {
    if (iy >= 0x43400000) yisint = 2;
    else if (iy >= 0x3ff00000) {
      const k = (iy >> 20) - 0x3ff;
      if (k > 20) {
        const j = ly >>> (52 - k);
        if ((j << (52 - k)) >>> 0 === ly) yisint = 2 - (j & 1);
      } else if (ly === 0) {
        const j = iy >> (20 - k);
        if (j << (20 - k) === iy) yisint = 2 - (j & 1);
      }
    }
  }

  if (ly === 0) {
    if (iy === 0x7ff00000) {
      // y = ±Infinity
      if (((ix - 0x3ff00000) | lx) === 0) return 1; // (-1)^±Infinity
      if (ix >= 0x3ff00000) return hy >= 0 ? y : 0; // |x| > 1
      return hy < 0 ? -y : 0; // |x| < 1
    }
    if (iy === 0x3ff00000) return hy < 0 ? 1 / x : x; // y = ±1
    if (hy === 0x40000000) return x * x; // y = 2
    if (hy === 0x3fe00000 && hx >= 0) return Math.sqrt(x); // y = 0.5, x ≥ +0
  }

  let ax = Math.abs(x);
  if (lx === 0 && (ix === 0x7ff00000 || ix === 0 || ix === 0x3ff00000)) {
    // x = ±0, ±Infinity, ±1
    let z = ax;
    if (hy < 0) z = 1 / z;
    if (hx < 0) {
      if (((ix - 0x3ff00000) | yisint) === 0)
        z = NaN; // (-1)^non-integer
      else if (yisint === 1) z = -z;
    }
    return z;
  }

  let n = (hx >>> 31) - 1;
  if ((n | yisint) === 0) return NaN; // (x < 0)^non-integer
  let s = 1; // the sign of the result
  if ((n | (yisint - 1)) === 0) s = -1; // (x < 0)^odd

  let t1: number;
  let t2: number;
  if (iy > 0x41e00000) {
    // |y| > 2^31
    if (iy > 0x43f00000) {
      // |y| > 2^64: must over/underflow
      if (ix <= 0x3fefffff) return hy < 0 ? Infinity : 0;
      if (ix >= 0x3ff00000) return hy > 0 ? Infinity : 0;
    }
    if (ix < 0x3fefffff) return hy < 0 ? s * Infinity : s * 0;
    if (ix > 0x3ff00000) return hy > 0 ? s * Infinity : s * 0;
    // |1 - x| ≤ 2^-20: log(x) by x - x²/2 + x³/3 - x⁴/4
    const t = ax - 1;
    const w = t * t * (0.5 - t * (3.3333333333333331e-1 - t * 0.25));
    const u = IVLN2_H * t;
    const v = t * IVLN2_L - w * IVLN2;
    t1 = clearLow(u + v);
    t2 = v - (t1 - u);
  } else {
    n = 0;
    if (ix < 0x00100000) {
      // subnormal x
      ax *= TWO53;
      n -= 53;
      ix = hiWord(ax);
    }
    n += (ix >> 20) - 0x3ff;
    const j = ix & 0x000fffff;
    ix = j | 0x3ff00000; // normalize
    let k: number;
    if (j <= 0x3988e)
      k = 0; // |x| < √(3/2)
    else if (j < 0xbb67a)
      k = 1; // |x| < √3
    else {
      k = 0;
      n += 1;
      ix -= 0x00100000;
    }
    ax = withHigh(ax, ix);
    // ss = s_h + s_l = (x - 1)/(x + 1) or (x - 1.5)/(x + 1.5)
    let u = ax - BP[k]!;
    let v = 1 / (ax + BP[k]!);
    const ss = u * v;
    const sH = clearLow(ss);
    let tH = fromWords(((ix >> 1) | 0x20000000) + 0x00080000 + (k << 18), 0);
    let tL = ax - (tH - BP[k]!);
    const sL = v * (u - sH * tH - sH * tL);
    // log(ax)
    let s2 = ss * ss;
    let r = s2 * s2 * (L1 + s2 * (L2 + s2 * (L3 + s2 * (L4 + s2 * (L5 + s2 * L6)))));
    r += sL * (sH + ss);
    s2 = sH * sH;
    tH = clearLow(3 + s2 + r);
    tL = r - (tH - 3 - s2);
    u = sH * tH;
    v = sL * tH + tL * ss;
    const pH = clearLow(u + v);
    const pL = v - (pH - u);
    const zH = CP_H * pH;
    const zL = CP_L * pH + pL * CP + DP_L[k]!;
    // log2(ax) = n + dp_h + z_h + z_l
    const t = n;
    t1 = clearLow(zH + zL + DP_H[k]! + t);
    t2 = zL - (t1 - t - DP_H[k]! - zH);
  }

  // (y1 + y2)·(t1 + t2)
  const y1 = clearLow(y);
  const pL = (y - y1) * t1 + y * t2;
  let pH = y1 * t1;
  let z = pL + pH;
  let j = hiWord(z);
  let i = loWord(z);
  if (j >= 0x40900000) {
    // z ≥ 1024
    if (((j - 0x40900000) | i) !== 0) return s * Infinity;
    if (pL + OVT > z - pH) return s * Infinity;
  } else if ((j & 0x7fffffff) >= 0x4090cc00) {
    // z ≤ -1075
    if (((j - 0xc090cc00) | i) !== 0) return s * 0;
    if (pL <= z - pH) return s * 0;
  }
  // 2^(p_h + p_l)
  i = j & 0x7fffffff;
  let k = (i >> 20) - 0x3ff;
  n = 0;
  if (i > 0x3fe00000) {
    // |z| > 0.5: n = [z + 0.5]
    n = (j + (0x00100000 >> (k + 1))) | 0;
    k = ((n & 0x7fffffff) >> 20) - 0x3ff;
    const t = fromWords(n & ~(0x000fffff >> k), 0);
    n = ((n & 0x000fffff) | 0x00100000) >> (20 - k);
    if (j < 0) n = -n;
    pH -= t;
  }
  const t = clearLow(pL + pH);
  const u = t * LG2_H;
  const v = (pL - (t - pH)) * LG2 + t * LG2_L;
  z = u + v;
  const w = v - (z - u);
  const tt = z * z;
  const tt1 = z - tt * (P1 + tt * (P2 + tt * (P3 + tt * (P4 + tt * P5))));
  const r = (z * tt1) / (tt1 - 2) - (w + z * w);
  z = 1 - (r - z);
  j = (hiWord(z) + (n << 20)) | 0;
  if (j >> 20 <= 0) z = scaleToSubnormal(z, n);
  else z = withHigh(z, j);
  return s * z;
}
