// packages/traceability/src/fixtures.testutil.ts
//
// Shared SYNTHETIC fixtures for this package's unit tests: a fully
// deterministic release input and preview input (fixed hashes, fixed gate
// values — analytic, no kernel/fixture dependency, so these tests run in
// milliseconds and the byte pin below can never move with kernel changes).
// NOT a `.test.ts` — imported by the suites, never run as a suite itself.
import type { QcGateResult, QcReport } from '@dqcad/shared-types';
import type { PreviewTraceabilityInput, ReleaseTraceabilityInput } from './document.ts';

/** Deterministic fake 64-hex hash: the marker byte repeated. */
export function fakeHash(marker: string): string {
  if (!/^[0-9a-f]{2}$/.test(marker))
    throw new Error(`fakeHash marker must be 2 hex chars, got ${marker}`);
  return marker.repeat(32);
}

export const FIXTURE_GATES: readonly QcGateResult[] = [
  {
    gate: 'watertight',
    passed: true,
    acknowledged: false,
    value: 0,
    threshold: 0,
    unit: 'edges',
    message: 'no boundary edges',
  },
  {
    gate: 'minWallThickness',
    passed: true,
    acknowledged: false,
    value: 0.612,
    threshold: 0.5,
    unit: 'mm',
    message: 'minimum wall 0.612 mm >= 0.5 mm',
  },
  {
    gate: 'seating',
    passed: false,
    acknowledged: true,
    value: 0.0021,
    threshold: 0.001,
    unit: 'mm³',
    message: 'interference volume 0.0021 mm³ > 0.001 mm³',
  },
] as const;

export const FIXTURE_REPORT: QcReport = {
  gates: FIXTURE_GATES,
  passed: true,
  kernelVersion: '0.26.0',
  profileVersion: '1.4.0',
  journalHash: fakeHash('aa'),
};

export function releaseInputFixture(): ReleaseTraceabilityInput {
  return {
    identity: {
      caseId: 'case-fixture-1',
      restorationId: 'resto-fixture-1',
      restorationType: 'crown',
      teeth: [16],
    },
    serverReport: FIXTURE_REPORT,
    acknowledgments: [
      {
        gate: 'seating',
        message: 'interference volume 0.0021 mm³ > 0.001 mm³',
        value: 0.0021,
        threshold: 0.001,
        unit: 'mm³',
        operationId: 'ack-op-7',
      },
    ],
    materialProfile: { id: 'standard-zirconia', version: '1.4.0', checksum: fakeHash('cc') },
    manifoldVersion: '3.5.1',
    exportFile: {
      format: 'stl',
      bytesSha256: fakeHash('bb'),
      byteLength: 684,
      meshContentHash: fakeHash('aa'),
      headerText: 'DQ-Dental-CAD; units=mm; crown 16',
    },
    journal: {
      caseJournalHash: fakeHash('dd'),
      journalOperationCount: 12,
      exportOperationId: 'export-op-1',
    },
    reimportMeshHash: fakeHash('ee'),
    f32Narrowing: { maxAbsCoordinateMm: 12.5, halfUlpBoundMm: 4.76837158203125e-7 },
  };
}

export function previewInputFixture(): PreviewTraceabilityInput {
  return {
    identity: {
      caseId: 'case-fixture-1',
      restorationId: 'resto-fixture-1',
      restorationType: 'crown',
      teeth: [16],
    },
    report: FIXTURE_REPORT,
    acknowledgments: [
      {
        gate: 'seating',
        message: 'interference volume 0.0021 mm³ > 0.001 mm³',
        value: 0.0021,
        threshold: 0.001,
        unit: 'mm³',
        operationId: 'ack-op-7',
      },
    ],
    materialProfile: { id: 'standard-zirconia', version: '1.4.0', checksum: fakeHash('cc') },
    manifoldVersion: null,
  };
}
