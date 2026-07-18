// scripts/replay-journal.ts
//
// CLI entry for Phase 2 Task 8's journal-replay harness (PLAN §6.3): records
// a scripted case journal on each fixture in journal-replay-lib.ts's
// `recordAllFixtures()`, replays it fresh, and reports whether every output
// hash reproduced. Run with:
//   npx tsx scripts/replay-journal.ts
//
// See journal-replay-lib.ts's module doc for exactly what "replay" proves
// for each operation kind (in particular, `import-mesh`'s ADR-001-scoped
// claim). test/golden/journal-replay.test.ts wraps the SAME logic in a
// CI-wired vitest assertion — this script is the human-facing / ad-hoc
// counterpart (prints a per-operation report; exits non-zero on any
// failure).
import { recordAllFixtures, replayJournal } from './journal-replay-lib.ts';

function main(): void {
  const journals = recordAllFixtures();
  let totalOps = 0;
  let totalFailures = 0;

  for (const journal of journals) {
    console.log(`\n[journal-replay] fixture "${journal.fixtureLabel}" — ${journal.operations.length} operation(s):`);
    for (const operation of journal.operations) {
      console.log(`  - ${operation.name} (id=${operation.id})`);
    }
    const failures = replayJournal(journal);
    totalOps += journal.operations.length;
    totalFailures += failures.length;
    if (failures.length === 0) {
      console.log(`  [journal-replay] OK — every output hash reproduced on replay.`);
    } else {
      for (const failure of failures) {
        console.error(
          `  [journal-replay] MISMATCH: "${failure.operationName}" (${failure.operationId}) — ` +
            `expected ${failure.expectedHash}, got ${failure.actualHash}`,
        );
      }
    }
  }

  console.log(`\n[journal-replay] ${totalOps - totalFailures}/${totalOps} operations reproduced across ${journals.length} fixture(s).`);
  if (totalFailures > 0) {
    console.error(`[journal-replay] FAILED: ${totalFailures} operation(s) did not reproduce on replay.`);
    process.exitCode = 1;
  }
}

main();
