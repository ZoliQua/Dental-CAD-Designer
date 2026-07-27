// apps/server/src/bridge-persistence.test.ts
//
// Phase 6 Task 8 — bridge persistence + server-side journal replay.
//   - A CaseDocument whose BRIDGE restoration carries populated bridge `stages`
//     (bridgeAbutmentSurfaces/bridgePontic/bridgeConnectors/bridgeFramework +
//     the shared finalMesh) + a `qc` QcReport built in FRAMEWORK MODE with an
//     ACKNOWLEDGED thin-unit thickness gate round-trips through PUT then GET
//     losslessly (deep-equal — proving the T7 schema-mirror widening strips NO
//     bridge field, and the acknowledged/framework report survives byte-for-byte).
//   - Journal replay: re-running the bridge ASSEMBLY stage server-side (via
//     `replayBridgeAssemblyStage`, the same cad-pipeline the client uses)
//     reproduces the stored `stages.finalMesh` hash + the stage
//     `Operation.outputHashes` — the reproducibility invariant, server-checked.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { runBridgeQc } from '@dqcad/cad-pipeline';
import { KERNEL_VERSION } from '@dqcad/kernel';
import type { CaseDocument, QcReport } from '@dqcad/shared-types';
import { buildApp } from './app.js';
import { createEmptyCaseDocument } from './case-document.js';
import { PROFILE } from './crown-qc-fixture.testutil.js';
import { buildBridge, BRIDGE_PONTICS, BRIDGE_TEETH, type BuiltBridgeRestoration } from './bridge-qc-fixture.testutil.js';
import { replayBridgeAssemblyStage } from './journal-replay.js';

const THIN_UNIT_GATE = 'minWallThickness:15';

describe('bridge persistence + server-side journal replay', () => {
  let app: FastifyInstance;
  let meshDataDir: string;
  let toothLibraryDataDir: string;
  let bridge: BuiltBridgeRestoration;
  let bridgeReport: QcReport;

  beforeAll(async () => {
    meshDataDir = mkdtempSync(join(tmpdir(), 'dqcad-bridge-persist-mesh-'));
    toothLibraryDataDir = mkdtempSync(join(tmpdir(), 'dqcad-bridge-persist-tooth-'));
    app = await buildApp({ meshDataDir, toothLibraryDataDir });

    // A FRAMEWORK-MODE bridge with a thin pontic wall (0.4 mm < the 0.5 mm
    // framework minimum) whose thickness gate BLOCKS and is ACKNOWLEDGED — the
    // exact kind of report (framework-mode + acknowledged) that lands on
    // Restoration.qc and must survive PUT/GET.
    bridge = await buildBridge({
      fixture: { thinPonticInnerRadiusMm: 2.6 },
      frameworkMode: true,
      acknowledgedGates: [THIN_UNIT_GATE],
      journalHash: 'bridge-persistence',
    });
    bridgeReport = await runBridgeQc(bridge.qcInput);
  }, 600_000);

  afterAll(async () => {
    await app.close();
    rmSync(meshDataDir, { recursive: true, force: true });
    rmSync(toothLibraryDataDir, { recursive: true, force: true });
  });

  function bridgeDocument(id: string, createdAt: string): CaseDocument {
    const finalHash = bridge.assemblyStage.contentHash;
    return {
      ...createEmptyCaseDocument(id, createdAt),
      restorations: [
        {
          id: 'restoration-bridge-1',
          type: 'bridge',
          teeth: [...BRIDGE_TEETH],
          pontics: [...BRIDGE_PONTICS],
          targetNodeId: null,
          marginLines: {},
          insertionAxis: [0, 0, 1],
          params: { ...PROFILE.restorationParams },
          stages: {
            bridgeAbutmentSurfaces: bridge.unitHandles[0]!.contentHash,
            bridgePontic: bridge.unitHandles[1]!.contentHash,
            bridgeConnectors: bridge.connectorHandles[0]!.contentHash,
            bridgeFramework: bridge.connectorHandles[1]!.contentHash,
            finalMesh: finalHash,
          },
          qc: bridgeReport,
        },
      ],
      history: [
        {
          id: 'op-bridge-assembly-1',
          name: bridge.assemblyStage.operationName,
          params: bridge.assemblyStage.params,
          inputHashes: [...bridge.assemblyStage.inputHashes],
          outputHashes: [...bridge.assemblyStage.outputHashes],
          kernelVersion: KERNEL_VERSION,
          timestamp: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
  }

  it('round-trips a BRIDGE restoration with populated bridge stages + framework/acknowledged qc through PUT then GET (lossless)', async () => {
    const created = await app
      .inject({ method: 'POST', url: '/api/cases', payload: { name: 'Bridge persistence case' } })
      .then((r) => r.json() as { id: string; createdAt: string });

    const document = bridgeDocument(created.id, created.createdAt);

    const putRes = await app.inject({ method: 'PUT', url: `/api/cases/${created.id}`, payload: document });
    expect(putRes.statusCode).toBe(200);

    const getRes = await app.inject({ method: 'GET', url: `/api/cases/${created.id}` });
    expect(getRes.statusCode).toBe(200);
    const restored = getRes.json() as CaseDocument;
    expect(restored).toEqual(document);

    // Explicitly assert the bridge stage fields survived (no stripping).
    const stages = restored.restorations[0]!.stages;
    expect(stages).toEqual(document.restorations[0]!.stages);
    expect(stages.bridgeAbutmentSurfaces).toBe(bridge.unitHandles[0]!.contentHash);
    expect(stages.bridgePontic).toBe(bridge.unitHandles[1]!.contentHash);
    expect(stages.bridgeConnectors).toBe(bridge.connectorHandles[0]!.contentHash);
    expect(stages.bridgeFramework).toBe(bridge.connectorHandles[1]!.contentHash);
    expect(stages.finalMesh).toBe(bridge.assemblyStage.contentHash);

    // The full whole-bridge QcReport (per-unit gates + the ACKNOWLEDGED thin-unit
    // thickness gate, produced in framework mode) survives byte-for-byte.
    const restoredQc = restored.restorations[0]!.qc!;
    expect(restoredQc).toEqual(bridgeReport);
    const thin = restoredQc.gates.find((g) => g.gate === THIN_UNIT_GATE)!;
    expect(thin.passed).toBe(false);
    expect(thin.acknowledged).toBe(true);
    expect(restoredQc.gates.some((g) => g.gate === 'connectorCrossSection')).toBe(true);
    expect(restoredQc.gates.some((g) => g.gate === 'marginFit:14')).toBe(true);
    expect(restoredQc.gates.some((g) => g.gate === 'ponticRelief')).toBe(true);
    expect(restoredQc.passed).toBe(true);
  });

  it('server-side journal replay reproduces the stored bridge stages.finalMesh hash + the Operation.outputHashes', async () => {
    const finalHash = bridge.assemblyStage.contentHash;

    const replay = await replayBridgeAssemblyStage(bridge.context, {
      unitMeshes: bridge.unitHandles,
      connectorMeshes: bridge.connectorHandles,
    });

    // Re-running the bridge assembly op in the Node/server runtime reproduces the
    // hash the client sealed on stages.finalMesh.
    expect(replay.meshContentHash).toBe(finalHash);
    expect(replay.inputHashes).toEqual([
      ...bridge.unitHandles.map((h) => h.contentHash),
      ...bridge.connectorHandles.map((h) => h.contentHash),
    ]);

    // …and that hash is exactly what a persisted document records.
    const document = bridgeDocument('replay-id', '2026-01-01T00:00:00.000Z');
    expect(document.restorations[0]!.stages.finalMesh).toBe(replay.meshContentHash);
    expect(document.history[0]!.outputHashes).toEqual([replay.meshContentHash]);
  }, 180_000);

  it('bridge-assembly replay is deterministic: two server-side re-runs produce the identical hash', async () => {
    const a = await replayBridgeAssemblyStage(bridge.context, { unitMeshes: bridge.unitHandles, connectorMeshes: bridge.connectorHandles });
    const b = await replayBridgeAssemblyStage(bridge.context, { unitMeshes: bridge.unitHandles, connectorMeshes: bridge.connectorHandles });
    expect(a.meshContentHash).toBe(b.meshContentHash);
  }, 180_000);
});
