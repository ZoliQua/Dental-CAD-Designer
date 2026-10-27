// apps/server/src/export-die.test.ts
//
// Phase 10 Task 2 (ADR-023 Decision 1, invariant 6) — the export's step 10.6:
// the crown's prepared die is re-extracted from the SAVED scan, margin and
// axis, and a riding `dieSolid` that differs is refused. Route-level: a
// traced crown releases; a riding die that is not the prepared die (the whole
// scan, as before Phase 10), a missing die op and an unstored scan are each
// refused, nothing released. Module-level: the re-derivation is bit-exact,
// and a journaled die the saved inputs do not give is caught.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { runCrownQc, type RunCrownQcInput } from '@dqcad/cad-pipeline';
import { STANDARD_ZIRCONIA_PROFILE } from '@dqcad/clinical-profiles';
import { writeStlBinary } from '@dqcad/io';
import { indexedToSoup, KERNEL_VERSION, type Vec3 } from '@dqcad/kernel';
import { CROWN_DIE_EXTRACT_OP, type CaseDocument, type QcReport, type Restoration } from '@dqcad/shared-types';
import { buildApp } from './app.js';
import {
  buildCrownQcInput,
  crownDieMargin,
  crownScanMesh,
  preparedCrownDie,
  toValidateQcBody,
  TOOTH,
} from './crown-qc-fixture.testutil.js';
import { buildExportHarness, toExportQcContext, type ExportHarness } from './export-request.testutil.js';
import { confirmedMarginLoop, verifyCrownExportDie } from './export-die.js';
import { ExportRejectionError } from './export-validation.js';
import { hashMesh } from './journal-replay.js';
import { storeMeshBytes } from './mesh-storage.js';
import { declareStandIns } from './stand-in-provenance.testutil.js';

describe('POST /api/restorations/:id/export — the crown die is re-extracted from the saved case (step 10.6)', () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  const dirs: string[] = [];
  let input: RunCrownQcInput;
  let report: QcReport;
  let context: Record<string, unknown>;

  beforeAll(async () => {
    const [meshDataDir, toothLibraryDataDir, exportsDataDir, finalMeshDataDir] = ['mesh', 'tooth', 'store', 'final'].map(
      (name) => mkdtempSync(join(tmpdir(), `dqcad-die-${name}-`)),
    ) as [string, string, string, string];
    dirs.push(meshDataDir, toothLibraryDataDir, exportsDataDir, finalMeshDataDir);
    prisma = new PrismaClient();
    app = await buildApp({ prisma, meshDataDir, toothLibraryDataDir, exportsDataDir, finalMeshDataDir });
    const base = await buildCrownQcInput('standin');
    input = declareStandIns({ ...base, journalHash: hashMesh(base.crownSolid), profileVersion: STANDARD_ZIRCONIA_PROFILE.version });
    report = await runCrownQc(input);
    context = toExportQcContext(toValidateQcBody(input), 'crownSolid');
  }, 300_000);

  afterAll(async () => {
    await app.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const harnessFor = (overrides?: Partial<Parameters<typeof buildExportHarness>[0]>): Promise<ExportHarness> =>
    buildExportHarness({
      app,
      restorationType: 'crown',
      teeth: [TOOTH],
      finalMesh: input.crownSolid,
      clientReport: report,
      qcContext: context,
      format: 'stl',
      ...overrides,
    });

  const post = (harness: ExportHarness) =>
    app.inject({ method: 'POST', url: `/api/restorations/${harness.restorationId}/export`, payload: harness.body });

  async function expectRefused(harness: ExportHarness, code: string): Promise<{ details: Record<string, unknown> }> {
    const res = await post(harness);
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string; details: Record<string, unknown> };
    expect(body.error).toBe(code);
    expect(await prisma.export.findFirst({ where: { caseId: harness.caseId } })).toBeNull();
    return body;
  }

  it('releases a crown whose riding die is the die re-extracted from the saved scan', async () => {
    const res = await post(await harnessFor());
    expect(res.statusCode).toBe(200);
    expect((res.json() as { released: boolean }).released).toBe(true);
  });

  it('refuses a riding die that is not the prepared die (the whole scan) — with a persisted diagnostic', async () => {
    const tampered = { ...context, dieSolid: { positions: Array.from(crownScanMesh().positions), indices: Array.from(crownScanMesh().indices) } };
    const body = await expectRefused(await harnessFor({ qcContext: tampered }), 'export-die-mismatch');
    expect(body.details['rederivedDieHash']).toBe(hashMesh(preparedCrownDie()));
    expect(body.details['journaledDieHash']).toBe(body.details['rederivedDieHash']);
    expect(body.details['ridingDieHash']).toBe(hashMesh(crownScanMesh()));
    const diag = await prisma.exportDiagnostic.findUnique({ where: { id: body.details['diagnosticId'] as string } });
    expect(diag?.reason).toBe('die-mismatch');
  });

  it('refuses a crown whose die no op of the case sealed', async () => {
    const harness = await harnessFor({
      mutateHistory: (history) => history.filter((op) => op.name !== CROWN_DIE_EXTRACT_OP),
    });
    await expectRefused(harness, 'export-die-not-traceable');
  });

  it('refuses a crown whose target scan bytes the server does not hold', async () => {
    // Its own server: scan storage is content-addressed, so the same bytes
    // stored by an earlier case would be found.
    const fresh = ['mesh', 'tooth', 'store', 'final'].map((name) => mkdtempSync(join(tmpdir(), `dqcad-die-fresh-${name}-`)));
    dirs.push(...fresh);
    const [meshDataDir, toothLibraryDataDir, exportsDataDir, finalMeshDataDir] = fresh as [string, string, string, string];
    const freshApp = await buildApp({ prisma, meshDataDir, toothLibraryDataDir, exportsDataDir, finalMeshDataDir });
    try {
      const harness = await harnessFor({ app: freshApp, persistCrownScan: false });
      const res = await freshApp.inject({
        method: 'POST',
        url: `/api/restorations/${harness.restorationId}/export`,
        payload: harness.body,
      });
      expect(res.statusCode).toBe(409);
      const body = res.json() as { error: string; details: Record<string, unknown> };
      expect(body.error).toBe('export-die-not-traceable');
      expect(body.details['scanMeshId']).toBe(hashMesh(crownScanMesh()));
      expect(await prisma.export.findFirst({ where: { caseId: harness.caseId } })).toBeNull();
    } finally {
      await freshApp.close();
    }
  });
});

describe('verifyCrownExportDie — the module against a saved case', () => {
  let meshDataDir: string;
  let fileHash: string;

  beforeAll(async () => {
    meshDataDir = mkdtempSync(join(tmpdir(), 'dqcad-die-unit-'));
    fileHash = (await storeMeshBytes(meshDataDir, Buffer.from(writeStlBinary(indexedToSoup(crownScanMesh()))))).hash;
  });
  afterAll(() => rmSync(meshDataDir, { recursive: true, force: true }));

  function savedCase(margin: Vec3[]): { document: CaseDocument; restoration: Restoration } {
    const scanMeshId = hashMesh(crownScanMesh());
    const dieHash = hashMesh(preparedCrownDie());
    const restoration: Restoration = {
      id: 'r-die',
      type: 'crown',
      teeth: [TOOTH],
      pontics: [],
      targetNodeId: 'n-scan',
      marginLines: { [TOOTH]: { anchors: [], closed: true, resampledPoints: margin } },
      insertionAxis: [0, 0, 1],
      params: { cementGapMm: 0.05, marginalGapMm: 0.02, spacerStartMm: 0.8, minWallThicknessMm: 0.5, proximalContactPenetrationMm: 0.02, occlusalContactMm: 0 },
      stages: { prepDie: dieHash },
      qc: null,
    };
    const document: CaseDocument = {
      id: 'c-die',
      schemaVersion: 2,
      createdAt: '2026-01-01T00:00:00.000Z',
      meshes: [{ id: 'm', contentHash: scanMeshId, name: 'scan.stl', unit: 'mm', triangleCount: crownScanMesh().indices.length / 3, fileHash }],
      scene: [{ id: 'n-scan', meshId: scanMeshId, role: 'prepDie', transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], visible: true, opacity: 1 }],
      restorations: [restoration],
      measurements: [],
      history: [
        {
          id: 'op-die',
          name: CROWN_DIE_EXTRACT_OP,
          params: { restorationId: 'r-die', tooth: TOOTH },
          inputHashes: [scanMeshId],
          outputHashes: [dieHash],
          kernelVersion: KERNEL_VERSION,
          timestamp: '2026-01-01T00:00:00.000Z',
        },
      ],
      settings: { materialProfileId: STANDARD_ZIRCONIA_PROFILE.id, profileVersion: STANDARD_ZIRCONIA_PROFILE.version },
    };
    return { document, restoration };
  }

  it('re-derives the client die bit for bit from the stored STL, the confirmed margin and the axis', async () => {
    const { document, restoration } = savedCase(crownDieMargin());
    const result = await verifyCrownExportDie(document, restoration, preparedCrownDie(), meshDataDir);
    expect(result.dieHash).toBe(hashMesh(preparedCrownDie()));
    expect(result.scanFileHash).toBe(fileHash);
  });

  it('catches a journaled die the saved scan, margin and axis do not give', async () => {
    // The case journals (and the client sends) a die that is not what these
    // inputs cut — e.g. one prepared before the margin was edited.
    const { document, restoration } = savedCase(crownDieMargin());
    const stale = hashMesh(crownScanMesh());
    const staleCase: CaseDocument = {
      ...document,
      restorations: [{ ...restoration, stages: { prepDie: stale } }],
      history: document.history.map((op) => ({ ...op, outputHashes: [stale] })),
    };
    let error: unknown;
    try {
      await verifyCrownExportDie(staleCase, staleCase.restorations[0]!, crownScanMesh(), meshDataDir);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ExportRejectionError);
    expect((error as ExportRejectionError).code).toBe('export-die-mismatch');
    expect((error as ExportRejectionError).message).toMatch(/journaled stages\.prepDie/);
    expect((error as ExportRejectionError).details['rederivedDieHash']).toBe(hashMesh(preparedCrownDie()));
  });

  it('reads the confirmed margin as the client engine does: resampled points first, else anchors', () => {
    const { restoration } = savedCase(crownDieMargin());
    expect(confirmedMarginLoop(restoration)).toEqual(crownDieMargin());
    const anchorsOnly: Restoration = {
      ...restoration,
      marginLines: {
        [TOOTH]: {
          anchors: crownDieMargin().slice(0, 4).map((position) => ({ position, triangleIndex: 0, barycentric: [1, 0, 0] as const })),
          closed: true,
        },
      },
    };
    expect(confirmedMarginLoop(anchorsOnly)).toEqual(crownDieMargin().slice(0, 4));
    expect(confirmedMarginLoop({ ...restoration, marginLines: {} })).toBeNull();
  });
});
