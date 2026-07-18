// test/golden/kernel-ops.test.ts
//
// Vitest project `golden` (see vitest.config.ts / `npm run test:golden`) —
// Phase 2 Task 8's golden regression suite for kernel ops: intake,
// curvature, geodesicPath, fitSurfaceSpline, sampleSdfGrid, offsetMesh
// (+ a secondary pre-cleanup hash), union/subtract/intersect, sectionMesh,
// and the 3 repair ops — each run with PINNED params (see
// scripts/kernel-ops-lib.ts, the single source of truth both this test and
// scripts/generate-kernel-goldens.ts import) against
// test-fixtures/golden/kernel-ops.json.
//
// ## Enforcement (PLAN §6 / CLAUDE.md)
//
// "Golden hashes change ONLY with a deliberate kernel version bump +
// changelog entry." test/golden/goldenEnforcement.ts implements (and
// separately unit-tests) the exact rule; this file just wires it to the
// real computed-vs-committed comparison. See docs/CHANGELOG-kernel.md for
// the changelog itself.
//
// ## Runtime
//
// A single `computeKernelOpsSnapshot()` call (this test does ONE run, not
// the generator's double-run — determinism is verified at GENERATION time,
// per this task's guardrail) — see scripts/kernel-ops-lib.ts's module doc
// for the per-op runtime budget choices. Logged below for this task's
// report.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { KERNEL_VERSION } from '@dqcad/kernel';
import { computeKernelOpsSnapshot, repoRoot, type KernelOpsSnapshot } from '../../scripts/kernel-ops-lib.ts';
import { checkGoldenSnapshot } from './goldenEnforcement.ts';

const goldenPath = join(repoRoot, 'test-fixtures', 'golden', 'kernel-ops.json');

// Computed ONCE for the whole file (shared across the tests below) — a
// second, independent run is ALSO computed here (not per-test) purely for
// the double-run determinism assertion; generation-time nondeterminism is
// already caught harder, by scripts/generate-kernel-goldens.ts's own
// double-run-before-writing guardrail, so this file only needs to prove
// "this process's output is reproducible", not re-derive that guarantee.
let first: KernelOpsSnapshot;
let second: KernelOpsSnapshot;
let elapsedMs: number;

beforeAll(async () => {
  const started = performance.now();
  first = await computeKernelOpsSnapshot();
  elapsedMs = performance.now() - started;
  second = await computeKernelOpsSnapshot();
}, 30_000);

describe('kernel-ops golden regression suite', () => {
  it('every pinned kernel op matches its committed golden hash (KERNEL_VERSION-gated enforcement)', () => {
    // Acceptance-evidence log for this task's report (runtime budget: whole
    // suite should stay well under the ~2 min CI target).
    console.log(`[kernel-ops golden] computed ${first.ops.length} ops in ${(elapsedMs / 1000).toFixed(2)} s`);

    expect(first.kernelVersion).toBe(KERNEL_VERSION); // sanity: this suite always runs against the live kernel

    const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as KernelOpsSnapshot;
    const results = checkGoldenSnapshot(first, golden);
    const failures = results.filter((r) => !r.ok);

    if (failures.length > 0) {
      const report = failures.map((f) => `  - ${f.message}`).join('\n');
      throw new Error(`kernel-ops golden: ${failures.length} op(s) failed enforcement:\n${report}`);
    }
    expect(failures).toHaveLength(0);
  });

  it('the committed golden file was generated under a well-formed KERNEL_VERSION string', () => {
    // A cheap, independent sanity check distinct from the hash-comparison
    // test above: if the hash comparison passes but this ever looked wrong,
    // something is malformed in the committed file itself, independent of
    // whether hashes happen to still agree.
    const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as KernelOpsSnapshot;
    expect(typeof golden.kernelVersion).toBe('string');
    expect(golden.kernelVersion.length).toBeGreaterThan(0);
  });

  it('is deterministic: a second full run in THIS process is hash-identical to the first (double-run determinism)', () => {
    expect(second.ops.map((o) => o.hash)).toEqual(first.ops.map((o) => o.hash));
  });
});
