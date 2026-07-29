// apps/server/src/export-dual-validation-bridge.test.ts
//
// Phase 7 Task 4 — the P6 bridge export pass proof: the full loop (request
// build → endpoint → release → download → byte-identical bytes) on the REAL
// 3-unit posterior bridge fixture, in BOTH formats: STL (the re-import is the
// canonical re-index — reimportMeshHash ≠ meshContentHash — with the server
// report still bit-identical) and PLY (lossless — reimportMeshHash ===
// meshContentHash, the exact-identity boundary case). See export-route.ts's
// module doc for the equivalence argument these tests measure.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { runBridgeQc, type RunBridgeQcInput } from '@dqcad/cad-pipeline';
import type { QcReport } from '@dqcad/shared-types';
import { STANDARD_ZIRCONIA_PROFILE } from '@dqcad/clinical-profiles';
import { buildApp } from './app.js';
import { buildBridge, toValidateBridgeQcBody, BRIDGE_TEETH, BRIDGE_PONTICS } from './bridge-qc-fixture.testutil.js';
import { buildExportHarness, toExportQcContext, type ExportHarness } from './export-request.testutil.js';
import { hashMesh } from './journal-replay.js';
import { sha256HexOf } from './mesh-storage.js';

function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const rec = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(rec).sort().map((k) => [k, rec[k]]));
    }
    return v;
  });
}

interface ExportOkBody {
  released: true;
  exportId: string;
  bytesSha256: string;
  meshContentHash: string;
  reimportMeshHash: string;
  downloadPath: string;
  qcReport: QcReport;
}

describe('export dual-validation — P6 bridge fixture', () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  const dirs: string[] = [];
  let input: RunBridgeQcInput;
  let clientReport: QcReport;
  let qcContext: Record<string, unknown>;

  beforeAll(async () => {
    const mk = (tag: string): string => {
      const dir = mkdtempSync(join(tmpdir(), `dqcad-export-bridge-${tag}-`));
      dirs.push(dir);
      return dir;
    };
    prisma = new PrismaClient();
    app = await buildApp({
      prisma,
      meshDataDir: mk('mesh'),
      toothLibraryDataDir: mk('tooth'),
      exportsDataDir: mk('store'),
    });
    const built = await buildBridge();
    input = { ...built.qcInput, journalHash: hashMesh(built.assembledSolid), profileVersion: STANDARD_ZIRCONIA_PROFILE.version };
    clientReport = await runBridgeQc(input);
    expect(clientReport.passed).toBe(true);
    qcContext = toExportQcContext(toValidateBridgeQcBody(input), 'assembledSolid');
  }, 300_000);

  afterAll(async () => {
    await app.close();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  const bridgeHarness = (format: 'stl' | 'ply'): Promise<ExportHarness> =>
    buildExportHarness({
      app,
      restorationType: 'bridge',
      teeth: BRIDGE_TEETH,
      pontics: BRIDGE_PONTICS,
      finalMesh: input.assembledSolid,
      clientReport,
      qcContext,
      format,
    });

  it('STL: full loop — release, ledger row, byte-identical download, bit-identical server report', async () => {
    const harness = await bridgeHarness('stl');
    const res = await app.inject({
      method: 'POST',
      url: `/api/restorations/${harness.restorationId}/export`,
      payload: harness.body,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ExportOkBody;

    expect(canonical(body.qcReport)).toBe(canonical(clientReport));
    expect(body.meshContentHash).toBe(harness.finalMeshHash);
    // STL boundary: canonical re-index (narrowing measured 0 for the
    // WASM-lineage fused solid; vertex order still changes).
    expect(body.reimportMeshHash).not.toBe(harness.finalMeshHash);

    const dl = await app.inject({ method: 'GET', url: body.downloadPath });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toContain('model/stl');
    expect(dl.headers['content-disposition']).toContain('bridge-14-15-16-');
    expect(dl.rawPayload.equals(Buffer.from(harness.bytes))).toBe(true);
    expect(sha256HexOf(dl.rawPayload)).toBe(harness.request.bytesSha256);

    const row = await prisma.export.findUniqueOrThrow({ where: { id: body.exportId } });
    expect(row.restorationType).toBe('bridge');
    expect(JSON.parse(row.teethJson)).toEqual([...BRIDGE_TEETH]);
    expect(row.reimportMeshHash).toBe(body.reimportMeshHash);
  }, 300_000);

  it('PLY: full loop — lossless re-import (reimportMeshHash === meshContentHash), bit-identical report', async () => {
    const harness = await bridgeHarness('ply');
    const res = await app.inject({
      method: 'POST',
      url: `/api/restorations/${harness.restorationId}/export`,
      payload: harness.body,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ExportOkBody;
    expect(body.reimportMeshHash).toBe(body.meshContentHash);
    expect(canonical(body.qcReport)).toBe(canonical(clientReport));
    const dl = await app.inject({ method: 'GET', url: body.downloadPath });
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.equals(Buffer.from(harness.bytes))).toBe(true);
  }, 300_000);
});
