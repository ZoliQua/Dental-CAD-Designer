// packages/kernel/src/register/prng.ts
//
// Seeded PRNG for deterministic PRODUCTION sampling (icpRefine's src-mesh
// point sampling — see sampling.ts). mulberry32: a small, fast, well-known
// 32-bit PRNG (public domain, Tommy Ettinger) — chosen because this exact
// algorithm is ALREADY this repo's established seeded-determinism idiom in
// TEST code (packages/kernel/src/geodesic/geodesicPath.analytic.test.ts,
// packages/kernel/src/sdf/signedDistance.reflex.test.ts both use it for
// reproducible jitter/sample seeding), so a production copy here keeps the
// "seed -> reproducible sequence" story consistent rather than introducing a
// second RNG algorithm into the codebase. NOT cryptographically secure
// (irrelevant — this is geometry sampling, not security) and deliberately
// NOT `Math.random()` (CLAUDE.md invariant 2: "no unseeded randomness").
export type Rng = () => number;

/** Returns a seeded RNG producing floats in `[0, 1)`. The same `seed`
 * always produces the same output sequence, forever — this repo's
 * determinism invariant (CLAUDE.md invariant 2; CI's golden/replay harnesses
 * depend on this never changing). `seed` is coerced to a uint32 (`>>> 0`),
 * so any finite number is an accepted seed. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function (): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
