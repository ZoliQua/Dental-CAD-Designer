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
  clientAttestedGates: string[];
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
      finalMeshDataDir: mk('final'),
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

  const bridgeHarness = (
    format: 'stl' | 'ply',
    overrides: Partial<Parameters<typeof buildExportHarness>[0]> = {},
  ): Promise<ExportHarness> =>
    buildExportHarness({
      app,
      restorationType: 'bridge',
      teeth: BRIDGE_TEETH,
      pontics: BRIDGE_PONTICS,
      finalMesh: input.assembledSolid,
      clientReport,
      qcContext,
      format,
      // The fixture stands for a bridge built from the saved case's scans.
      traceBridgeToCase: true,
      ...overrides,
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

    // H1 fix (server code-review): the fracture-critical connector gate and the
    // pontic-relief gate consume CLIENT-MEASURED scalars the server cannot
    // recompute from the mill bytes (the connector frame/profiles + the pontic↔
    // gingiva relation are design-time context). They must NOT release as a
    // silent full-authority server-verified pass — the release RECORD discloses
    // them as client-attested (mirroring the archive `importedUnverified`).
    expect(body.clientAttestedGates).toEqual(
      expect.arrayContaining(['connectorCrossSection', 'ponticRelief']),
    );
    const connGate = body.qcReport.gates.find((g) => g.gate === 'connectorCrossSection');
    expect(connGate?.passed).toBe(true); // reported pass …
    expect(body.clientAttestedGates).toContain('connectorCrossSection'); // … but explicitly NOT full-authority
    // The SOLID-CONSUMING gates ARE server-recomputed → never listed as attested.
    expect(body.clientAttestedGates).not.toContain('watertight');
    expect(body.clientAttestedGates).not.toContain('manifold');
    expect(body.clientAttestedGates.some((g) => g.startsWith('marginFit'))).toBe(false);
    // The ledger row persists the same provenance (never hashed content).
    expect(JSON.parse(row.attestedGatesJson ?? 'null')).toEqual(body.clientAttestedGates);
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

  // ---- Phase 9 Task 6: the bridge provenance (ADR-022) ----------------------

  it('a case claim the saved case cannot back is refused (409 export-untraceable-provenance)', async () => {
    const harness = await bridgeHarness('stl', { traceBridgeToCase: false });
    const res = await app.inject({
      method: 'POST',
      url: `/api/restorations/${harness.restorationId}/export`,
      payload: harness.body,
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string; details: { claims: { input: string }[] } };
    expect(body.error).toBe('export-untraceable-provenance');
    expect(body.details.claims.map((c) => c.input)).toEqual(['bridge:abutmentSurfaces', 'bridge:pontic']);
  }, 300_000);

  it('the demonstration bridge fails every gate closed on the server too, and cannot be released', async () => {
    const demoReport = await runBridgeQc({ ...input, geometryProvenance: 'demo-fixture' });
    expect(demoReport.gates.every((g) => !g.passed && g.inputProvenance === 'demo-fixture')).toBe(true);
    const harness = await bridgeHarness('stl', {
      traceBridgeToCase: false,
      clientReport: demoReport,
      qcContext: { ...qcContext, geometryProvenance: 'demo-fixture' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/restorations/${harness.restorationId}/export`,
      payload: harness.body,
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('export-gates-failing');
  }, 300_000);

  it('a bridge-level margin band rides once, is pinned to the profile, and reaches every unit', async () => {
    const band = STANDARD_ZIRCONIA_PROFILE.marginExclusionMm;
    const banded: RunBridgeQcInput = { ...input, units: input.units.map((u) => ({ ...u, marginExclusionMm: band })) };
    const bandedReport = await runBridgeQc(banded);
    const harness = await bridgeHarness('stl', { clientReport: bandedReport, qcContext: { ...qcContext, marginExclusionMm: band } });
    const res = await app.inject({
      method: 'POST',
      url: `/api/restorations/${harness.restorationId}/export`,
      payload: harness.body,
    });
    expect(res.statusCode).toBe(200);
    expect(canonical((res.json() as ExportOkBody).qcReport)).toBe(canonical(bandedReport));

    const off = await bridgeHarness('stl', { clientReport: bandedReport, qcContext: { ...qcContext, marginExclusionMm: band + 0.1 } });
    const refused = await app.inject({ method: 'POST', url: `/api/restorations/${off.restorationId}/export`, payload: off.body });
    expect(refused.statusCode).toBe(409);
    expect((refused.json() as { error: string }).error).toBe('export-profile-threshold-mismatch');
  }, 300_000);
});
