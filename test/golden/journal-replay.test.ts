// test/golden/journal-replay.test.ts
//
// Vitest project `golden` (see vitest.config.ts / `npm run test:golden`) —
// CI-wired assertion for Phase 2 Task 8's journal-replay harness (PLAN
// §6.3 / PLAN.md §6 invariant 3: "Journal reproducibility. Replaying a
// case journal reproduces every stage hash. CI replays fixture journals on
// every commit."). Records a scripted case journal (import, unit-rescale,
// repair ops) via scripts/journal-replay-lib.ts on a small, fast fixture
// set (see that file's `recordAllFixtures` — no perf-scale fixtures, so
// this already IS the "fast subset" the task brief asks CI to run), then
// replays every operation fresh and asserts every output hash is
// identical.
//
// See journal-replay-lib.ts's module doc for exactly what "replay" proves
// for `import-mesh` given ADR-001's post-intake-STL-persistence constraint
// (docs/adr/001-post-intake-stl-persistence.md) — a narrower, but genuine,
// reproducibility claim than "intake reproduces against the original scan
// bytes" (that claim is test/golden/intake.test.ts's job).
import { describe, expect, it } from 'vitest';
import { recordAllFixtures, replayJournal, type RecordedJournal } from '../../scripts/journal-replay-lib.ts';

describe('journal replay — scripted case journals reproduce every output hash', () => {
  const journals = recordAllFixtures();

  it('recorded at least the documented fixture set, each with at least one operation', () => {
    expect(journals.length).toBeGreaterThanOrEqual(2);
    for (const journal of journals) {
      expect(journal.operations.length).toBeGreaterThan(0);
      expect(journal.operations.length).toBe(journal.replaySteps.length);
    }
  });

  it.each(recordAllFixtures().map((j): [string, RecordedJournal] => [j.fixtureLabel, j]))(
    'fixture "%s": every journaled operation output hash reproduces on a fresh replay',
    (_label, journal) => {
      const failures = replayJournal(journal);
      if (failures.length > 0) {
        const report = failures
          .map((f) => `  - "${f.operationName}" (${f.operationId}): expected ${f.expectedHash}, got ${f.actualHash}`)
          .join('\n');
        throw new Error(`journal replay: ${failures.length} operation(s) failed to reproduce:\n${report}`);
      }
      expect(failures).toHaveLength(0);
    },
  );

  it('is itself deterministic: recording the same fixture twice produces identical journals', () => {
    for (const journal of journals) {
      const [again] = recordAllFixtures().filter((j) => j.fixtureLabel === journal.fixtureLabel);
      expect(again).toBeDefined();
      expect(again!.operations.map((op) => op.outputHashes[0])).toEqual(journal.operations.map((op) => op.outputHashes[0]));
    }
  });

  it('the full operation-name sequence matches the task brief\'s scripted journal shape (import, rescale, repair ops)', () => {
    const sphereJournal = journals.find((j) => j.fixtureLabel === 'sphere-r5')!;
    expect(sphereJournal.operations.map((op) => op.name)).toEqual([
      'import-mesh',
      'unit-rescale',
      'repair-remove-components',
      'repair-split-non-manifold-edges',
      'repair-fill-small-holes',
    ]);
    const archJournal = journals.find((j) => j.fixtureLabel === 'arch-case-01-upperjaw')!;
    expect(archJournal.operations.map((op) => op.name)).toEqual(['import-mesh']);
  });
});
