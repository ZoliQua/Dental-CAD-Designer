// test/golden/goldenEnforcement.ts
//
// PLAN §6's golden-hash enforcement mechanism (Phase 2 Task 8): "Golden
// hashes change ONLY with a deliberate kernel version bump + changelog
// entry" (CLAUDE.md). Pure, framework-free logic — deliberately NOT vitest
// code — so it can be unit-tested directly with synthetic version/hash
// inputs (see goldenEnforcement.test.ts) independent of any real kernel op
// or fixture, and reused unmodified by test/golden/kernel-ops.test.ts.
//
// ## The rule, precisely
//
//  - computed hash === golden hash  -> OK, always (regardless of whether
//    KERNEL_VERSION changed — this is what makes a LEGITIMATE version bump
//    (bump + regenerate + commit the refreshed golden file) pass cleanly:
//    after regeneration the committed file's hash matches the new runtime
//    output, so this branch is taken no matter what the version string is).
//  - computed hash !== golden hash AND runtime KERNEL_VERSION === the
//    golden file's recorded kernelVersion -> FAIL, with a message telling
//    the developer to bump KERNEL_VERSION + add a docs/CHANGELOG-kernel.md
//    entry. This is the headline enforcement case: "a small numeric diff in
//    golden files is a red flag" (CLAUDE.md) caught automatically.
//  - computed hash !== golden hash AND runtime KERNEL_VERSION !== the
//    golden file's recorded kernelVersion -> FAIL too (a DIFFERENT
//    message): a version bump alone never excuses a stale golden file —
//    the developer must actually regenerate test-fixtures/golden/kernel-ops.json
//    and commit the refreshed file alongside the bump.
export interface GoldenHashCheckInput {
  opId: string;
  computedHash: string;
  goldenHash: string;
  runtimeKernelVersion: string;
  goldenKernelVersion: string;
}

export interface GoldenHashCheckResult {
  ok: boolean;
  /** Present iff `!ok` — a developer-facing explanation of exactly what to
   * do next. */
  message?: string;
}

export function checkGoldenHash(input: GoldenHashCheckInput): GoldenHashCheckResult {
  const { opId, computedHash, goldenHash, runtimeKernelVersion, goldenKernelVersion } = input;

  if (computedHash === goldenHash) {
    return { ok: true };
  }

  if (runtimeKernelVersion === goldenKernelVersion) {
    return {
      ok: false,
      message:
        `Golden hash mismatch for "${opId}" (computed ${computedHash}, golden ${goldenHash}) but KERNEL_VERSION ` +
        `(${runtimeKernelVersion}) is UNCHANGED from the golden file. Golden hashes may only change together with ` +
        `a KERNEL_VERSION bump (packages/kernel/src/index.ts) + a docs/CHANGELOG-kernel.md entry explaining the ` +
        `numerical difference (CLAUDE.md: "A 'small numeric diff' in golden files is a red flag — investigate, ` +
        `don't regenerate"). If this change is genuinely intentional: bump KERNEL_VERSION, add the changelog entry, ` +
        `then regenerate via \`npx tsx scripts/generate-kernel-goldens.ts\` and commit the refreshed file.`,
    };
  }

  return {
    ok: false,
    message:
      `Golden hash mismatch for "${opId}" (computed ${computedHash}, golden ${goldenHash}) — KERNEL_VERSION DID ` +
      `change (golden file: ${goldenKernelVersion}, runtime: ${runtimeKernelVersion}), but the committed golden ` +
      `file is still stale: its hashes don't match the new runtime output. A version bump alone is not enough — ` +
      `regenerate test-fixtures/golden/kernel-ops.json via \`npx tsx scripts/generate-kernel-goldens.ts\` and ` +
      `commit the refreshed file alongside this version bump.`,
  };
}

/** Runs {@link checkGoldenHash} over every op in `computed` against its
 * matching entry (by `id`) in `golden`, returning every failure (not just
 * the first) so a single test run reports every affected op at once. An op
 * present in one list but not the other is ALSO a failure (a op was added/
 * removed without regenerating the golden file). */
export function checkGoldenSnapshot(
  computed: { readonly kernelVersion: string; readonly ops: readonly { id: string; hash: string }[] },
  golden: { readonly kernelVersion: string; readonly ops: readonly { id: string; hash: string }[] },
): GoldenHashCheckResult[] {
  const results: GoldenHashCheckResult[] = [];
  const goldenById = new Map(golden.ops.map((op) => [op.id, op]));
  const computedIds = new Set(computed.ops.map((op) => op.id));

  for (const op of computed.ops) {
    const goldenOp = goldenById.get(op.id);
    if (!goldenOp) {
      results.push({
        ok: false,
        message: `kernel-ops golden: op "${op.id}" is computed but has no entry in the committed golden file — regenerate via scripts/generate-kernel-goldens.ts.`,
      });
      continue;
    }
    results.push(
      checkGoldenHash({
        opId: op.id,
        computedHash: op.hash,
        goldenHash: goldenOp.hash,
        runtimeKernelVersion: computed.kernelVersion,
        goldenKernelVersion: golden.kernelVersion,
      }),
    );
  }

  for (const op of golden.ops) {
    if (!computedIds.has(op.id)) {
      results.push({
        ok: false,
        message: `kernel-ops golden: op "${op.id}" is in the committed golden file but is no longer computed — regenerate via scripts/generate-kernel-goldens.ts (or was it removed intentionally? update the golden file either way).`,
      });
    }
  }

  return results;
}
