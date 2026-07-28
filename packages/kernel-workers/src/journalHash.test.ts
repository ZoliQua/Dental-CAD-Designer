// packages/kernel-workers/src/journalHash.test.ts
//
// Phase 7 Task 3 — the case-journal hash (the `caseJournalHash` field of
// `RestorationExportRequest`, shared-types). The definition under test (see
// journalHash.ts's module doc): SHA-256 over the canonical JSON of the
// journal's REPRODUCIBLE view — per op, exactly
// `{ inputHashes, kernelVersion, name, outputHashes, params }`, object keys
// sorted recursively, `id`/`timestamp` EXCLUDED — so the hash is stable
// across sessions (the journal is persisted verbatim) AND across a journal
// REPLAY (which regenerates ids/timestamps but reproduces params + hashes).
// Falsifiable in both directions: the exclusion tests prove id/timestamp
// changes do NOT move the hash; the sensitivity tests prove every included
// field DOES move it; the strictness tests prove no silently-lossy value can
// enter the hash (NaN → null collisions etc. are impossible by construction).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Operation } from '@dqcad/shared-types';
import {
  canonicalJournalJson,
  hashCaseJournal,
  JournalHashUnserializableError,
} from './journalHash';

function op(overrides: Partial<Operation> = {}): Operation {
  return {
    id: 'a-random-uuid',
    name: 'crown-shell',
    params: { restorationId: 'r1', autoThicken: false, volumeMm3: 123.25 },
    inputHashes: ['in-1', 'in-2'],
    outputHashes: ['out-1'],
    kernelVersion: '0.26.0',
    timestamp: '2026-07-18T00:00:00.000Z',
    ...overrides,
  };
}

describe('canonicalJournalJson — the reproducible view', () => {
  it('serializes exactly {inputHashes, kernelVersion, name, outputHashes, params} per op, keys sorted', () => {
    const json = canonicalJournalJson([op()]);
    expect(json).toBe(
      '[{"inputHashes":["in-1","in-2"],"kernelVersion":"0.26.0","name":"crown-shell",' +
        '"outputHashes":["out-1"],"params":{"autoThicken":false,"restorationId":"r1","volumeMm3":123.25}}]',
    );
  });

  it('excludes id and timestamp: two ops differing ONLY there serialize identically', () => {
    const a = canonicalJournalJson([op({ id: 'uuid-A', timestamp: '2020-01-01T00:00:00.000Z' })]);
    const b = canonicalJournalJson([op({ id: 'uuid-B', timestamp: '2026-07-18T12:34:56.789Z' })]);
    expect(a).toBe(b);
  });

  it('is independent of params key insertion order (canonical sorted keys, recursively)', () => {
    const a = canonicalJournalJson([op({ params: { b: 1, a: { z: true, y: 'x' } } })]);
    const b = canonicalJournalJson([op({ params: { a: { y: 'x', z: true }, b: 1 } })]);
    expect(a).toBe(b);
  });

  it('drops undefined object properties (matching JSON.stringify semantics, deterministically)', () => {
    const a = canonicalJournalJson([op({ params: { kept: 1, dropped: undefined } })]);
    const b = canonicalJournalJson([op({ params: { kept: 1 } })]);
    expect(a).toBe(b);
  });

  it('IS sensitive to every included field (name, params values, hashes, kernelVersion, op order)', () => {
    const base = canonicalJournalJson([op()]);
    expect(canonicalJournalJson([op({ name: 'crown-sculpt' })])).not.toBe(base);
    expect(canonicalJournalJson([op({ params: { restorationId: 'r1', autoThicken: true, volumeMm3: 123.25 } })])).not.toBe(base);
    expect(canonicalJournalJson([op({ inputHashes: ['in-1'] })])).not.toBe(base);
    expect(canonicalJournalJson([op({ outputHashes: ['out-2'] })])).not.toBe(base);
    expect(canonicalJournalJson([op({ kernelVersion: '0.27.0' })])).not.toBe(base);
    const two = [op(), op({ name: 'crown-qc' })];
    expect(canonicalJournalJson(two)).not.toBe(canonicalJournalJson([...two].reverse()));
  });

  it('rejects non-finite numbers (no silent NaN/Infinity → null collision)', () => {
    expect(() => canonicalJournalJson([op({ params: { bad: Number.NaN } })])).toThrow(
      JournalHashUnserializableError,
    );
    expect(() => canonicalJournalJson([op({ params: { bad: Number.POSITIVE_INFINITY } })])).toThrow(
      JournalHashUnserializableError,
    );
  });

  it('rejects values JSON cannot faithfully represent (bigint, function, typed array, Date, Map, undefined array element)', () => {
    for (const bad of [
      { bad: 10n },
      { bad: () => 0 },
      { bad: new Float64Array([1]) },
      { bad: new Date(0) },
      { bad: new Map() },
      { bad: [1, undefined, 3] },
      { bad: Symbol('s') },
    ]) {
      expect(
        () => canonicalJournalJson([op({ params: bad as unknown as Operation['params'] })]),
        `params ${String(Object.values(bad)[0])}`,
      ).toThrow(JournalHashUnserializableError);
    }
  });

  it('F2 regression: rejects array HOLES (sparse arrays), not just explicit undefined elements', () => {
    // [1, <hole>, 3] — built without literal sparse syntax (no-sparse-arrays
    // lint). Array.prototype.map SKIPS holes, so a map-based serializer
    // emits the invalid JSON `[1,,3]` and hashes differently after a
    // save/load round-trip (the hole becomes null) — the exact instability
    // this module exists to make impossible.
    const holed: unknown[] = [1];
    holed[2] = 3;
    expect(() => canonicalJournalJson([op({ params: { bad: holed } })])).toThrow(
      JournalHashUnserializableError,
    );
  });

  it('-0 is deliberately normalized to 0 (pinned: stable across save/load, numerically equal — see module doc)', () => {
    const negZero = canonicalJournalJson([op({ params: { z: -0 } })]);
    const posZero = canonicalJournalJson([op({ params: { z: 0 } })]);
    expect(negZero).toBe(posZero);
    expect(negZero).toContain('"z":0');
  });

  it('names the offending path in the strictness error (actionable diagnostics)', () => {
    expect(() => canonicalJournalJson([op({ params: { outer: { inner: Number.NaN } } })])).toThrow(
      /params\.outer\.inner/,
    );
  });

  it('accepts null, nested plain objects/arrays, and null-prototype objects', () => {
    const params = Object.assign(Object.create(null) as Record<string, unknown>, {
      list: [1, 'two', null, { deep: true }],
      nothing: null,
    });
    expect(canonicalJournalJson([op({ params })])).toContain('"nothing":null');
  });

  it('an empty journal serializes to [] and hashes deterministically', async () => {
    expect(canonicalJournalJson([])).toBe('[]');
    const expected = createHash('sha256').update('[]').digest('hex');
    await expect(hashCaseJournal([])).resolves.toBe(expected);
  });
});

describe('hashCaseJournal', () => {
  it('is SHA-256 (lowercase hex) over the UTF-8 canonical JSON', async () => {
    const history = [op(), op({ name: 'crown-qc', params: { restorationId: 'r1', passed: true } })];
    const expected = createHash('sha256').update(canonicalJournalJson(history), 'utf8').digest('hex');
    await expect(hashCaseJournal(history)).resolves.toBe(expected);
    await expect(hashCaseJournal(history)).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across a simulated replay (new ids/timestamps, same reproducible content)', async () => {
    const recorded = [op({ id: 'rec-1', timestamp: '2026-01-01T00:00:00.000Z' })];
    const replayed = [op({ id: 'rep-1', timestamp: '2026-07-18T09:00:00.000Z' })];
    await expect(hashCaseJournal(recorded)).resolves.toBe(await hashCaseJournal(replayed));
  });

  it('non-ASCII param strings hash over UTF-8 bytes (not UTF-16 code units)', async () => {
    const history = [op({ params: { note: 'fogpótlás – Dúl' } })];
    const expected = createHash('sha256')
      .update(Buffer.from(canonicalJournalJson(history), 'utf8'))
      .digest('hex');
    await expect(hashCaseJournal(history)).resolves.toBe(expected);
  });
});
