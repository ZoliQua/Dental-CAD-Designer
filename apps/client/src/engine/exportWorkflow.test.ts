// apps/client/src/engine/exportWorkflow.test.ts
//
// Phase 7 Task 3 — the PURE export gate (engine/exportWorkflow.ts): "may
// these bytes leave the system?" answered from a `Restoration` snapshot +
// journal alone, shared by all three workflows (the P5-T8 shared-core
// discipline — ONE implementation, not three drifting copies).
//
// Falsifiable BOTH ways per restoration type: for crown, inlay/onlay and
// bridge alike, a hard-failing UNACKNOWLEDGED gate refuses with the exact
// failing-gate list, and the SAME report with those gates acknowledged
// allows — with the acknowledgments (gate ids + messages + journal refs)
// riding on the allowed verdict.
import { describe, expect, it } from 'vitest';
import type { Operation, QcGateResult, QcReport, Restoration, RestorationType } from '@dqcad/shared-types';
import de from '../i18n/de.json';
import en from '../i18n/en.json';
import es from '../i18n/es.json';
import hu from '../i18n/hu.json';
import {
  collectAcknowledgments,
  EXPORT_REFUSAL_I18N_KEY,
  exportGateVerdict,
  isExportRecordStale,
  type ExportRefusalCode,
} from './exportWorkflow';

function gate(overrides: Partial<QcGateResult> & { gate: string }): QcGateResult {
  return {
    passed: true,
    acknowledged: false,
    value: null,
    threshold: null,
    unit: null,
    message: 'ok',
    ...overrides,
  };
}

function qcReport(gates: QcGateResult[], journalHash: string): QcReport {
  return {
    gates,
    passed: gates.every((g) => g.passed || g.acknowledged),
    kernelVersion: '0.26.0',
    profileVersion: '1.4.0',
    journalHash,
  };
}

function restoration(
  type: RestorationType,
  overrides: Partial<Restoration> = {},
): Restoration {
  return {
    id: `resto-${type}`,
    type,
    teeth: type === 'bridge' ? [14, 15, 16] : [16],
    pontics: type === 'bridge' ? [15] : [],
    targetNodeId: 'node-1',
    marginLines: {},
    insertionAxis: [0, 0, 1],
    params: {
      cementGapMm: 0.05,
      marginalGapMm: 0.02,
      spacerStartMm: 0.8,
      minWallThicknessMm: 0.5,
      proximalContactPenetrationMm: 0.02,
      occlusalContactMm: 0,
    },
    stages: { finalMesh: 'final-hash' },
    qc: null,
    ...overrides,
  };
}

function ackOp(
  opName: string,
  restorationId: string,
  acknowledgedGates: readonly string[],
  id = `op-${opName}-${acknowledgedGates.join('+')}`,
): Operation {
  return {
    id,
    name: opName,
    params: { restorationId, acknowledgedGate: acknowledgedGates[acknowledgedGates.length - 1], acknowledgedGates },
    inputHashes: ['final-hash'],
    outputHashes: [],
    kernelVersion: '0.26.0',
    timestamp: '2026-07-18T00:00:00.000Z',
  };
}

const ACK_OP_NAME: Record<RestorationType, string> = {
  crown: 'crown-qc-ack',
  inlay: 'inlay-qc-ack',
  onlay: 'inlay-qc-ack',
  bridge: 'bridge-qc-ack',
};

describe('exportGateVerdict — refusal ladder', () => {
  it('refuses with noFinalMesh when no final solid exists (even with a leftover QC report)', () => {
    const r = restoration('crown', { stages: {}, qc: qcReport([gate({ gate: 'watertight' })], 'x') });
    expect(exportGateVerdict(r, [])).toEqual({
      allowed: false,
      refusalCode: 'noFinalMesh',
      failingGates: [],
    });
  });

  it('refuses with qcMissing when the final mesh exists but QC never ran', () => {
    const r = restoration('crown');
    expect(exportGateVerdict(r, [])).toMatchObject({ allowed: false, refusalCode: 'qcMissing' });
  });

  it('refuses with qcStale when the design changed after the last QC run', () => {
    const r = restoration('crown', {
      qc: qcReport([gate({ gate: 'watertight' })], 'an-older-final-hash'),
    });
    expect(exportGateVerdict(r, [])).toMatchObject({ allowed: false, refusalCode: 'qcStale' });
  });
});

describe.each(['crown', 'inlay', 'onlay', 'bridge'] as const)(
  'exportGateVerdict — gate enforcement, falsifiable both ways (%s)',
  (type) => {
    it('REFUSES on hard-failing unacknowledged gates, listing exactly those gates', () => {
      const r = restoration(type, {
        qc: qcReport(
          [
            gate({ gate: 'watertight' }),
            gate({ gate: 'minWallThickness', passed: false, message: 'wall 0.3 mm < 0.5 mm' }),
            gate({ gate: 'seating', passed: false, message: 'penetration' }),
            // An acknowledged failure must NOT appear in the refusal list.
            gate({ gate: 'marginFit', passed: false, acknowledged: true, message: 'acknowledged' }),
          ],
          'final-hash',
        ),
      });
      const verdict = exportGateVerdict(r, []);
      expect(verdict).toEqual({
        allowed: false,
        refusalCode: 'gatesFailing',
        failingGates: ['minWallThickness', 'seating'],
      });
    });

    it('ALLOWS the same report once every failing gate is acknowledged, with acknowledgments + journal refs riding along', () => {
      const r = restoration(type, {
        qc: qcReport(
          [
            gate({ gate: 'watertight' }),
            gate({
              gate: 'seating',
              passed: false,
              acknowledged: true,
              value: 0.0616,
              threshold: 1e-6,
              unit: 'mm3',
              message: 'seating interference acknowledged',
            }),
          ],
          'final-hash',
        ),
      });
      const history = [ackOp(ACK_OP_NAME[type], r.id, ['seating'], 'ack-op-1')];
      const verdict = exportGateVerdict(r, history);
      expect(verdict).toEqual({
        allowed: true,
        finalMeshHash: 'final-hash',
        acknowledgments: [
          {
            gate: 'seating',
            message: 'seating interference acknowledged',
            value: 0.0616,
            threshold: 1e-6,
            unit: 'mm3',
            operationId: 'ack-op-1',
          },
        ],
      });
    });
  },
);

describe('collectAcknowledgments — journal refs', () => {
  const acknowledgedReport = qcReport(
    [gate({ gate: 'seating', passed: false, acknowledged: true, message: 'ack' })],
    'final-hash',
  );

  it('resolves the LAST matching *-qc-ack op for this restoration and gate', () => {
    const r = restoration('onlay', { qc: acknowledgedReport });
    const history = [
      ackOp('inlay-qc-ack', r.id, ['seating'], 'older'),
      ackOp('inlay-qc-ack', r.id, ['seating'], 'newest'),
    ];
    expect(collectAcknowledgments(r, history)[0]!.operationId).toBe('newest');
  });

  it('never matches another restoration\'s ack op, and reports null when no op exists (defensive, flagged to the server)', () => {
    const r = restoration('onlay', { qc: acknowledgedReport });
    const foreign = [ackOp('inlay-qc-ack', 'someone-else', ['seating'], 'foreign')];
    expect(collectAcknowledgments(r, foreign)[0]!.operationId).toBeNull();
    expect(collectAcknowledgments(r, [])[0]!.operationId).toBeNull();
  });

  it('matches an ack op that recorded the gate only in its acknowledgedGates list', () => {
    const r = restoration('crown', { qc: acknowledgedReport });
    const history = [
      {
        ...ackOp('crown-qc-ack', r.id, ['seating', 'marginFit'], 'multi'),
        params: { restorationId: r.id, acknowledgedGates: ['seating', 'marginFit'] },
      },
    ];
    expect(collectAcknowledgments(r, history)[0]!.operationId).toBe('multi');
  });

  it('returns [] for a report with no acknowledged gates', () => {
    const r = restoration('crown', { qc: qcReport([gate({ gate: 'watertight' })], 'final-hash') });
    expect(collectAcknowledgments(r, [])).toEqual([]);
  });
});

describe('isExportRecordStale — the P5-T8 cascade discipline extended to exports', () => {
  const freshQc = qcReport([gate({ gate: 'watertight' })], 'final-hash');
  const record = { finalMeshHash: 'final-hash' };

  it('a record matching the current finalMesh with fresh QC is NOT stale', () => {
    expect(isExportRecordStale(restoration('crown', { qc: freshQc }), record)).toBe(false);
  });

  it('goes stale when the design changed (finalMesh hash moved or cleared)', () => {
    expect(
      isExportRecordStale(restoration('crown', { stages: { finalMesh: 'new-hash' }, qc: freshQc }), record),
    ).toBe(true);
    expect(isExportRecordStale(restoration('crown', { stages: {}, qc: null }), record)).toBe(true);
  });

  it('goes stale when the QC authorizing it was invalidated or superseded', () => {
    expect(isExportRecordStale(restoration('crown', { qc: null }), record)).toBe(true);
    expect(
      isExportRecordStale(
        restoration('crown', { qc: qcReport([gate({ gate: 'watertight' })], 'other-hash') }),
        record,
      ),
    ).toBe(true);
  });

  it('a vanished restoration is stale', () => {
    expect(isExportRecordStale(undefined, record)).toBe(true);
  });
});

describe('EXPORT_REFUSAL_I18N_KEY — every refusal is an i18n\'d visible state (×4 locales)', () => {
  function resolve(resource: unknown, keyPath: string): unknown {
    return keyPath.split('.').reduce<unknown>((node, part) => {
      if (typeof node !== 'object' || node === null) return undefined;
      return (node as Record<string, unknown>)[part];
    }, resource);
  }

  const codes: ExportRefusalCode[] = [
    'noFinalMesh',
    'qcMissing',
    'qcStale',
    'gatesFailing',
    'finalMeshUnavailable',
  ];

  it.each(codes)('refusal code "%s" maps to a real key in en/hu/de/es', (code) => {
    const key = EXPORT_REFUSAL_I18N_KEY[code];
    expect(key).toMatch(/^export\./);
    for (const [locale, resource] of Object.entries({ en, hu, de, es })) {
      const value = resolve(resource, key);
      expect(typeof value, `${locale}:${key}`).toBe('string');
      expect((value as string).length, `${locale}:${key}`).toBeGreaterThan(0);
    }
  });
});
