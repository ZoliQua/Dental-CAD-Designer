// scripts/generate-kernel-goldens.ts
//
// Regenerates test-fixtures/golden/kernel-ops.json — the golden snapshot
// pinned by test/golden/kernel-ops.test.ts. Run with:
//   npx tsx scripts/generate-kernel-goldens.ts
//
// Golden-file policy (CLAUDE.md "Testing expectations" / docs/CHANGELOG-kernel.md):
// this file's hashes change ONLY with a deliberate KERNEL_VERSION bump and a
// docs/CHANGELOG-kernel.md entry explaining the numerical difference.
// test/golden/kernel-ops.test.ts's enforcement logic FAILS the build if any
// hash differs while KERNEL_VERSION is unchanged from this file's own
// `kernelVersion` field.
//
// Determinism-at-generation-time guardrail: every op is run TWICE and its
// hash compared before anything is written — a mismatch here means a real
// nondeterminism bug in the kernel (Math.random/Date.now/iteration-order/
// Map-insertion-order dependence, ...), not something to paper over by
// regenerating again.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeKernelOpsSnapshot, repoRoot, type KernelOpsSnapshot } from './kernel-ops-lib.ts';

const goldenDir = join(repoRoot, 'test-fixtures', 'golden');
const goldenPath = join(goldenDir, 'kernel-ops.json');

function assertDeterministic(first: KernelOpsSnapshot, second: KernelOpsSnapshot): void {
  if (first.ops.length !== second.ops.length) {
    throw new Error(
      `kernel-ops golden generation: op count changed between the two runs (${first.ops.length} vs ${second.ops.length}) — this alone is a determinism bug (op list must be static).`,
    );
  }
  const mismatches: string[] = [];
  for (let i = 0; i < first.ops.length; i++) {
    const a = first.ops[i]!;
    const b = second.ops[i]!;
    if (a.id !== b.id) {
      mismatches.push(`position ${i}: id changed (${a.id} vs ${b.id}) — op ORDER must be deterministic too`);
      continue;
    }
    if (a.hash !== b.hash) {
      mismatches.push(`"${a.id}": hash differs between the two runs (${a.hash} vs ${b.hash})`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `kernel-ops golden generation: NONDETERMINISM detected — refusing to write a golden file from a non-reproducible run.\n` +
        mismatches.map((m) => `  - ${m}`).join('\n'),
    );
  }
}

async function main(): Promise<void> {
  console.log('[kernel-ops golden] computing snapshot (run 1/2)...');
  const first = await computeKernelOpsSnapshot();
  console.log('[kernel-ops golden] computing snapshot (run 2/2, determinism check)...');
  const second = await computeKernelOpsSnapshot();
  assertDeterministic(first, second);
  console.log(`[kernel-ops golden] determinism OK across both runs (${first.ops.length} ops).`);

  mkdirSync(goldenDir, { recursive: true });
  writeFileSync(goldenPath, `${JSON.stringify(first, null, 2)}\n`, 'utf8');
  console.log(`[kernel-ops golden] wrote ${goldenPath}`);
  console.log('[kernel-ops golden] review the diff before committing (golden-file policy: bump KERNEL_VERSION + docs/CHANGELOG-kernel.md for any intentional change).');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
