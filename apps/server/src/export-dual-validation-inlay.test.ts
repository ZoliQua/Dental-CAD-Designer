// apps/server/src/export-dual-validation-inlay.test.ts
//
// Phase 7 Task 4 — the P5 inlay/onlay export pass proof: the full loop
// (client-side request build → POST /api/restorations/:id/export → release →
// download → downloaded bytes byte-identical to the request bytes) on the
// REAL MOD-inlay fixture, plus the ONLAY variant whose acknowledged seating
// gate (the P5-T7 bounded+localized junction artifact) proves the
// acknowledgment rides journal-verified into the release record. The server
// report recomputed over the RE-IMPORTED bytes must be BIT-IDENTICAL to the
// client report over the f64 shell (the narrowing/re-index equivalence,
// measured per run — see export-route.ts's module doc).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { runInlayQc, type RunInlayQcInput } from '@dqcad/cad-pipeline';
import type { QcReport } from '@dqcad/shared-types';
import { EMAX_LITHIUM_DISILICATE_PROFILE } from '@dqcad/clinical-profiles';
import { buildApp } from './app.js';
import { buildInlay, buildOnlay, toValidateInlayQcBody, CAVITY_TOOTH } from './inlay-qc-fixture.testutil.js';
import { buildExportHarness, toExportQcContext } from './export-request.testutil.js';
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

describe('export dual-validation — P5 inlay/onlay fixtures', () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  const dirs: string[] = [];

  beforeAll(async () => {
    const mk = (tag: string): string => {
      const dir = mkdtempSync(join(tmpdir(), `dqcad-export-inlay-${tag}-`));
      dirs.push(dir);
      return dir;
    };
    prisma = new PrismaClient();
    app = await buildApp({
      prisma,
      meshDataDir: mk('mesh'),
      toothLibraryDataDir: mk('tooth'),
      exportsDataDir: mk('store'),
      finalMeshDataDir: mk('final'),
    });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it('INLAY (STL): full loop — release, ledger, byte-identical download, bit-identical server report', async () => {
    const built = await buildInlay();
    const input: RunInlayQcInput = { ...built.qcInput, journalHash: hashMesh(built.qcInput.inlaySolid), profileVersion: EMAX_LITHIUM_DISILICATE_PROFILE.version };
    const clientReport = await runInlayQc(input);
    expect(clientReport.passed).toBe(true);

    const harness = await buildExportHarness({
      app,
      restorationType: 'inlay',
      teeth: [CAVITY_TOOTH],
      finalMesh: input.inlaySolid,
      clientReport,
      qcContext: toExportQcContext(toValidateInlayQcBody(input), 'inlaySolid'),
      format: 'stl',
      // The cavity fixtures' 1.0/1.5 mm minimums + 1.3/1.8 mm bands ARE the
      // e.max registry profile's values — the honest identity under F1's
      // server-side profile pinning.
      profile: EMAX_LITHIUM_DISILICATE_PROFILE,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/restorations/${harness.restorationId}/export`,
      payload: harness.body,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ExportOkBody;

    // Bit-identical server report over the re-imported bytes.
    expect(canonical(body.qcReport)).toBe(canonical(clientReport));
    // Boundary evidence: STL re-import is the canonical re-index (narrowing
    // measured 0 for this WASM-lineage shell, re-index still reorders).
    expect(body.meshContentHash).toBe(harness.finalMeshHash);
    expect(body.reimportMeshHash).not.toBe(harness.finalMeshHash);

    const dl = await app.inject({ method: 'GET', url: body.downloadPath });
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.equals(Buffer.from(harness.bytes))).toBe(true);
    expect(sha256HexOf(dl.rawPayload)).toBe(harness.request.bytesSha256);

    const row = await prisma.export.findUniqueOrThrow({ where: { id: body.exportId } });
    expect(row.restorationType).toBe('inlay');
    expect(JSON.parse(row.teethJson)).toEqual([CAVITY_TOOTH]);
  }, 300_000);

  it('ONLAY (STL, acknowledged seating): the acknowledgment rides journal-verified into the release', async () => {
    const built = await buildOnlay();
    const input: RunInlayQcInput = { ...built.qcInput, journalHash: hashMesh(built.qcInput.inlaySolid), profileVersion: EMAX_LITHIUM_DISILICATE_PROFILE.version };
    const clientReport = await runInlayQc(input);
    const seating = clientReport.gates.find((g) => g.gate === 'seating');
    expect(seating?.passed).toBe(false);
    expect(seating?.acknowledged).toBe(true);
    expect(clientReport.passed).toBe(true); // acknowledged failure

    const harness = await buildExportHarness({
      app,
      restorationType: 'onlay',
      teeth: [CAVITY_TOOTH],
      finalMesh: input.inlaySolid,
      clientReport,
      qcContext: toExportQcContext(toValidateInlayQcBody(input), 'inlaySolid'),
      format: 'stl',
      // The cavity fixtures' 1.0/1.5 mm minimums + 1.3/1.8 mm bands ARE the
      // e.max registry profile's values — the honest identity under F1's
      // server-side profile pinning.
      profile: EMAX_LITHIUM_DISILICATE_PROFILE,
    });
    expect(harness.request.acknowledgments).toEqual([
      expect.objectContaining({ gate: 'seating', operationId: harness.ackOps[0]!.id }),
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/restorations/${harness.restorationId}/export`,
      payload: harness.body,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ExportOkBody;
    expect(canonical(body.qcReport)).toBe(canonical(clientReport));

    // The acknowledgment is journaled into the release record (invariant 4).
    const row = await prisma.export.findUniqueOrThrow({ where: { id: body.exportId } });
    const acks = JSON.parse(row.acknowledgmentsJson) as { gate: string; operationId: string }[];
    expect(acks).toEqual([expect.objectContaining({ gate: 'seating', operationId: harness.ackOps[0]!.id })]);

    const dl = await app.inject({ method: 'GET', url: body.downloadPath });
    expect(dl.rawPayload.equals(Buffer.from(harness.bytes))).toBe(true);
  }, 300_000);
});
