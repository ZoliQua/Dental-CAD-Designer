// apps/client/src/engine/exportFlow.test.ts
//
// Phase 7 Task 3 — the export CONTROLLER (engine/exportFlow.ts): the
// journaled, gate-enforced export action + the Task 4 request assembly +
// the per-restoration export status store surface.
//
// Falsifiability discipline:
//  - every refusal path is exercised AND asserted VISIBLE (a published
//    `refused` snapshot with an i18n-mapped code — never a silent return);
//  - gate enforcement is proven BOTH ways at the action level for all three
//    workflow types (crown / inlay / bridge): failing-unacknowledged →
//    refused with the gate list; acknowledged → exported;
//  - the journaled op is asserted complete (params + input mesh hash +
//    output BYTES hash + kernel version);
//  - the stale-after-edit cascade is demonstrated (done → stale on a design
//    edit), and `buildExportRequest` refuses a stale export;
//  - one end-to-end integration drives the REAL cavity design engine
//    (fake worker pool) through fit→…→shell→QC→ack and exports through the
//    DEFAULT final-mesh source (no test seam), proving the engine wiring.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { hashCaseJournal, KERNEL_VERSION } from '@dqcad/kernel-workers';
import { STANDARD_ZIRCONIA_PROFILE } from '@dqcad/clinical-profiles';
import type { Operation, QcGateResult, QcReport, Restoration, RestorationType } from '@dqcad/shared-types';
import { caseStore } from './caseStore';
import { createRestoration } from './restorations';
import { marginCircleVecs } from './crownGeometry';
import { cavityDesignEngine, type RunnablePool } from './cavityDesign';
import {
  ExportRequestUnavailableError,
  exportFlowEngine,
} from './exportFlow';
import { useExportStore, selectExportStatus, IDLE_EXPORT_STATUS } from '../state/exportStore';
import type { MeshStats } from './repair';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function gate(overrides: Partial<QcGateResult> & { gate: string }): QcGateResult {
  return { passed: true, acknowledged: false, value: null, threshold: null, unit: null, message: 'ok', ...overrides };
}

function qcReport(gates: QcGateResult[], journalHash: string): QcReport {
  return {
    gates,
    passed: gates.every((g) => g.passed || g.acknowledged),
    kernelVersion: KERNEL_VERSION,
    profileVersion: '1.4.0',
    journalHash,
  };
}

const FINAL = {
  positions: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
  indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]),
  contentHash: 'final-hash',
};

/** Seed a restoration of `type` with a committed finalMesh + a QC report. */
function seedRestoration(
  type: RestorationType,
  qc: QcReport | null,
  stages: Restoration['stages'] = { finalMesh: FINAL.contentHash },
): string {
  const restoration = createRestoration({
    type,
    teeth: type === 'bridge' ? [14, 15, 16] : [16],
    ...(type === 'bridge' ? { pontics: [15] } : {}),
    targetNodeId: null,
  });
  caseStore.updateRestoration(
    { ...restoration, stages, qc },
    {
      id: `seed-${restoration.id}`,
      name: 'test-seed',
      params: { restorationId: restoration.id },
      inputHashes: [],
      outputHashes: [],
      kernelVersion: KERNEL_VERSION,
      timestamp: new Date(0).toISOString(),
    },
  );
  return restoration.id;
}

function ackOpFor(type: RestorationType, restorationId: string, gateId: string, id: string): Operation {
  const name = type === 'crown' ? 'crown-qc-ack' : type === 'bridge' ? 'bridge-qc-ack' : 'inlay-qc-ack';
  return {
    id,
    name,
    params: { restorationId, acknowledgedGate: gateId, acknowledgedGates: [gateId] },
    inputHashes: [FINAL.contentHash],
    outputHashes: [],
    kernelVersion: KERNEL_VERSION,
    timestamp: new Date(0).toISOString(),
  };
}

function status(restorationId: string) {
  return selectExportStatus(useExportStore.getState(), restorationId);
}

function exportOps(): Operation[] {
  return caseStore.getDocument().history.filter((o) => o.name === 'restoration-export');
}

/** Deterministic fake export pool: bytes derived purely from the payload, so
 * "same inputs ⇒ same bytes/hash" holds for wiring-level replay assertions
 * (the REAL byte determinism is proven at the io/job layer + golden replay). */
class FakeExportPool {
  calls: Array<{ job: string; payload: Record<string, unknown> }> = [];
  failNext: Error | null = null;
  base64Sentinel: string | null = null;

  readonly run: RunnablePool['run'] = (async (job: string, payload: unknown): Promise<unknown> => {
    this.calls.push({ job, payload: payload as Record<string, unknown> });
    if (job !== 'exportRestorationMesh') throw new Error(`FakeExportPool: unexpected job ${job}`);
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    const p = payload as { positions: Float64Array; format: 'stl' | 'ply'; headerText?: string };
    const header = new TextEncoder().encode(`${p.format}:${p.headerText ?? ''}:`);
    const body = new Uint8Array(p.positions.buffer.slice(0));
    const bytes = new Uint8Array(header.length + body.length);
    bytes.set(header, 0);
    bytes.set(body, header.length);
    const bytesSha256 = createHash('sha256').update(bytes).digest('hex');
    // `base64Sentinel` (when set) proves buildExportRequest passes the
    // WORKER's encoding through verbatim rather than re-encoding
    // main-thread (P7-T3 review F3).
    const bytesBase64 = this.base64Sentinel ?? Buffer.from(bytes).toString('base64');
    return { bytes, bytesSha256, bytesBase64, byteLength: bytes.byteLength, triangleCount: p.positions.length / 9 };
  }) as RunnablePool['run'];
}

let pool: FakeExportPool;

beforeEach(() => {
  caseStore.resetForTests();
  exportFlowEngine.resetForTests();
  pool = new FakeExportPool();
  exportFlowEngine.__setPoolForTests(pool);
  exportFlowEngine.__setFinalMeshSourceForTests(() => FINAL);
});
afterEach(() => {
  exportFlowEngine.resetForTests();
  caseStore.resetForTests();
});

// ---------------------------------------------------------------------------
// refusal paths — every one VISIBLE, no job dispatched, nothing journaled
// ---------------------------------------------------------------------------

describe('exportRestoration — refusal ladder is published, never silent', () => {
  it('refuses with noFinalMesh when no final solid exists', async () => {
    const id = seedRestoration('crown', null, {});
    await exportFlowEngine.exportRestoration(id, { format: 'stl' });
    expect(status(id)).toMatchObject({ state: 'refused', refusalCode: 'noFinalMesh', failingGates: [] });
    expect(pool.calls).toHaveLength(0);
    expect(exportOps()).toHaveLength(0);
  });

  it('refuses with qcMissing / qcStale', async () => {
    const missing = seedRestoration('crown', null);
    await exportFlowEngine.exportRestoration(missing, { format: 'stl' });
    expect(status(missing)).toMatchObject({ state: 'refused', refusalCode: 'qcMissing' });

    const stale = seedRestoration('crown', qcReport([gate({ gate: 'watertight' })], 'an-old-hash'));
    await exportFlowEngine.exportRestoration(stale, { format: 'stl' });
    expect(status(stale)).toMatchObject({ state: 'refused', refusalCode: 'qcStale' });
    expect(pool.calls).toHaveLength(0);
  });

  it('refuses with finalMeshUnavailable when no live session holds the final solid', async () => {
    exportFlowEngine.__setFinalMeshSourceForTests(() => null);
    const id = seedRestoration('crown', qcReport([gate({ gate: 'watertight' })], FINAL.contentHash));
    await exportFlowEngine.exportRestoration(id, { format: 'stl' });
    expect(status(id)).toMatchObject({ state: 'refused', refusalCode: 'finalMeshUnavailable' });
    expect(pool.calls).toHaveLength(0);
  });

  it('refuses with finalMeshUnavailable when the live session buffers no longer match stages.finalMesh (drift defense)', async () => {
    exportFlowEngine.__setFinalMeshSourceForTests(() => ({ ...FINAL, contentHash: 'drifted-hash' }));
    const id = seedRestoration('crown', qcReport([gate({ gate: 'watertight' })], FINAL.contentHash));
    await exportFlowEngine.exportRestoration(id, { format: 'stl' });
    expect(status(id)).toMatchObject({ state: 'refused', refusalCode: 'finalMeshUnavailable' });
    expect(pool.calls).toHaveLength(0);
    expect(exportOps()).toHaveLength(0);
  });

  it('a missing restoration surfaces as an error state (and throws) — never a silent no-op', async () => {
    await expect(exportFlowEngine.exportRestoration('no-such-id', { format: 'stl' })).rejects.toThrow(
      /no-such-id/,
    );
    expect(status('no-such-id').state).toBe('error');
    expect(status('no-such-id').error).toMatch(/no-such-id/);
  });
});

// ---------------------------------------------------------------------------
// gate enforcement at the action — both directions, all three workflows
// ---------------------------------------------------------------------------

describe.each(['crown', 'inlay', 'bridge'] as const)(
  'exportRestoration — gates block export, falsifiable both ways (%s)',
  (type) => {
    it('REFUSES on a hard-failing unacknowledged gate, publishing the failing-gate list', async () => {
      const id = seedRestoration(
        type,
        qcReport(
          [gate({ gate: 'watertight' }), gate({ gate: 'seating', passed: false, message: 'penetration' })],
          FINAL.contentHash,
        ),
      );
      await exportFlowEngine.exportRestoration(id, { format: 'stl' });
      expect(status(id)).toMatchObject({
        state: 'refused',
        refusalCode: 'gatesFailing',
        failingGates: ['seating'],
      });
      expect(pool.calls).toHaveLength(0);
      expect(exportOps()).toHaveLength(0);
    });

    it('ALLOWS once the gate is acknowledged, journaling the acknowledgment refs on the export op', async () => {
      const id = seedRestoration(
        type,
        qcReport(
          [
            gate({ gate: 'watertight' }),
            gate({ gate: 'seating', passed: false, acknowledged: true, message: 'ack', value: 0.06, threshold: 1e-6, unit: 'mm3' }),
          ],
          FINAL.contentHash,
        ),
      );
      caseStore.appendOperation(ackOpFor(type, id, 'seating', `ack-${type}`));
      await exportFlowEngine.exportRestoration(id, { format: 'stl' });

      expect(status(id).state).toBe('done');
      const ops = exportOps();
      expect(ops).toHaveLength(1);
      expect(ops[0]!.params).toMatchObject({
        restorationId: id,
        restorationType: type,
        format: 'stl',
        acknowledgedGates: ['seating'],
        ackOperationIds: [`ack-${type}`],
      });
    });
  },
);

// ---------------------------------------------------------------------------
// the journaled op + worker dispatch mechanics
// ---------------------------------------------------------------------------

describe('exportRestoration — the journaled Operation + worker mechanics', () => {
  function seedPassing(type: RestorationType = 'crown'): string {
    return seedRestoration(type, qcReport([gate({ gate: 'watertight' })], FINAL.contentHash));
  }

  it('journals ONE restoration-export op: params + input mesh hash + output BYTES hash + kernel version', async () => {
    const id = seedPassing();
    await exportFlowEngine.exportRestoration(id, { format: 'stl' });
    const ops = exportOps();
    expect(ops).toHaveLength(1);
    const op = ops[0]!;
    expect(op.inputHashes).toEqual([FINAL.contentHash]);
    expect(op.outputHashes).toEqual([status(id).bytesSha256]);
    expect(op.kernelVersion).toBe(KERNEL_VERSION);
    expect(op.params).toMatchObject({
      restorationId: id,
      restorationType: 'crown',
      teeth: [16],
      format: 'stl',
      byteLength: status(id).byteLength,
      acknowledgedGates: [],
      ackOperationIds: [],
    });
    expect(typeof op.params.headerText).toBe('string');
    expect((op.params.headerText as string).length).toBeLessThanOrEqual(80);
    expect((op.params.headerText as string).startsWith('solid')).toBe(false);
  });

  it('headerText is a pure function of journaled params (type + teeth), and the exact string reaches the job', async () => {
    const id = seedPassing();
    await exportFlowEngine.exportRestoration(id, { format: 'stl' });
    const op = exportOps()[0]!;
    const dispatched = pool.calls[0]!.payload;
    expect(dispatched.headerText).toBe(op.params.headerText);
    expect(op.params.headerText).toContain('crown');
    expect(op.params.headerText).toContain('16');
    expect(op.params.headerText).toContain('units=mm');
  });

  it('a PLY export journals no headerText and dispatches none', async () => {
    const id = seedPassing();
    await exportFlowEngine.exportRestoration(id, { format: 'ply' });
    const op = exportOps()[0]!;
    expect('headerText' in op.params).toBe(false);
    expect(pool.calls[0]!.payload.headerText).toBeUndefined();
    expect(status(id)).toMatchObject({ state: 'done', format: 'ply' });
  });

  it('dispatches PRIVATE COPIES of the session buffers (the live master is never transferred/detached)', async () => {
    const id = seedPassing();
    await exportFlowEngine.exportRestoration(id, { format: 'stl' });
    const dispatched = pool.calls[0]!.payload as { positions: Float64Array; indices: Uint32Array };
    expect(dispatched.positions).not.toBe(FINAL.positions);
    expect(dispatched.indices).not.toBe(FINAL.indices);
    expect(Array.from(dispatched.positions)).toEqual(Array.from(FINAL.positions));
    // The session master survives (a transfer of the master would detach it).
    expect(FINAL.positions.byteLength).toBeGreaterThan(0);
  });

  it('re-exporting the same design produces the same bytes hash (wiring-level replay: pure function of journaled inputs)', async () => {
    const id = seedPassing();
    await exportFlowEngine.exportRestoration(id, { format: 'stl' });
    const first = status(id).bytesSha256;
    await exportFlowEngine.exportRestoration(id, { format: 'stl' });
    expect(status(id).bytesSha256).toBe(first);
    expect(exportOps()).toHaveLength(2); // each export is a real journaled event
    expect(exportOps().map((o) => o.outputHashes[0])).toEqual([first, first]);
  });

  it('a worker failure surfaces as an error state and rethrows; nothing is journaled', async () => {
    const id = seedPassing();
    const boom = new Error('narrowed-volume flip');
    boom.name = 'ExportMeshInvalidError';
    pool.failNext = boom;
    await expect(exportFlowEngine.exportRestoration(id, { format: 'stl' })).rejects.toBe(boom);
    expect(status(id)).toMatchObject({ state: 'error' });
    expect(status(id).error).toMatch(/ExportMeshInvalidError/);
    expect(exportOps()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// stale-after-edit invalidation (the P5-T8 cascade discipline)
// ---------------------------------------------------------------------------

describe('exportRestoration — stale-after-edit invalidation', () => {
  it('a design edit after an export flips the status to stale (and back to done if the exact state returns)', async () => {
    const id = seedRestoration('crown', qcReport([gate({ gate: 'watertight' })], FINAL.contentHash));
    await exportFlowEngine.exportRestoration(id, { format: 'stl' });
    expect(status(id).state).toBe('done');

    // Simulate the per-workflow invalidation cascade: an upstream re-run
    // rewrites finalMesh and nulls qc.
    const edited = caseStore.getDocument().restorations.find((r) => r.id === id)!;
    caseStore.updateRestoration(
      { ...edited, stages: { finalMesh: 'new-final-hash' }, qc: null },
      { id: 'edit', name: 'crown-shell', params: { restorationId: id }, inputHashes: [], outputHashes: ['new-final-hash'], kernelVersion: KERNEL_VERSION, timestamp: new Date(0).toISOString() },
    );
    expect(status(id).state).toBe('stale');
    // The recorded bytes identity stays visible for the panel.
    expect(status(id).bytesSha256).not.toBeNull();

    // Restoring the exact exported state (same finalMesh + fresh QC) derives
    // back to done — the status is hash-derived, not event-flag-driven.
    const restored = caseStore.getDocument().restorations.find((r) => r.id === id)!;
    caseStore.updateRestoration(
      { ...restored, stages: { finalMesh: FINAL.contentHash }, qc: qcReport([gate({ gate: 'watertight' })], FINAL.contentHash) },
      { id: 'restore', name: 'crown-shell', params: { restorationId: id }, inputHashes: [], outputHashes: [FINAL.contentHash], kernelVersion: KERNEL_VERSION, timestamp: new Date(0).toISOString() },
    );
    expect(status(id).state).toBe('done');
  });

  it('F1 regression: a plain QC re-run that RESETS acknowledgments (same mesh, same journalHash) de-authorizes the export — status leaves done and buildExportRequest refuses', async () => {
    // Export with an acknowledged failing gate → done (the legitimate path).
    const id = seedRestoration(
      'onlay',
      qcReport(
        [gate({ gate: 'watertight' }), gate({ gate: 'seating', passed: false, acknowledged: true, message: 'ack' })],
        FINAL.contentHash,
      ),
    );
    caseStore.appendOperation(ackOpFor('onlay', id, 'seating', 'ack-f1'));
    await exportFlowEngine.exportRestoration(id, { format: 'stl' });
    expect(status(id).state).toBe('done');

    // A plain (non-ack) QC re-run on the SAME mesh: the engines pass no
    // acknowledgedGates, so the fresh report resets `acknowledged` to false
    // while `journalHash` stays equal (the mesh is unchanged).
    const r = caseStore.getDocument().restorations.find((x) => x.id === id)!;
    caseStore.updateRestoration(
      {
        ...r,
        qc: qcReport(
          [gate({ gate: 'watertight' }), gate({ gate: 'seating', passed: false, acknowledged: false, message: 'penetration' })],
          FINAL.contentHash,
        ),
      },
      { id: 'rerun-f1', name: 'inlay-qc', params: { restorationId: id }, inputHashes: [FINAL.contentHash], outputHashes: [], kernelVersion: KERNEL_VERSION, timestamp: new Date(0).toISOString() },
    );

    // The export is no longer AUTHORIZED by the current report — the status
    // must honestly leave `done`, and the request seam must refuse.
    expect(status(id).state).toBe('stale');
    await expect(exportFlowEngine.buildExportRequest(id)).rejects.toBeInstanceOf(
      ExportRequestUnavailableError,
    );
  });

  it('removing the restoration flips the export stale', async () => {
    const id = seedRestoration('crown', qcReport([gate({ gate: 'watertight' })], FINAL.contentHash));
    await exportFlowEngine.exportRestoration(id, { format: 'stl' });
    caseStore.removeRestoration(id, {
      id: 'rm', name: 'restoration-delete', params: { restorationId: id }, inputHashes: [], outputHashes: [], kernelVersion: KERNEL_VERSION, timestamp: new Date(0).toISOString(),
    });
    expect(status(id).state).toBe('stale');
    await expect(exportFlowEngine.buildExportRequest(id)).rejects.toThrow(/no longer exists/);
  });

  // MEDIUM: a case SWITCH/close (a document publish carrying a DIFFERENT case
  // id) must release the previous case's held export buffers — each retains the
  // full serialized bytes + base64 (multi-MB) keyed by restoration UUID, so
  // without this a session opening several cases and exporting in each leaks
  // every case's bytes for the whole session. Falsifiable via `buildExportRequest`:
  // once the held buffer is released, it reports "nothing has been exported yet"
  // (pre-fix the buffer lingers and it instead reports "no longer exists").
  it('releases held export buffers on a case switch (no multi-MB cross-case leak)', async () => {
    const id = seedRestoration('crown', qcReport([gate({ gate: 'watertight' })], FINAL.contentHash));
    await exportFlowEngine.exportRestoration(id, { format: 'stl' });
    expect(status(id).state).toBe('done');
    // Sanity: while the case is open, the held bytes assemble a request.
    await expect(exportFlowEngine.buildExportRequest(id)).resolves.toBeDefined();

    // A case switch/close: openCase/createCase install a DIFFERENT case's
    // document (new id). Reproduced here with a bare loadDocument of another
    // case id.
    caseStore.loadDocument({ ...caseStore.getDocument(), id: 'another-case', restorations: [] });

    await expect(exportFlowEngine.buildExportRequest(id)).rejects.toThrow(/nothing has been exported yet/);
  });
});

// ---------------------------------------------------------------------------
// buildExportRequest — the Task 4 currency
// ---------------------------------------------------------------------------

describe('buildExportRequest — the typed server-request assembly seam', () => {
  it('assembles the full RestorationExportRequest from a fresh export', async () => {
    const id = seedRestoration(
      'onlay',
      qcReport(
        [gate({ gate: 'watertight' }), gate({ gate: 'seating', passed: false, acknowledged: true, message: 'ack' })],
        FINAL.contentHash,
      ),
    );
    caseStore.appendOperation(ackOpFor('onlay', id, 'seating', 'ack-onlay'));
    await exportFlowEngine.exportRestoration(id, { format: 'stl' });
    const request = await exportFlowEngine.buildExportRequest(id);
    const document = caseStore.getDocument();
    const restoration = document.restorations.find((r) => r.id === id)!;

    expect(request.schemaVersion).toBe(1);
    expect(request.caseId).toBe(document.id);
    expect(request.restorationId).toBe(id);
    expect(request.restorationType).toBe('onlay');
    expect(request.teeth).toEqual([16]);
    expect(request.format).toBe('stl');
    expect(request.headerText).toBe(exportOps()[0]!.params.headerText);
    expect(request.meshContentHash).toBe(FINAL.contentHash);
    expect(request.exportOperationId).toBe(exportOps()[0]!.id);
    expect(request.bytesSha256).toBe(status(id).bytesSha256);
    expect(request.byteLength).toBe(status(id).byteLength);
    // The base64 payload decodes to the EXACT exported bytes.
    const decoded = Buffer.from(request.bytesBase64, 'base64');
    expect(createHash('sha256').update(decoded).digest('hex')).toBe(request.bytesSha256);
    expect(decoded.byteLength).toBe(request.byteLength);
    expect(request.qcReport).toEqual(restoration.qc);
    expect(request.acknowledgments).toEqual([
      { gate: 'seating', message: 'ack', value: null, threshold: null, unit: null, operationId: 'ack-onlay' },
    ]);
    // The journal hash covers the FULL current journal (export op included).
    await expect(hashCaseJournal(document.history)).resolves.toBe(request.caseJournalHash);
    expect(request.journalOperationCount).toBe(document.history.length);
    expect(request.materialProfile).toEqual({
      id: STANDARD_ZIRCONIA_PROFILE.id,
      version: STANDARD_ZIRCONIA_PROFILE.version,
      checksum: STANDARD_ZIRCONIA_PROFILE.checksum,
    });
    expect(request.kernelVersion).toBe(KERNEL_VERSION);
  });

  it('F3: bytesBase64 is the WORKER-encoded value passed through verbatim (no main-thread re-encode)', async () => {
    const id = seedRestoration('crown', qcReport([gate({ gate: 'watertight' })], FINAL.contentHash));
    pool.base64Sentinel = 'WORKER-SENTINEL-NOT-A-REAL-ENCODING';
    await exportFlowEngine.exportRestoration(id, { format: 'stl' });
    const request = await exportFlowEngine.buildExportRequest(id);
    // A main-thread re-encode of the bytes could never produce the sentinel.
    expect(request.bytesBase64).toBe('WORKER-SENTINEL-NOT-A-REAL-ENCODING');
  });

  it('throws a typed error when nothing was exported, and when the export went stale', async () => {
    const id = seedRestoration('crown', qcReport([gate({ gate: 'watertight' })], FINAL.contentHash));
    await expect(exportFlowEngine.buildExportRequest(id)).rejects.toBeInstanceOf(
      ExportRequestUnavailableError,
    );

    await exportFlowEngine.exportRestoration(id, { format: 'stl' });
    const edited = caseStore.getDocument().restorations.find((r) => r.id === id)!;
    caseStore.updateRestoration(
      { ...edited, stages: { finalMesh: 'moved' }, qc: null },
      { id: 'edit2', name: 'crown-shell', params: { restorationId: id }, inputHashes: [], outputHashes: ['moved'], kernelVersion: KERNEL_VERSION, timestamp: new Date(0).toISOString() },
    );
    await expect(exportFlowEngine.buildExportRequest(id)).rejects.toBeInstanceOf(
      ExportRequestUnavailableError,
    );
  });

  it('refuses when the design moved to a NEW mesh whose fresh QC passes (verdict allows, but not for THESE bytes)', async () => {
    const id = seedRestoration('crown', qcReport([gate({ gate: 'watertight' })], FINAL.contentHash));
    await exportFlowEngine.exportRestoration(id, { format: 'stl' });
    const edited = caseStore.getDocument().restorations.find((r) => r.id === id)!;
    caseStore.updateRestoration(
      // New finalMesh WITH a fresh, passing QC for it — the gate verdict is
      // `allowed` for the document, yet the held bytes serialize the OLD mesh.
      { ...edited, stages: { finalMesh: 'new-mesh' }, qc: qcReport([gate({ gate: 'watertight' })], 'new-mesh') },
      { id: 'edit3', name: 'crown-shell', params: { restorationId: id }, inputHashes: [], outputHashes: ['new-mesh'], kernelVersion: KERNEL_VERSION, timestamp: new Date(0).toISOString() },
    );
    await expect(exportFlowEngine.buildExportRequest(id)).rejects.toThrow(/stale/);
  });
});

// ---------------------------------------------------------------------------
// store surface defaults
// ---------------------------------------------------------------------------

describe('export store surface', () => {
  it('an untouched restoration reads as idle', () => {
    expect(status('never-touched')).toEqual(IDLE_EXPORT_STATUS);
  });
});

// ---------------------------------------------------------------------------
// integration: the REAL cavity workflow through the DEFAULT final-mesh source
// ---------------------------------------------------------------------------

const STATS: MeshStats = {
  watertight: true,
  manifoldEdges: true,
  componentCount: 1,
  bbox: { min: [-5, -5, 0], max: [5, 5, 8] },
  surfaceAreaMm2: 1,
  signedVolumeMm3: 1,
  degenerateCount: 0,
  boundaryEdgeCount: 0,
};
const REPORT = { weldEpsilonMm: 1e-6, steps: [] };

function tetra(tag: number): { positions: Float64Array; indices: Uint32Array } {
  return {
    positions: Float64Array.from([tag, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]),
  };
}

/** Trimmed clone of cavityDesign.test.ts's FakePool (fit→patch→contacts→
 * shell→QC) + the export job — enough to drive the REAL cavity engine to an
 * acknowledged QC report and export through the default source. */
class FakeCavityPool {
  private hashCounter = 0;
  failingGate: string | null = 'seating';

  readonly run: RunnablePool['run'] = (async (job: string, payload: unknown): Promise<unknown> => {
    switch (job) {
      case 'buildBvh':
        return {};
      case 'hashMesh':
        this.hashCounter += 1;
        return { contentHash: `hash-${this.hashCounter}` };
      case 'cavityInnerSurface':
        return { ...tetra(2), stats: STATS, errorBoundMm: 0.006, flatZoneErrorBoundMm: 0.004, patchTriangleCount: 40, skirtTriangleCount: 12, marginVertexCount: 80, marginalGapMm: 0.02, cementGapMm: 0.05, spacerStartMm: 0.8, blendWidthMm: 0.3, pitchMm: 0.06 };
      case 'cavityOcclusalPatch':
        return {
          ...tetra(3),
          stats: STATS,
          seamEdges: [{ a: [0, 0, 0], b: [1, 0, 0], segment: 0 }],
          freeEdges: [],
          proximalFaces: [
            { columnPoints: [[-5, -1, 6], [-5, 0, 6]], freeRunPoints: [[-5, -1, 6]] },
            { columnPoints: [[5, -1, 6], [5, 0, 6]], freeRunPoints: [[5, -1, 6]] },
          ],
          cavityTriangleIndices: Uint32Array.from([0, 1]),
          seamDihedralMaxDeg: 2.3,
          seamDihedralMeanDeg: 1.1,
          seamDihedralBoundDeg: 5,
          patchTriangleCount: 60,
          crossSegments: 8,
          seamSurroundingMaxAngleDeg: 30,
        };
      case 'cavityProximalContact':
        return {
          ...tetra(4),
          boxes: [
            { label: 'mesial', targetPenetrationMm: 0.02, initialSignedDistanceMm: 0.1, travelMm: 0.12, clampBound: false, approachDirection: [1, 0, 0], achievedSignedDistanceMm: -0.02, contactResidualMm: 0.001, faceMinSignedDistanceMm: -0.02, faceResidualMm: 0.002, movedVertexCount: 5 },
            { label: 'distal', targetPenetrationMm: 0.02, initialSignedDistanceMm: 0.1, travelMm: 0.12, clampBound: false, approachDirection: [-1, 0, 0], achievedSignedDistanceMm: -0.02, contactResidualMm: 0.001, faceMinSignedDistanceMm: -0.02, faceResidualMm: 0.002, movedVertexCount: 5 },
          ],
          clampedBoxes: [],
          errorBoundMm: 0.001,
          maxTravelMm: 0.5,
          seamAnchorBandMm: 0.2,
          seamDihedralMaxBeforeDeg: 2.3,
          seamDihedralMeanBeforeDeg: 1.1,
          seamDihedralMaxAfterDeg: 2.4,
          seamDihedralMeanAfterDeg: 1.2,
        };
      case 'cavityShell':
        return { ...tetra(5), watertight: true, componentCount: 1, seamRingVertexCount: 80, fitTriangleCount: 40, patchTriangleCount: 60, volumeMm3: 22.5 };
      case 'runInlayQc': {
        const acknowledged = (payload as { acknowledgedGates?: string[] }).acknowledgedGates ?? [];
        const gates = [
          { gate: 'watertight', passed: true, acknowledged: false, value: null, threshold: null, unit: null, message: 'ok' },
          this.failingGate
            ? { gate: this.failingGate, passed: false, acknowledged: acknowledged.includes(this.failingGate), value: 0.0616, threshold: 1e-6, unit: 'mm3', message: 'onlay seating interference' }
            : { gate: 'seating', passed: true, acknowledged: false, value: 0, threshold: 1e-6, unit: 'mm3', message: 'ok' },
        ];
        const passed = gates.every((g) => g.passed || g.acknowledged);
        const journalHash = (payload as { journalHash: string }).journalHash;
        return { report: { gates, passed, kernelVersion: KERNEL_VERSION, profileVersion: 'test', journalHash } };
      }
      case 'exportRestorationMesh': {
        const p = payload as { positions: Float64Array; format: string };
        const bytes = new Uint8Array(p.positions.buffer.slice(0));
        return { bytes, bytesSha256: createHash('sha256').update(bytes).digest('hex'), bytesBase64: Buffer.from(bytes).toString('base64'), byteLength: bytes.byteLength, triangleCount: 4 };
      }
      default:
        throw new Error(`FakeCavityPool: unexpected job ${job}`);
    }
  }) as RunnablePool['run'];
}

describe('integration — real cavity engine, default final-mesh source', () => {
  afterEach(() => {
    cavityDesignEngine.resetForTests();
  });

  it('failing gate refuses; acknowledged gate exports through the default source', async () => {
    const cavityPool = new FakeCavityPool();
    cavityDesignEngine.resetForTests();
    cavityDesignEngine.__setPoolForTests(cavityPool);
    exportFlowEngine.__setPoolForTests(cavityPool);
    exportFlowEngine.__setFinalMeshSourceForTests(null); // the DEFAULT source

    // Seed a real inlay case (mirrors cavityDesign.test.ts's setup()).
    caseStore.registerImportedMesh({
      contentHash: 'tooth',
      name: 'tooth.stl',
      format: 'stl',
      positions: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
      indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]),
      stats: STATS,
      report: REPORT,
      operations: [],
    });
    const node = caseStore.addSceneNode('tooth', 'prepDie');
    const restoration = createRestoration({ type: 'inlay', teeth: [16], targetNodeId: node.id });
    caseStore.updateRestoration(
      { ...restoration, marginLines: { 16: { anchors: [], closed: true, resampledPoints: marginCircleVecs(0, 0, 5, 6, 48) } } },
      { id: 'm', name: 'margin-edit', params: {}, inputHashes: [], outputHashes: [], kernelVersion: 'test', timestamp: new Date(0).toISOString() },
    );

    cavityDesignEngine.start(restoration.id);
    await cavityDesignEngine.runFit({ pitchMm: 0.06 });
    await cavityDesignEngine.runPatch();
    await cavityDesignEngine.runContacts();
    await cavityDesignEngine.constructShell();
    await cavityDesignEngine.runQc();

    // Direction 1: the failing 'seating' gate REFUSES the export.
    await exportFlowEngine.exportRestoration(restoration.id, { format: 'stl' });
    expect(status(restoration.id)).toMatchObject({
      state: 'refused',
      refusalCode: 'gatesFailing',
      failingGates: ['seating'],
    });

    // Direction 2: acknowledge (journaled by the cavity engine), then export
    // succeeds through the REAL default final-mesh source.
    await cavityDesignEngine.acknowledgeGate('seating');
    await exportFlowEngine.exportRestoration(restoration.id, { format: 'stl' });
    expect(status(restoration.id).state).toBe('done');
    const op = exportOps()[0]!;
    const current = caseStore.getDocument().restorations.find((r) => r.id === restoration.id)!;
    expect(op.inputHashes).toEqual([current.stages.finalMesh]);
    expect(op.params.acknowledgedGates).toEqual(['seating']);
    // The ack journal ref points at the cavity engine's inlay-qc-ack op.
    const ackOp = caseStore.getDocument().history.find((o) => o.name === 'inlay-qc-ack')!;
    expect(op.params.ackOperationIds).toEqual([ackOp.id]);

    // F1 regression, real engine: a plain runQc() re-run resets the
    // acknowledgment (the engine passes no acknowledgedGates) on the SAME
    // mesh — the completed export must de-authorize, not stay "done".
    await cavityDesignEngine.runQc();
    expect(status(restoration.id).state).toBe('stale');
    await expect(exportFlowEngine.buildExportRequest(restoration.id)).rejects.toBeInstanceOf(
      ExportRequestUnavailableError,
    );
  });
});
