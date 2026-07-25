// apps/server/src/crown-persistence.test.ts
//
// Phase 4 Task 11 — crown persistence + server-side journal replay.
//   - A CaseDocument whose restoration carries populated `stages` (mesh
//     content hashes) + a `qc` QcReport round-trips through PUT then GET
//     losslessly (deep-equal).
//   - Journal replay: re-running the crown SHELL stage server-side (via
//     `replayShellStage`, the same cad-pipeline the client uses) reproduces the
//     stored `stages.finalMesh` hash and the stage `Operation.outputHashes` —
//     the reproducibility invariant, server-checked.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { KERNEL_VERSION } from '@dqcad/kernel';
import type { CaseDocument, QcReport } from '@dqcad/shared-types';
import { buildApp } from './app.js';
import { createEmptyCaseDocument } from './case-document.js';
import { buildShell, PROFILE, TOOTH, type BuiltShell } from './crown-qc-fixture.testutil.js';
import { replayShellStage } from './journal-replay.js';

// A representative QcReport (hand-crafted — the point here is that the qc SHAPE
// round-trips losslessly, so no geometry needed for THIS field).
const QC_REPORT: QcReport = {
  gates: [
    { gate: 'watertight', passed: true, acknowledged: false, value: null, threshold: null, unit: null, message: 'watertight' },
    { gate: 'minWallThickness', passed: true, acknowledged: false, value: 0.62, threshold: 0.5, unit: 'mm', message: 'min wall 0.62 mm ≥ 0.5 mm' },
    { gate: 'marginFit', passed: false, acknowledged: true, value: 0.013, threshold: 0.01, unit: 'mm', message: 'margin fit 13 µm > 10 µm (acknowledged)' },
  ],
  passed: true,
  kernelVersion: KERNEL_VERSION,
  profileVersion: '1.1.0',
  journalHash: 'journal-hash-fixed',
};

describe('crown persistence + server-side journal replay', () => {
  let app: FastifyInstance;
  let meshDataDir: string;
  let toothLibraryDataDir: string;
  let shell: BuiltShell;

  beforeAll(async () => {
    meshDataDir = mkdtempSync(join(tmpdir(), 'dqcad-persist-mesh-'));
    toothLibraryDataDir = mkdtempSync(join(tmpdir(), 'dqcad-persist-tooth-'));
    app = await buildApp({ meshDataDir, toothLibraryDataDir });
    shell = await buildShell('standin');
  }, 300_000);

  afterAll(async () => {
    await app.close();
    rmSync(meshDataDir, { recursive: true, force: true });
    rmSync(toothLibraryDataDir, { recursive: true, force: true });
  });

  function crownDocument(id: string, createdAt: string): CaseDocument {
    const finalHash = shell.result.meshContentHash!;
    return {
      ...createEmptyCaseDocument(id, createdAt),
      restorations: [
        {
          id: 'restoration-crown-1',
          type: 'crown',
          teeth: [TOOTH],
          pontics: [],
          targetNodeId: null,
          marginLines: {},
          insertionAxis: [0, 0, 1],
          params: { ...PROFILE.restorationParams },
          stages: {
            innerSurface: shell.innerHandle.contentHash,
            finalMesh: finalHash,
          },
          qc: QC_REPORT,
        },
      ],
      history: [
        {
          id: 'op-shell-1',
          name: shell.result.operationName,
          params: shell.result.params,
          inputHashes: [...shell.result.inputHashes],
          outputHashes: [finalHash],
          kernelVersion: KERNEL_VERSION,
          timestamp: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
  }

  it('round-trips a restoration with populated stages + qc through PUT then GET (lossless)', async () => {
    const created = await app
      .inject({ method: 'POST', url: '/api/cases', payload: { name: 'Crown persistence case' } })
      .then((r) => r.json() as { id: string; createdAt: string });

    const document = crownDocument(created.id, created.createdAt);

    const putRes = await app.inject({ method: 'PUT', url: `/api/cases/${created.id}`, payload: document });
    expect(putRes.statusCode).toBe(200);

    const getRes = await app.inject({ method: 'GET', url: `/api/cases/${created.id}` });
    expect(getRes.statusCode).toBe(200);
    const restored = getRes.json() as CaseDocument;
    expect(restored).toEqual(document);

    // Explicitly assert the Task-11 fields survived.
    expect(restored.restorations[0]!.stages).toEqual(document.restorations[0]!.stages);
    expect(restored.restorations[0]!.qc).toEqual(QC_REPORT);
  });

  it('server-side journal replay reproduces the stored stages.finalMesh hash + the Operation.outputHashes', async () => {
    const finalHash = shell.result.meshContentHash!;

    const replay = await replayShellStage(shell.context, TOOTH, {
      outerAnatomyMesh: shell.outerHandle,
      innerSurfaceMesh: shell.innerHandle,
    });

    // Re-running the stage op in the Node/server runtime reproduces the hash.
    expect(replay.meshContentHash).toBe(finalHash);
    expect(replay.inputHashes).toEqual([...shell.result.inputHashes]);

    // …and that hash is exactly what a persisted document records.
    const document = crownDocument('replay-id', '2026-01-01T00:00:00.000Z');
    expect(document.restorations[0]!.stages.finalMesh).toBe(replay.meshContentHash);
    expect(document.history[0]!.outputHashes).toEqual([replay.meshContentHash]);
  }, 120_000);

  it('replay is deterministic: two server-side re-runs produce the identical hash', async () => {
    const a = await replayShellStage(shell.context, TOOTH, {
      outerAnatomyMesh: shell.outerHandle,
      innerSurfaceMesh: shell.innerHandle,
    });
    const b = await replayShellStage(shell.context, TOOTH, {
      outerAnatomyMesh: shell.outerHandle,
      innerSurfaceMesh: shell.innerHandle,
    });
    expect(a.meshContentHash).toBe(b.meshContentHash);
  }, 120_000);
});
