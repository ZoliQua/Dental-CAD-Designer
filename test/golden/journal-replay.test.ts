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
    expect(journals.length).toBeGreaterThanOrEqual(3);
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
      'repair-split-non-manifold-vertices',
    ]);
    const archJournal = journals.find((j) => j.fixtureLabel === 'arch-case-01-upperjaw')!;
    expect(archJournal.operations.map((op) => op.name)).toEqual(['import-mesh']);
  });

  // Phase 3 Task 11: margin/axis journal-replay extension — see
  // scripts/journal-replay-lib.ts's own module doc section ("Phase 3 Task
  // 11: margin/axis journal-replay extension") for exactly which margin/
  // axis Operation kinds are (and are not) replayable, and why.
  it('margin fixture: a seeded auto-propose journals a replayable "margin-edit" carrying seed + proposalDefaults', () => {
    const marginJournal = journals.find((j) => j.fixtureLabel === 'arch-case-01-upperjaw-margin-tooth21')!;
    expect(marginJournal).toBeDefined();
    expect(marginJournal.operations.map((op) => op.name)).toEqual(['margin-edit']);
    const op = marginJournal.operations[0]!;
    expect(op.params).toMatchObject({
      tooth: 21,
      gesture: 'accept-proposal',
      closed: true,
      seed: { triangleIndex: expect.any(Number), barycentric: expect.any(Array) },
      proposalDefaults: { targetAnchorCount: 50 },
    });
    expect(op.outputHashes).toHaveLength(1);
    // The margin fixture's own replay proof is already covered by the
    // generic "every journaled operation output hash reproduces" case
    // above (it.each over ALL of `recordAllFixtures()`) — this test only
    // pins down the SHAPE (op name, seed/proposalDefaults params) the
    // brief asks for, not a second redundant hash check.
  });

  // Phase 7 Task 3: the manufacturing-export op enters this always-on harness
  // — `restoration-export`'s outputHashes[0] is the SHA-256 of the exported
  // FILE BYTES; replay recomputing the exact bytes is the "replay reproduces
  // the exact bytes" acceptance (see scripts/journal-replay-lib.ts's export
  // section for the full claim).
  it('export fixture: restoration-export ops (stl with journaled headerText + ply) carry byte-hash outputs', () => {
    const exportJournal = journals.find((j) => j.fixtureLabel === 'sphere-r5-restoration-export')!;
    expect(exportJournal).toBeDefined();
    expect(exportJournal.operations.map((op) => op.name)).toEqual([
      'restoration-export',
      'restoration-export',
    ]);
    const [stlOp, plyOp] = exportJournal.operations;
    expect(stlOp!.params).toMatchObject({
      restorationType: 'crown',
      format: 'stl',
      headerText: expect.stringContaining('units=mm'),
      acknowledgedGates: [],
    });
    expect(plyOp!.params).toMatchObject({ format: 'ply' });
    expect('headerText' in plyOp!.params).toBe(false);
    for (const op of exportJournal.operations) {
      expect(op.inputHashes).toHaveLength(1); // the final mesh content hash
      expect(op.outputHashes[0]).toMatch(/^[0-9a-f]{64}$/); // the BYTES hash
    }
    // The byte-replay proof itself is covered by the generic it.each over
    // recordAllFixtures() above (fresh recompute of the exact bytes → hash).
  });

  // Phase 4 Task 12: the crown MORPHING stage enters this always-on harness
  // (the full 6-stage crown chain — inner/anatomy/morph/shell/freeform/qc — is
  // recorded, replayed + byte-pinned in test/golden/crown-acceptance.test.ts).
  it('crown-morph fixture: a synthetic morph journals a replayable "morphing.morph" crown stage op', () => {
    const crownJournal = journals.find((j) => j.fixtureLabel === 'crown-morph-synthetic')!;
    expect(crownJournal).toBeDefined();
    expect(crownJournal.operations.map((op) => op.name)).toEqual(['morphing.morph']);
    const op = crownJournal.operations[0]!;
    expect(op.params).toMatchObject({ tooth: 11, rbfKernel: 'biharmonic-r' });
    expect(op.outputHashes).toHaveLength(1);
    expect(op.outputHashes[0]).toMatch(/^[0-9a-f]{64}$/);
    // Its replay proof is covered by the generic it.each over recordAllFixtures().
  });
});
