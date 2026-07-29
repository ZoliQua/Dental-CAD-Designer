// apps/server/src/export-traceability.test.ts
//
// Phase 7 Task 5 — the QC traceability document, server side:
//  - generated AT RELEASE TIME from the SERVER's re-validation results (the
//    authoritative report — nothing client-supplied the server didn't
//    verify), schema-validated at generation, stored on the Export ledger
//    row as canonical JSON;
//  - served verbatim on GET /api/exports/:id/traceability.json (byte-exact)
//    and rendered on GET /api/exports/:id/traceability.html (i18n ×4, the
//    releasedAt record envelope);
//  - REGENERABLE: rebuilding the document from the stored release record
//    (ledger row + stored bytes) reproduces the stored canonical JSON
//    byte-identically (the determinism requirement);
//  - byte-pinned golden on the P4 crown fixture export (kernel-guarded).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { KERNEL_VERSION } from '@dqcad/kernel';
import { runCrownQc, type RunCrownQcInput } from '@dqcad/cad-pipeline';
import { STANDARD_ZIRCONIA_PROFILE } from '@dqcad/clinical-profiles';
import type { QcReport, QcTraceabilityDocument } from '@dqcad/shared-types';
import {
  buildReleaseTraceabilityDocument,
  serializeTraceabilityDocument,
} from '@dqcad/traceability';
import {
  assertValidTraceabilityDocument,
  validateTraceabilityDocument,
} from '@dqcad/traceability/validate';
import { buildApp } from './app.js';
import { buildCrownQcInput, toValidateQcBody } from './crown-qc-fixture.testutil.js';
import {
  buildExportHarness,
  cloneBody,
  toExportQcContext,
  type ExportHarness,
} from './export-request.testutil.js';
import { installedManifoldVersion } from './manifold-version.js';
import { regenerateReleaseTraceability, rowToTraceabilityRecord } from './export-traceability.js';
import { hashMesh } from './journal-replay.js';
import { readMeshBytes } from './mesh-storage.js';

interface ExportOkBody {
  exportId: string;
  bytesSha256: string;
  byteLength: number;
  meshContentHash: string;
  reimportMeshHash: string;
  qcReport: QcReport;
  traceabilityJsonPath: string;
  traceabilityHtmlPath: string;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('QC traceability document — server generation, storage, routes', () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let meshDataDir: string;
  let toothLibraryDataDir: string;
  let exportsDataDir: string;

  let standinInput: RunCrownQcInput;
  let standinReport: QcReport;
  let standinContext: Record<string, unknown>;
  let thinInput: RunCrownQcInput;

  let stlHarness: ExportHarness;
  let stlRelease: ExportOkBody;

  beforeAll(async () => {
    meshDataDir = mkdtempSync(join(tmpdir(), 'dqcad-trace-mesh-'));
    toothLibraryDataDir = mkdtempSync(join(tmpdir(), 'dqcad-trace-tooth-'));
    exportsDataDir = mkdtempSync(join(tmpdir(), 'dqcad-trace-store-'));
    prisma = new PrismaClient();
    app = await buildApp({ prisma, meshDataDir, toothLibraryDataDir, exportsDataDir });

    const base = await buildCrownQcInput('standin');
    standinInput = {
      ...base,
      journalHash: hashMesh(base.crownSolid),
      profileVersion: STANDARD_ZIRCONIA_PROFILE.version,
    };
    standinReport = await runCrownQc(standinInput);
    standinContext = toExportQcContext(toValidateQcBody(standinInput), 'crownSolid');
    const thinBase = await buildCrownQcInput('thin');
    thinInput = {
      ...thinBase,
      journalHash: hashMesh(thinBase.crownSolid),
      profileVersion: STANDARD_ZIRCONIA_PROFILE.version,
    };

    stlHarness = await buildExportHarness({
      app,
      restorationType: 'crown',
      teeth: [16],
      finalMesh: standinInput.crownSolid,
      clientReport: standinReport,
      qcContext: standinContext,
      format: 'stl',
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/restorations/${stlHarness.restorationId}/export`,
      payload: stlHarness.body,
    });
    expect(response.statusCode).toBe(200);
    stlRelease = response.json() as ExportOkBody;
  }, 300_000);

  afterAll(async () => {
    await app.close();
    rmSync(meshDataDir, { recursive: true, force: true });
    rmSync(toothLibraryDataDir, { recursive: true, force: true });
    rmSync(exportsDataDir, { recursive: true, force: true });
  });

  async function storedRow(exportId: string) {
    const row = await prisma.export.findUnique({ where: { id: exportId } });
    expect(row).not.toBeNull();
    return row!;
  }

  it('generates + stores a schema-valid RELEASE document from the SERVER report at release time', async () => {
    const row = await storedRow(stlRelease.exportId);
    expect(row.traceabilityJson).not.toBeNull();
    const document = JSON.parse(row.traceabilityJson!) as QcTraceabilityDocument;

    // Schema-validated (the phase acceptance) — via the shared validator.
    expect(validateTraceabilityDocument(document)).toEqual({ valid: true });

    // The trustworthy copy: the SERVER-recomputed report, verbatim.
    expect(document.documentKind).toBe('release');
    expect(document.qc.gates).toEqual(stlRelease.qcReport.gates);
    expect(document.qc.passed).toBe(true);
    expect(document.qc.finalMeshContentHash).toBe(stlRelease.meshContentHash);

    // Identity + release evidence bound to the ledger row.
    expect(document.identity.caseId).toBe(stlHarness.caseId);
    expect(document.identity.restorationId).toBe(stlHarness.restorationId);
    expect(document.identity.teeth).toEqual([16]);
    expect(document.exportFile).toMatchObject({
      format: 'stl',
      bytesSha256: stlRelease.bytesSha256,
      byteLength: stlRelease.byteLength,
      meshContentHash: stlRelease.meshContentHash,
      headerText: stlHarness.exportOp.params['headerText'],
    });
    expect(document.journal).toEqual({
      caseJournalHash: stlHarness.request.caseJournalHash,
      journalOperationCount: stlHarness.request.journalOperationCount,
      exportOperationId: stlHarness.exportOp.id,
    });
    expect(document.reimportVerification).toEqual({
      reimportMeshHash: stlRelease.reimportMeshHash,
      meshHashRelation: 'stl-canonical-reindex-f32-narrowing',
      gateResultIdentity: true,
    });

    // Server-verified profile identity + versions (installed manifold-3d).
    expect(document.materialProfile).toEqual({
      id: STANDARD_ZIRCONIA_PROFILE.id,
      version: STANDARD_ZIRCONIA_PROFILE.version,
      checksum: STANDARD_ZIRCONIA_PROFILE.checksum,
    });
    expect(document.versions).toEqual({
      kernelVersion: KERNEL_VERSION,
      manifoldVersion: installedManifoldVersion(),
    });

    // STL error bounds: analytic half-ULP at the measured max |coordinate|.
    expect(document.errorBounds?.f32Narrowing?.basis).toBe('analytic-half-ulp-at-max-coordinate');
    expect(document.errorBounds?.f32Narrowing?.maxAbsCoordinateMm).toBeGreaterThan(0);
    expect(document.errorBounds?.f32Narrowing?.halfUlpBoundMm).toBeGreaterThan(0);
    // ~5 orders below the 1 µm display resolution (the T2 measurement class).
    expect(document.errorBounds?.f32Narrowing?.halfUlpBoundMm).toBeLessThan(1e-3);

    // The honest non-certification disclosure (T4 known limitation).
    expect(document.certification.outerEnvelopeCertified).toBe(false);
    expect(document.certification.limitations.map((l) => l.code)).toContain(
      'outer-envelope-not-certified',
    );

    // The stored string IS the canonical serialization (byte-stable core).
    expect(row.traceabilityJson).toBe(serializeTraceabilityDocument(document));
    // ZERO timestamps anywhere in the deterministic core.
    expect(row.traceabilityJson).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);

    // The response advertises both GET routes.
    expect(stlRelease.traceabilityJsonPath).toBe(
      `/api/exports/${stlRelease.exportId}/traceability.json`,
    );
    expect(stlRelease.traceabilityHtmlPath).toBe(
      `/api/exports/${stlRelease.exportId}/traceability.html`,
    );
  });

  it('GET traceability.json serves the stored canonical bytes VERBATIM', async () => {
    const row = await storedRow(stlRelease.exportId);
    const response = await app.inject({ method: 'GET', url: stlRelease.traceabilityJsonPath });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).toBe(row.traceabilityJson);
  });

  it('GET traceability.json → 404 for an unknown export id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/exports/no-such-id/traceability.json',
    });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: string }).error).toBe('export-not-found');
  });

  it('GET traceability routes → 404 typed for a legacy row without a stored document', async () => {
    // Simulate a pre-Task-5 release: null document column.
    const row = await storedRow(stlRelease.exportId);
    const legacy = await prisma.export.create({
      data: {
        caseId: row.caseId,
        restorationId: row.restorationId,
        restorationType: row.restorationType,
        teethJson: row.teethJson,
        format: row.format,
        bytesSha256: row.bytesSha256,
        byteLength: row.byteLength,
        meshContentHash: row.meshContentHash,
        reimportMeshHash: row.reimportMeshHash,
        exportOperationId: row.exportOperationId,
        caseJournalHash: row.caseJournalHash,
        kernelVersion: row.kernelVersion,
        profileId: row.profileId,
        profileVersion: row.profileVersion,
        profileChecksum: row.profileChecksum,
        qcReportJson: row.qcReportJson,
        acknowledgmentsJson: row.acknowledgmentsJson,
      },
    });
    for (const suffix of ['traceability.json', 'traceability.html']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/exports/${legacy.id}/${suffix}`,
      });
      expect(response.statusCode).toBe(404);
      expect((response.json() as { error: string }).error).toBe('export-traceability-missing');
    }
  });

  it('GET traceability.html renders the release document with the releasedAt record envelope', async () => {
    const row = await storedRow(stlRelease.exportId);
    const response = await app.inject({ method: 'GET', url: stlRelease.traceabilityHtmlPath });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    const html = response.body;
    expect(html).toContain('lang="en"');
    expect(html).toContain(stlHarness.caseId);
    expect(html).toContain(stlRelease.bytesSha256);
    expect(html).not.toContain('PREVIEW');
    // The row's releasedAt appears ONLY as the labeled non-hashed envelope.
    expect(html).toContain(row.releasedAt.toISOString());
    expect(html).toMatch(/not part of the hashed document/i);
  });

  it('GET traceability.html?lang renders all four locales; an unknown lang is a 400', async () => {
    for (const [lang, marker] of [
      ['en', 'QC Traceability Document'],
      ['hu', 'Minőségellenőrzés'],
      ['de', 'Rückverfolgbarkeitsdokument'],
      ['es', 'trazabilidad'],
    ] as const) {
      const response = await app.inject({
        method: 'GET',
        url: `${stlRelease.traceabilityHtmlPath}?lang=${lang}`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(`lang="${lang}"`);
      expect(response.body).toContain(marker);
    }
    const bad = await app.inject({
      method: 'GET',
      url: `${stlRelease.traceabilityHtmlPath}?lang=fr`,
    });
    expect(bad.statusCode).toBe(400);
  });

  it('REGENERATION is deterministic: rebuilding from the stored release record reproduces the stored bytes', async () => {
    const row = await storedRow(stlRelease.exportId);
    const bytes = await readMeshBytes(exportsDataDir, row.bytesSha256);
    expect(bytes).not.toBeNull();
    const regenerated = regenerateReleaseTraceability(rowToTraceabilityRecord(row), bytes!);
    expect(regenerated.json).toBe(row.traceabilityJson);
  });

  it('regeneration REFUSES a record whose stored bytes re-import to different geometry (integrity)', async () => {
    const row = await storedRow(stlRelease.exportId);
    const bytes = await readMeshBytes(exportsDataDir, row.bytesSha256);
    const record = rowToTraceabilityRecord(row);
    const tampered = { ...record, reimportMeshHash: 'ab'.repeat(32) };
    expect(() => regenerateReleaseTraceability(tampered, bytes!)).toThrow(/refusing to regenerate/);
  });

  it('rowToTraceabilityRecord refuses a legacy row with no journalOperationCount (typed 404 code)', async () => {
    const row = await storedRow(stlRelease.exportId);
    expect(() => rowToTraceabilityRecord({ ...row, journalOperationCount: null })).toThrow(
      /predates the traceability record/,
    );
  });

  it('idempotent re-release generates BIT-IDENTICAL document content (same release record ⇒ same bytes)', async () => {
    const again = await app.inject({
      method: 'POST',
      url: `/api/restorations/${stlHarness.restorationId}/export`,
      payload: stlHarness.body,
    });
    expect(again.statusCode).toBe(200);
    const secondId = (again.json() as ExportOkBody).exportId;
    expect(secondId).not.toBe(stlRelease.exportId);
    const first = await storedRow(stlRelease.exportId);
    const second = await storedRow(secondId);
    expect(second.traceabilityJson).toBe(first.traceabilityJson);
  });

  it('PLY release: lossless relation, null narrowing bound, null headerText', async () => {
    const plyHarness = await buildExportHarness({
      app,
      restorationType: 'crown',
      teeth: [16],
      finalMesh: standinInput.crownSolid,
      clientReport: standinReport,
      qcContext: standinContext,
      format: 'ply',
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/restorations/${plyHarness.restorationId}/export`,
      payload: plyHarness.body,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as ExportOkBody;
    const row = await storedRow(body.exportId);
    const document = JSON.parse(row.traceabilityJson!) as QcTraceabilityDocument;
    expect(validateTraceabilityDocument(document)).toEqual({ valid: true });
    expect(document.exportFile?.format).toBe('ply');
    expect(document.exportFile?.headerText).toBeNull();
    expect(document.errorBounds?.f32Narrowing).toBeNull();
    expect(document.reimportVerification?.meshHashRelation).toBe('ply-lossless-identity');
    // PLY re-import is lossless: the two hashes are IDENTICAL (asserted so
    // the relation string in the record is demonstrably true).
    expect(document.reimportVerification?.reimportMeshHash).toBe(
      document.exportFile?.meshContentHash,
    );
  });

  it('an acknowledged-gate release carries the acknowledgments with journal refs; the HTML flags them', async () => {
    const failing = (await runCrownQc(thinInput)).gates.filter((g) => !g.passed).map((g) => g.gate);
    expect(failing.length).toBeGreaterThan(0);
    const ackedReport = await runCrownQc({ ...thinInput, acknowledgedGates: failing });
    expect(ackedReport.passed).toBe(true);
    const harness = await buildExportHarness({
      app,
      restorationType: 'crown',
      teeth: [16],
      finalMesh: thinInput.crownSolid,
      clientReport: ackedReport,
      qcContext: toExportQcContext(toValidateQcBody(thinInput), 'crownSolid'),
      format: 'stl',
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/restorations/${harness.restorationId}/export`,
      payload: harness.body,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as ExportOkBody;
    const row = await storedRow(body.exportId);
    const document = JSON.parse(row.traceabilityJson!) as QcTraceabilityDocument;
    expect(validateTraceabilityDocument(document)).toEqual({ valid: true });
    expect(document.acknowledgments.map((a) => a.gate).sort()).toEqual([...failing].sort());
    for (const ack of document.acknowledgments) {
      expect(ack.operationId).toBeTruthy(); // journal-verified refs, never null on a release
    }
    const html = await app.inject({
      method: 'GET',
      url: `/api/exports/${body.exportId}/traceability.html`,
    });
    expect(html.statusCode).toBe(200);
    expect(html.body).toMatch(/class="[^"]*ack-section/);
    expect(html.body).toContain(document.acknowledgments[0]!.operationId!);
  });

  // --- Review B1 (BLOCKER, red pre-fix): identity.teeth must be SERVER-
  // verified. Pre-fix, a request whose teeth disagreed with the saved
  // restoration (or with the journaled export op) RELEASED with the wrong
  // FDI numbers in the certified identity block — a wrong-site labeling
  // defect on the record a lab matches against the physical order. ---

  it('B1: a request with WRONG teeth (all other bookkeeping consistent) is refused 409, nothing released', async () => {
    const harness = await buildExportHarness({
      app,
      restorationType: 'crown',
      teeth: [16],
      finalMesh: standinInput.crownSolid,
      clientReport: standinReport,
      qcContext: standinContext,
      format: 'stl',
    });
    const body = cloneBody(harness.body);
    // The attack: only request.teeth moves (16 → 26). No hash, journal, op
    // or byte bookkeeping depends on it — pre-fix this released 200 with
    // tooth 26 in the ledger + traceability identity block.
    (body.request as unknown as { teeth: number[] }).teeth = [26];
    const response = await app.inject({
      method: 'POST',
      url: `/api/restorations/${harness.restorationId}/export`,
      payload: body,
    });
    expect(response.statusCode).toBe(409);
    const rejection = response.json() as { error: string; details?: { reason?: string } };
    expect(rejection.error).toBe('export-journal-verification-failed');
    expect(rejection.details?.reason).toBe('restoration-teeth-mismatch');
    expect(await prisma.export.count({ where: { restorationId: harness.restorationId } })).toBe(0);
  });

  it('B1: a CONSISTENT-adversary journaled export op with wrong teeth (journal hash recomputed) is refused 409', async () => {
    const harness = await buildExportHarness({
      app,
      restorationType: 'crown',
      teeth: [16],
      finalMesh: standinInput.crownSolid,
      clientReport: standinReport,
      qcContext: standinContext,
      format: 'stl',
      // The journaled op claims tooth 26 while request + saved restoration
      // agree on 16; the harness recomputes caseJournalHash over the MUTATED
      // history, so the hash gate passes and only the op-binding check
      // stands between the tamper and a release.
      mutateHistory: (history) =>
        history.map((op) =>
          op.name === 'restoration-export' ? { ...op, params: { ...op.params, teeth: [26] } } : op,
        ),
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/restorations/${harness.restorationId}/export`,
      payload: harness.body,
    });
    expect(response.statusCode).toBe(409);
    const rejection = response.json() as { error: string; details?: { reason?: string } };
    expect(rejection.error).toBe('export-journal-verification-failed');
    expect(rejection.details?.reason).toBe('export-operation-teeth-mismatch');
    expect(await prisma.export.count({ where: { restorationId: harness.restorationId } })).toBe(0);
  });

  it('B1 three-way closure: the released identity.teeth equals the SAVED restoration teeth', async () => {
    const row = await storedRow(stlRelease.exportId);
    const document = JSON.parse(row.traceabilityJson!) as QcTraceabilityDocument;
    expect(document.identity.teeth).toEqual([16]);
    expect(JSON.parse(row.teethJson)).toEqual([16]);
    const savedRestoration = stlHarness.persistedDocument.restorations.find(
      (r) => r.id === stlHarness.restorationId,
    );
    expect(savedRestoration?.teeth).toEqual([16]);
  });

  // --- Review S1 (red pre-fix): the read path re-validates the stored
  // document against the schema on EVERY read — a corrupted/tampered row is
  // a typed 500, never served to a regulator (download-route symmetry). ---

  it('S1: a row-tampered (schema-invalid) stored document is NEVER served — typed 500 on both routes', async () => {
    const row = await storedRow(stlRelease.exportId);
    const corrupt = await prisma.export.create({
      data: {
        caseId: row.caseId,
        restorationId: row.restorationId,
        restorationType: row.restorationType,
        teethJson: row.teethJson,
        format: row.format,
        bytesSha256: row.bytesSha256,
        byteLength: row.byteLength,
        meshContentHash: row.meshContentHash,
        headerText: row.headerText,
        reimportMeshHash: row.reimportMeshHash,
        exportOperationId: row.exportOperationId,
        caseJournalHash: row.caseJournalHash,
        journalOperationCount: row.journalOperationCount,
        kernelVersion: row.kernelVersion,
        profileId: row.profileId,
        profileVersion: row.profileVersion,
        profileChecksum: row.profileChecksum,
        qcReportJson: row.qcReportJson,
        acknowledgmentsJson: row.acknowledgmentsJson,
        // Schema-invalid tamper: a release document whose evidence was ripped out.
        traceabilityJson: JSON.stringify({ schemaVersion: 1, documentKind: 'release' }),
      },
    });
    for (const suffix of ['traceability.json', 'traceability.html']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/exports/${corrupt.id}/${suffix}`,
      });
      expect(response.statusCode, suffix).toBe(500);
      expect((response.json() as { error: string }).error).toBe('export-storage-integrity');
    }
    // Unparseable JSON is equally refused.
    await prisma.export.update({
      where: { id: corrupt.id },
      data: { traceabilityJson: 'not-json{' },
    });
    const unparseable = await app.inject({
      method: 'GET',
      url: `/api/exports/${corrupt.id}/traceability.json`,
    });
    expect(unparseable.statusCode).toBe(500);
    expect((unparseable.json() as { error: string }).error).toBe('export-storage-integrity');
  });

  it('byte-pinned golden: the crown-fixture release document (fixed identity) pins byte-identically', async () => {
    // Pin preconditions — the pinned values are kernel-derived; a bump moves
    // them ONLY with a deliberate KERNEL_VERSION change + changelog entry
    // (the golden discipline).
    expect(KERNEL_VERSION).toBe('0.26.0');
    expect(installedManifoldVersion()).toBe('3.5.1');

    // Fixed identity/journal constants isolate the pin to the DETERMINISTIC
    // content: the fixture's gate results, mesh/bytes hashes, narrowing
    // bound, profile identity, versions. Everything else below comes from
    // the REAL release above (test-run-specific uuids drop out).
    const row = stlRelease;
    const storedDocument = JSON.parse(
      (await storedRow(stlRelease.exportId)).traceabilityJson!,
    ) as QcTraceabilityDocument;
    const pinned = buildReleaseTraceabilityDocument({
      identity: {
        caseId: 'golden-case',
        restorationId: 'golden-crown',
        restorationType: 'crown',
        teeth: [16],
      },
      serverReport: {
        gates: storedDocument.qc.gates,
        passed: storedDocument.qc.passed,
        kernelVersion: storedDocument.qc.kernelVersion,
        profileVersion: storedDocument.qc.profileVersion,
        journalHash: storedDocument.qc.finalMeshContentHash,
      },
      acknowledgments: [],
      materialProfile: {
        id: STANDARD_ZIRCONIA_PROFILE.id,
        version: STANDARD_ZIRCONIA_PROFILE.version,
        checksum: STANDARD_ZIRCONIA_PROFILE.checksum,
      },
      manifoldVersion: installedManifoldVersion(),
      exportFile: {
        format: 'stl',
        bytesSha256: row.bytesSha256,
        byteLength: row.byteLength,
        meshContentHash: row.meshContentHash,
        headerText: 'DQ-Dental-CAD; units=mm; crown 16',
      },
      journal: {
        caseJournalHash: 'f'.repeat(64),
        journalOperationCount: 1,
        exportOperationId: 'golden-export-op',
      },
      reimportMeshHash: row.reimportMeshHash,
      f32Narrowing: storedDocument.errorBounds!.f32Narrowing!,
    });
    assertValidTraceabilityDocument(pinned);
    const json = serializeTraceabilityDocument(pinned);
    // Filled from the first green run (the repo's pin convention); moves only
    // with a deliberate kernel/manifold/schema bump.
    expect(sha256Hex(json)).toBe(
      '13f5262f68fa1c2995e6dfef47a879f228d15262bde81e287193e898cdb363e8',
    );
  });
});
