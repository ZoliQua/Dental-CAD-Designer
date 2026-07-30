// apps/client/src/engine/diagnosticLog.test.ts
//
// Phase 8 Task 5 — the bounded, PHI-free log ring. Two guarded properties:
//  1. BOUNDED — the ring never exceeds DIAGNOSTIC_LOG_CAPACITY; oldest drops.
//  2. PHI-FREE BY CONSTRUCTION — a non-scalar field value (an object/array that
//     could carry case content) is DROPPED, never serialized into an entry.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DIAGNOSTIC_LOG_CAPACITY,
  diagnosticLogSnapshot,
  logDiagnostic,
  logInfo,
  resetDiagnosticLogForTests,
  type DiagnosticLogFields,
} from './diagnosticLog';

beforeEach(() => resetDiagnosticLogForTests(() => '2026-07-22T00:00:00.000Z'));
afterEach(() => resetDiagnosticLogForTests());

describe('diagnosticLog — bounded ring', () => {
  it('appends entries with a monotonic sequence and the injected clock', () => {
    logInfo('a', { x: 1 });
    logInfo('b', { y: 'ok' });
    const snap = diagnosticLogSnapshot();
    expect(snap).toHaveLength(2);
    expect(snap[0]).toMatchObject({ seq: 1, event: 'a', at: '2026-07-22T00:00:00.000Z' });
    expect(snap[1]).toMatchObject({ seq: 2, event: 'b' });
  });

  it('never exceeds the capacity and drops the OLDEST entries', () => {
    const overflow = DIAGNOSTIC_LOG_CAPACITY + 50;
    for (let i = 0; i < overflow; i++) {
      logInfo('evt', { i });
    }
    const snap = diagnosticLogSnapshot();
    expect(snap).toHaveLength(DIAGNOSTIC_LOG_CAPACITY);
    // The oldest 50 were dropped: the first retained field.i is `overflow - CAP`.
    expect(snap[0]?.fields.i).toBe(overflow - DIAGNOSTIC_LOG_CAPACITY);
    expect(snap[snap.length - 1]?.fields.i).toBe(overflow - 1);
  });

  it('snapshot is an independent copy (mutating it does not affect the ring)', () => {
    logInfo('a');
    const snap = diagnosticLogSnapshot() as unknown[];
    snap.push({});
    expect(diagnosticLogSnapshot()).toHaveLength(1);
  });
});

describe('diagnosticLog — PHI-free by construction', () => {
  it('keeps scalar fields (string/number/boolean)', () => {
    logDiagnostic('warn', 'evt', { id: 'case-1', count: 3, flag: true });
    expect(diagnosticLogSnapshot()[0]?.fields).toEqual({ id: 'case-1', count: 3, flag: true });
  });

  it('DROPS non-scalar field values (an object/array can never leak into an entry)', () => {
    // A caller that (via `unknown`) tries to log a whole case object / geometry
    // buffer: the object/array values are stripped, only scalars survive.
    const hostile = {
      safe: 'ok',
      patient: { name: 'Jane Doe', ref: 'SSN-123' },
      vertices: [0.1, 0.2, 0.3],
    } as unknown as DiagnosticLogFields;
    logDiagnostic('info', 'evt', hostile);
    const fields = diagnosticLogSnapshot()[0]?.fields ?? {};
    expect(fields).toEqual({ safe: 'ok' });
    // The dropped content is nowhere in the serialized entry.
    const serialized = JSON.stringify(diagnosticLogSnapshot());
    expect(serialized).not.toContain('Jane Doe');
    expect(serialized).not.toContain('SSN-123');
  });
});
