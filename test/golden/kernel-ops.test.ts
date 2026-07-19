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
// ## Enforcement (PLAN §6 / CLAUDE.md) — TWO layers, two different holes
//
// "Golden hashes change ONLY with a deliberate kernel version bump +
// changelog entry." No single mechanism enforces this end to end; it takes
// two layers, each catching a failure mode the other cannot:
//
//  1. TEST layer (this file, backed by test/golden/goldenEnforcement.ts's
//     pure rule + its own synthetic-input unit tests): compares LIVE kernel
//     output against whatever golden file is CURRENTLY COMMITTED. Catches
//     "kernel behavior changed but the developer forgot to regenerate the
//     golden file" — the live hash won't match the stale committed one.
//     This is a live-vs-committed check; it says nothing about whether the
//     committed file itself was updated honestly.
//  2. CI layer (scripts/check-golden-version-gate.ts, run as its own CI
//     step in .github/workflows/ci.yml — NOT part of this vitest file):
//     diffs the current push/PR against a base ref and catches "the golden
//     file WAS regenerated (so it now matches live output — layer 1 stays
//     green) but KERNEL_VERSION was never bumped and/or no changelog entry
//     was added". Layer 1 alone cannot see this, because a regenerated
//     golden file is by definition self-consistent with live output.
//
// What NEITHER layer catches: a force-push/history-rewrite that replaces
// the base ref itself, or a reviewer approving a PR without reading the
// diff (i.e. the base-ref diff and merge-base computation assume normal,
// non-rewritten git history). That residual stays code-review territory —
// no mechanism here can make a rewritten history retroactively honest. See
// docs/CHANGELOG-kernel.md's policy header for the same two-layer summary
// from the policy side, and scripts/check-golden-version-gate.ts's module
// doc for the CI layer's exact base-ref logic (push vs. pull_request).
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

// Hook timeout 30_000 -> 120_000 (Phase 2 Task 12 fix for full-suite timing
// flakiness under CPU contention — see .superpowers/sdd/progress.md's P2
// Task 11 carry-over note): this hook computes the FULL kernel-ops snapshot
// TWICE (determinism check), and under `npm test`'s default full parallel
// run (every other project's test files sharing the same machine's CPU,
// including the client-dom project's real Chromium instance) that can
// meaningfully exceed 30s even though it stays well under this file's own
// documented "~2 min CI target" in isolation.
beforeAll(async () => {
  const started = performance.now();
  first = await computeKernelOpsSnapshot();
  elapsedMs = performance.now() - started;
  second = await computeKernelOpsSnapshot();
}, 120_000);

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
