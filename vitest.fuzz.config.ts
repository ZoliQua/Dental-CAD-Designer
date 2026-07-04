// vitest.fuzz.config.ts
//
// Deliberately a SEPARATE config file from vitest.config.ts, not another
// entry in that file's `projects` array — this is what keeps the `fuzz`
// project excluded from the default `npm test` (`vitest run`, which reads
// only vitest.config.ts's projects). Run explicitly via `npm run test:fuzz`
// (package.json), which passes `--config vitest.fuzz.config.ts`.
//
// Fuzzing is comparatively slow (bounded but non-trivial run counts across
// several property tests — see packages/io/fuzz/*.fuzz.test.ts for the
// exact seeds/run counts) and its whole point is BROAD exploration, not the
// fast, always-on feedback loop `npm test` is for — so it gets its own CI
// step (see .github/workflows/ci.yml) after the main unit test suite,
// rather than slowing down every `npm test` invocation.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'fuzz',
    root: './packages/io',
    environment: 'node',
    include: ['fuzz/**/*.fuzz.test.ts'],
    passWithNoTests: false,
    // Property-based runs across several thousand cases (mutation) plus
    // hundreds of generative cases — generous but bounded; a real hang
    // (the guardrail this suite exists partly to catch) still fails loudly
    // instead of wedging CI indefinitely.
    testTimeout: 60_000,
  },
});
