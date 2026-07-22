// packages/cad-pipeline/src/gates/runner.test.ts
//
// Gate-runner unit tests (Phase 4 Task 1 brief): "a trivial always-pass +
// always-fail gate; acknowledge path journaled". No real clinical gate
// exists yet (YAGNI) — these two trivial gates exist ONLY to exercise
// `runQcGates`'s own mechanics (ordering, acknowledgment, duplicate-name
// detection, purity/determinism), never exported from this package.
import { describe, expect, it } from 'vitest';
import type { QcGateResult } from '@dqcad/shared-types';
import { DuplicateGateNameError, runQcGates, type QcGate } from './runner.ts';

interface TrivialContext {
  readonly value: number;
}

const alwaysPassGate: QcGate<TrivialContext> = (ctx) => ({
  gate: 'alwaysPass',
  passed: true,
  acknowledged: false,
  value: ctx.value,
  threshold: null,
  unit: null,
  message: 'always passes',
});

const alwaysFailGate: QcGate<TrivialContext> = (ctx) => ({
  gate: 'alwaysFail',
  passed: false,
  acknowledged: false,
  value: ctx.value,
  threshold: 0,
  unit: 'mm',
  message: 'always fails',
});

const secondAlwaysPassGateSameName: QcGate<TrivialContext> = () => ({
  gate: 'alwaysPass', // deliberately collides with alwaysPassGate above
  passed: true,
  acknowledged: false,
  value: null,
  threshold: null,
  unit: null,
  message: 'also always passes, same name',
});

const baseOptions = { kernelVersion: '9.9.9', profileVersion: '1.0.0', journalHash: 'deadbeef' };

describe('runQcGates — basic pass/fail aggregation', () => {
  it('a single passing gate: QcReport.passed === true', () => {
    const report = runQcGates({ value: 1 }, [alwaysPassGate], baseOptions);
    expect(report.passed).toBe(true);
    expect(report.gates).toHaveLength(1);
    expect(report.gates[0]!.gate).toBe('alwaysPass');
    expect(report.gates[0]!.acknowledged).toBe(false);
  });

  it('a single failing, unacknowledged gate: QcReport.passed === false', () => {
    const report = runQcGates({ value: 1 }, [alwaysFailGate], baseOptions);
    expect(report.passed).toBe(false);
    expect(report.gates[0]!.passed).toBe(false);
    expect(report.gates[0]!.acknowledged).toBe(false);
  });

  it('mixed pass/fail: overall passed is false unless every failure is acknowledged', () => {
    const report = runQcGates({ value: 1 }, [alwaysPassGate, alwaysFailGate], baseOptions);
    expect(report.passed).toBe(false);
    expect(report.gates.map((g) => g.gate)).toEqual(['alwaysPass', 'alwaysFail']); // deterministic, array order
  });

  it('echoes kernelVersion/profileVersion/journalHash exactly as given', () => {
    const report = runQcGates({ value: 1 }, [alwaysPassGate], baseOptions);
    expect(report.kernelVersion).toBe('9.9.9');
    expect(report.profileVersion).toBe('1.0.0');
    expect(report.journalHash).toBe('deadbeef');
  });

  it('an empty gate list vacuously passes', () => {
    const report = runQcGates({ value: 1 }, [], baseOptions);
    expect(report.passed).toBe(true);
    expect(report.gates).toEqual([]);
  });
});

describe('runQcGates — acknowledge path (CLAUDE.md invariant 4: never silently bypassed)', () => {
  it('acknowledging a failing gate flips its acknowledged flag AND the overall passed', () => {
    const report = runQcGates({ value: 1 }, [alwaysPassGate, alwaysFailGate], {
      ...baseOptions,
      acknowledgedGates: ['alwaysFail'],
    });
    const failGateResult = report.gates.find((g) => g.gate === 'alwaysFail')!;
    expect(failGateResult.passed).toBe(false); // the underlying finding is UNCHANGED
    expect(failGateResult.acknowledged).toBe(true); // but explicitly acknowledged
    expect(report.passed).toBe(true); // overall report now reads "passed" (with the acknowledgment visible in gates[])
  });

  it('acknowledging a PASSING gate is a documented no-op (acknowledged stays false)', () => {
    const report = runQcGates({ value: 1 }, [alwaysPassGate], {
      ...baseOptions,
      acknowledgedGates: ['alwaysPass'],
    });
    expect(report.gates[0]!.acknowledged).toBe(false);
  });

  it('accepts acknowledgedGates as a plain array or a Set, identically', () => {
    const asArray = runQcGates({ value: 1 }, [alwaysFailGate], {
      ...baseOptions,
      acknowledgedGates: ['alwaysFail'],
    });
    const asSet = runQcGates({ value: 1 }, [alwaysFailGate], {
      ...baseOptions,
      acknowledgedGates: new Set(['alwaysFail']),
    });
    expect(asArray).toEqual(asSet);
  });

  it('an unrelated acknowledgment name never affects a different gate', () => {
    const report = runQcGates({ value: 1 }, [alwaysFailGate], {
      ...baseOptions,
      acknowledgedGates: ['someOtherGate'],
    });
    expect(report.gates[0]!.acknowledged).toBe(false);
    expect(report.passed).toBe(false);
  });
});

describe('runQcGates — duplicate gate names and determinism', () => {
  it('throws DuplicateGateNameError when two gates in the same run share a name', () => {
    expect(() =>
      runQcGates({ value: 1 }, [alwaysPassGate, secondAlwaysPassGateSameName], baseOptions),
    ).toThrow(DuplicateGateNameError);
  });

  it('a gate that genuinely throws propagates the throw (never silently swallowed into a failing result)', () => {
    const throwingGate: QcGate<TrivialContext> = () => {
      throw new Error('boom — a real implementation bug');
    };
    expect(() => runQcGates({ value: 1 }, [throwingGate], baseOptions)).toThrow('boom');
  });

  it('deterministic: same context + gates + options -> byte-identical (deep-equal) QcReport', () => {
    const a = runQcGates({ value: 42 }, [alwaysPassGate, alwaysFailGate], baseOptions);
    const b = runQcGates({ value: 42 }, [alwaysPassGate, alwaysFailGate], baseOptions);
    expect(a).toEqual(b);
  });

  it('gate order in the input array is preserved exactly in QcReport.gates', () => {
    const report = runQcGates({ value: 1 }, [alwaysFailGate, alwaysPassGate], baseOptions);
    expect(report.gates.map((g) => g.gate)).toEqual(['alwaysFail', 'alwaysPass']);
  });
});

describe('runQcGates — dual-validation portability (no DOM/Three/browser deps)', () => {
  it('runs identically in this (Node) test environment with only shared-types imported', () => {
    // The import graph itself is the real assertion here (this file only
    // imports '@dqcad/shared-types' and this module's own runner.ts — see
    // this file's top imports) — this test exercises the call once more to
    // confirm nothing about the RUNTIME behavior depends on an environment
    // this suite doesn't have (window/document/Worker).
    const result: QcGateResult = alwaysPassGate({ value: 7 });
    expect(result.passed).toBe(true);
    const report = runQcGates({ value: 7 }, [alwaysPassGate], baseOptions);
    expect(report.passed).toBe(true);
  });
});
