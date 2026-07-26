// apps/server/src/cavity-persistence.test.ts
//
// Phase 5 Task 9 — inlay/onlay persistence + server-side journal replay.
//   - A CaseDocument whose inlay/onlay restoration carries populated CAVITY
//     `stages` (fitSurface/occlusalPatch/proximalContacts/cuspCoverage/finalMesh)
//     + a `qc` QcReport (incl. the onlay's cuspCoverage gate + acknowledged
//     seating) round-trips through PUT then GET losslessly (deep-equal — proving
//     the T8 schema-mirror widening strips NO field).
//   - Journal replay: re-running the INLAY SHELL stage server-side (via
//     `replayCavityShellStage`, the same cad-pipeline the client uses) reproduces
//     the stored `stages.finalMesh` hash + the stage `Operation.outputHashes` —
//     the reproducibility invariant, server-checked.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { runInlayQc } from '@dqcad/cad-pipeline';
import { KERNEL_VERSION } from '@dqcad/kernel';
import type { CaseDocument, QcReport } from '@dqcad/shared-types';
import { buildApp } from './app.js';
import { createEmptyCaseDocument } from './case-document.js';
import { PROFILE } from './crown-qc-fixture.testutil.js';
import { buildInlay, buildOnlay, CAVITY_TOOTH, type BuiltCavityRestoration } from './inlay-qc-fixture.testutil.js';
import { replayCavityShellStage } from './journal-replay.js';

describe('inlay/onlay persistence + server-side journal replay', () => {
  let app: FastifyInstance;
  let meshDataDir: string;
  let toothLibraryDataDir: string;
  let inlay: BuiltCavityRestoration;
  let onlay: BuiltCavityRestoration;
  let onlayReport: QcReport;

  beforeAll(async () => {
    meshDataDir = mkdtempSync(join(tmpdir(), 'dqcad-cavity-persist-mesh-'));
    toothLibraryDataDir = mkdtempSync(join(tmpdir(), 'dqcad-cavity-persist-tooth-'));
    app = await buildApp({ meshDataDir, toothLibraryDataDir });
    inlay = await buildInlay('inlay');
    onlay = await buildOnlay();
    // A REAL onlay QcReport (cuspCoverageThickness gate + ACKNOWLEDGED seating) —
    // the exact kind that lands on Restoration.qc.
    onlayReport = await runInlayQc(onlay.qcInput);
  }, 600_000);

  afterAll(async () => {
    await app.close();
    rmSync(meshDataDir, { recursive: true, force: true });
    rmSync(toothLibraryDataDir, { recursive: true, force: true });
  });

  function inlayDocument(id: string, createdAt: string): CaseDocument {
    const finalHash = inlay.shellResult.meshContentHash!;
    return {
      ...createEmptyCaseDocument(id, createdAt),
      restorations: [
        {
          id: 'restoration-inlay-1',
          type: 'inlay',
          teeth: [CAVITY_TOOTH],
          pontics: [],
          targetNodeId: null,
          marginLines: {},
          insertionAxis: [0, 0, 1],
          params: { ...PROFILE.restorationParams },
          stages: {
            fitSurface: inlay.fitHandle.contentHash,
            occlusalPatch: inlay.patchHandle.contentHash,
            proximalContacts: inlay.patchHandle.contentHash,
            finalMesh: finalHash,
          },
          qc: null,
        },
      ],
      history: [
        {
          id: 'op-cavity-shell-1',
          name: inlay.shellResult.operationName,
          params: inlay.shellResult.params,
          inputHashes: [...inlay.shellResult.inputHashes],
          outputHashes: [finalHash],
          kernelVersion: KERNEL_VERSION,
          timestamp: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
  }

  /** An ONLAY document with a covered-cusp stage AND a real onlay QcReport
   * (cuspCoverage gate + acknowledged seating) — proves those survive PUT/GET. */
  function onlayDocument(id: string, createdAt: string): CaseDocument {
    return {
      ...createEmptyCaseDocument(id, createdAt),
      restorations: [
        {
          id: 'restoration-onlay-1',
          type: 'onlay',
          teeth: [CAVITY_TOOTH],
          pontics: [],
          targetNodeId: null,
          marginLines: {},
          insertionAxis: [0, 0, 1],
          params: { ...PROFILE.restorationParams },
          stages: {
            fitSurface: onlay.fitHandle.contentHash,
            occlusalPatch: onlay.patchHandle.contentHash,
            proximalContacts: onlay.patchHandle.contentHash,
            cuspCoverage: onlay.patchHandle.contentHash,
            finalMesh: onlay.shellResult.meshContentHash!,
          },
          qc: onlayReport,
        },
      ],
    };
  }

  it('round-trips an INLAY restoration with populated cavity stages through PUT then GET (lossless)', async () => {
    const created = await app
      .inject({ method: 'POST', url: '/api/cases', payload: { name: 'Inlay persistence case' } })
      .then((r) => r.json() as { id: string; createdAt: string });

    const document = inlayDocument(created.id, created.createdAt);

    const putRes = await app.inject({ method: 'PUT', url: `/api/cases/${created.id}`, payload: document });
    expect(putRes.statusCode).toBe(200);

    const getRes = await app.inject({ method: 'GET', url: `/api/cases/${created.id}` });
    expect(getRes.statusCode).toBe(200);
    const restored = getRes.json() as CaseDocument;
    expect(restored).toEqual(document);

    // Explicitly assert the cavity stage fields survived (no stripping).
    expect(restored.restorations[0]!.stages).toEqual(document.restorations[0]!.stages);
    expect(restored.restorations[0]!.stages.fitSurface).toBe(inlay.fitHandle.contentHash);
    expect(restored.restorations[0]!.stages.finalMesh).toBe(inlay.shellResult.meshContentHash);
  });

  it('round-trips an ONLAY restoration with cuspCoverage stage + acknowledged qc through PUT then GET (lossless)', async () => {
    const created = await app
      .inject({ method: 'POST', url: '/api/cases', payload: { name: 'Onlay persistence case' } })
      .then((r) => r.json() as { id: string; createdAt: string });

    const document = onlayDocument(created.id, created.createdAt);

    const putRes = await app.inject({ method: 'PUT', url: `/api/cases/${created.id}`, payload: document });
    expect(putRes.statusCode).toBe(200);

    const getRes = await app.inject({ method: 'GET', url: `/api/cases/${created.id}` });
    expect(getRes.statusCode).toBe(200);
    const restored = getRes.json() as CaseDocument;
    expect(restored).toEqual(document);

    // The cavity-specific cuspCoverage stage AND the full QcReport (with the
    // region-scoped cuspCoverage gate + the ACKNOWLEDGED seating gate) survive.
    expect(restored.restorations[0]!.stages.cuspCoverage).toBe(onlay.patchHandle.contentHash);
    const restoredQc = restored.restorations[0]!.qc!;
    expect(restoredQc).toEqual(onlayReport);
    expect(restoredQc.gates.some((g) => g.gate === 'cuspCoverageThickness')).toBe(true);
    const seating = restoredQc.gates.find((g) => g.gate === 'seating')!;
    expect(seating.passed).toBe(false);
    expect(seating.acknowledged).toBe(true);
    expect(restoredQc.passed).toBe(true);
  });

  it('server-side journal replay reproduces the stored inlay stages.finalMesh hash + the Operation.outputHashes', async () => {
    const finalHash = inlay.shellResult.meshContentHash!;

    const replay = await replayCavityShellStage(inlay.context, CAVITY_TOOTH, {
      fitSurfaceMesh: inlay.fitHandle,
      patchMesh: inlay.patchHandle,
    });

    // Re-running the inlay shell stage op in the Node/server runtime reproduces
    // the hash the client sealed on stages.finalMesh.
    expect(replay.meshContentHash).toBe(finalHash);
    expect(replay.inputHashes).toEqual([inlay.fitHandle.contentHash, inlay.patchHandle.contentHash]);

    // …and that hash is exactly what a persisted document records.
    const document = inlayDocument('replay-id', '2026-01-01T00:00:00.000Z');
    expect(document.restorations[0]!.stages.finalMesh).toBe(replay.meshContentHash);
    expect(document.history[0]!.outputHashes).toEqual([replay.meshContentHash]);
  }, 180_000);

  it('inlay-shell replay is deterministic: two server-side re-runs produce the identical hash', async () => {
    const a = await replayCavityShellStage(inlay.context, CAVITY_TOOTH, { fitSurfaceMesh: inlay.fitHandle, patchMesh: inlay.patchHandle });
    const b = await replayCavityShellStage(inlay.context, CAVITY_TOOTH, { fitSurfaceMesh: inlay.fitHandle, patchMesh: inlay.patchHandle });
    expect(a.meshContentHash).toBe(b.meshContentHash);
  }, 180_000);
});
