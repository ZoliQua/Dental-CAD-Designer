// apps/server/src/archive-endpoint.test.ts
//
// Phase 7 Task 6 (Part B) — the ACCEPTANCE criterion: case archive export/import
// round-trips to IDENTICAL state. Built entirely from the SYNTHETIC P4 crown
// fixture (never a real scan — PHI rule); no archive is ever written to disk in
// the repo.
//
// The full loop: build a case with a scan mesh + a persisted finalMesh + a
// RELEASED export (the harness + the real export endpoint) → export the archive
// → import it into a SEPARATE, FRESH server/DB → assert every hash identical:
//   - case document deep-equal,
//   - scan bytes byte-identical (mesh store),
//   - final-mesh bytes byte-identical (final-mesh store),
//   - Export ledger rows reconstructed verbatim,
//   - journal replay-identical (the journal rides inside the case document;
//     deep-equal history + a hashCaseJournal match proves reproducibility).
// Plus: determinism (two exports byte-identical), corrupted-archive rejection
// naming the entry, and the no-silent-overwrite conflict.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { runCrownQc, type RunCrownQcInput } from '@dqcad/cad-pipeline';
import type { CaseDocument, QcReport } from '@dqcad/shared-types';
import { STANDARD_ZIRCONIA_PROFILE } from '@dqcad/clinical-profiles';
import { hashCaseJournal } from '@dqcad/kernel-workers/journal-hash';
import { KERNEL_VERSION } from '@dqcad/kernel';
import { buildApp } from './app.js';
import { buildCrownQcInput, toValidateQcBody, TOOTH } from './crown-qc-fixture.testutil.js';
import { buildExportHarness, toExportQcContext, type ExportHarness } from './export-request.testutil.js';
import { hashMesh } from './journal-replay.js';
import { buildCaseArchive, CaseArchiveError, parseCaseArchive, type CaseArchiveInputEntry } from './case-archive.js';
import { createEmptyCaseDocument } from './case-document.js';

/** Two isolated app instances (source + fresh import target), each with its own
 * temp stores. The import target shares the SAME test.db (globalSetup migrates
 * it) but reconstructs a NEW case id, so there is no collision. */
interface Server {
  app: FastifyInstance;
  prisma: PrismaClient;
  dirs: string[];
  dbFile: string | null;
}

// apps/server (where prisma/schema.prisma lives) — relative `file:` URLs
// resolve against prisma/.
const projectRoot = fileURLToPath(new URL('..', import.meta.url));

/** Makes an app instance with its own isolated file stores. When `freshDb` is
 * set, a SEPARATE, freshly-migrated SQLite file backs it — the honest "import
 * into a FRESH server/DB" of the acceptance criterion (the default source
 * server shares the globalSetup-migrated test.db). */
async function makeServer(tag: string, freshDb: boolean): Promise<Server> {
  const dirs = ['mesh', 'tooth', 'exports', 'final'].map((k) =>
    mkdtempSync(join(tmpdir(), `dqcad-arch-${tag}-${k}-`)),
  );
  let prisma: PrismaClient;
  let dbFile: string | null = null;
  if (freshDb) {
    const dbName = `archive-${tag}-${process.pid}-${Date.now()}.db`;
    const dbUrl = `file:./${dbName}`;
    dbFile = fileURLToPath(new URL(`./prisma/${dbName}`, import.meta.url));
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: projectRoot,
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: 'ignore',
    });
    prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  } else {
    prisma = new PrismaClient();
  }
  const app = await buildApp({
    prisma,
    meshDataDir: dirs[0],
    toothLibraryDataDir: dirs[1],
    exportsDataDir: dirs[2],
    finalMeshDataDir: dirs[3],
  });
  return { app, prisma, dirs, dbFile };
}

async function closeServer(s: Server): Promise<void> {
  await s.app.close();
  for (const d of s.dirs) rmSync(d, { recursive: true, force: true });
  if (s.dbFile && existsSync(s.dbFile)) rmSync(s.dbFile);
}

describe('case archive export/import — round-trip identity (Phase 7 Task 6 Part B)', () => {
  let source: Server;
  let target: Server;
  let standinInput: RunCrownQcInput;
  let standinReport: QcReport;
  let standinContext: Record<string, unknown>;

  beforeAll(async () => {
    source = await makeServer('src', false);
    target = await makeServer('dst', true);

    const base = await buildCrownQcInput('standin');
    standinInput = {
      ...base,
      journalHash: hashMesh(base.crownSolid),
      profileVersion: STANDARD_ZIRCONIA_PROFILE.version,
    };
    standinReport = await runCrownQc(standinInput);
    standinContext = toExportQcContext(toValidateQcBody(standinInput), 'crownSolid');
  }, 300_000);

  afterAll(async () => {
    await closeServer(source);
    await closeServer(target);
  });

  /** Builds a case on `source` with a persisted finalMesh + a released export,
   * plus a scan MeshAsset (with real stored bytes) added to its document. */
  async function buildReleasedCase(): Promise<{ harness: ExportHarness; scanFileHash: string; document: CaseDocument }> {
    const harness = await buildExportHarness({
      app: source.app,
      restorationType: 'crown',
      teeth: [TOOTH],
      finalMesh: standinInput.crownSolid,
      clientReport: standinReport,
      qcContext: standinContext,
      format: 'stl',
      persistFinalMesh: true,
    });
    // Release the export through the real endpoint (creates the ledger row +
    // stores the bytes content-addressed).
    const res = await source.app.inject({
      method: 'POST',
      url: `/api/restorations/${harness.restorationId}/export`,
      payload: harness.body,
    });
    expect(res.statusCode).toBe(200);

    // Add a scan mesh: upload real STL bytes, then reference it from the case
    // document (a MeshAsset + a SceneNode) via PUT.
    const scanBytes = Buffer.from(harness.bytes); // reuse the export STL as a synthetic "scan"
    const up = await source.app.inject({
      method: 'POST',
      url: '/api/meshes',
      headers: { 'content-type': 'application/octet-stream' },
      payload: scanBytes,
    });
    expect(up.statusCode).toBe(200);
    const scanFileHash = (up.json() as { hash: string }).hash;

    const current = await source.app.inject({ method: 'GET', url: `/api/cases/${harness.caseId}` });
    const document = current.json() as CaseDocument;
    const withScan: CaseDocument = {
      ...document,
      meshes: [
        {
          id: 'scan-1',
          contentHash: 'scan-content-hash-1',
          name: 'synthetic-scan.stl',
          unit: 'mm',
          triangleCount: 1,
          fileHash: scanFileHash,
        },
      ],
      scene: [
        {
          id: 'node-1',
          meshId: 'scan-content-hash-1',
          role: 'prepDie',
          transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          visible: true,
          opacity: 1,
        },
      ],
    };
    const put = await source.app.inject({ method: 'PUT', url: `/api/cases/${harness.caseId}`, payload: withScan });
    expect(put.statusCode).toBe(200);
    return { harness, scanFileHash, document: withScan };
  }

  it('exports a deterministic archive (two exports byte-identical) and round-trips to identical state', async () => {
    const { harness, scanFileHash, document } = await buildReleasedCase();

    // Determinism: two exports of the same case are bit-identical.
    const a = await source.app.inject({ method: 'POST', url: `/api/cases/${harness.caseId}/archive` });
    const b = await source.app.inject({ method: 'POST', url: `/api/cases/${harness.caseId}/archive` });
    expect(a.statusCode).toBe(200);
    expect(Buffer.from(a.rawPayload).equals(Buffer.from(b.rawPayload))).toBe(true);

    const archiveBytes = a.rawPayload;
    const parsed = parseCaseArchive(new Uint8Array(archiveBytes));
    expect(parsed.entries.has('case-document')).toBe(true);
    expect(parsed.entries.has(`scan-mesh/${scanFileHash}`)).toBe(true);
    expect(parsed.entries.has(`final-mesh/${harness.finalMeshHash}`)).toBe(true);

    // Import into the FRESH target server/DB.
    const imp = await target.app.inject({
      method: 'POST',
      url: '/api/archives/import',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from(archiveBytes),
    });
    expect(imp.statusCode).toBe(201);
    const impBody = imp.json() as { caseId: string; overwritten: boolean; counts: Record<string, number> };
    expect(impBody.caseId).toBe(harness.caseId);
    expect(impBody.overwritten).toBe(false);
    expect(impBody.counts.exportRows).toBe(1);
    expect(impBody.counts.scans).toBe(1);
    expect(impBody.counts.finalMeshes).toBe(1);

    // --- Identity assertions on the TARGET server ---

    // 1. Case document deep-equal.
    const targetDocRes = await target.app.inject({ method: 'GET', url: `/api/cases/${harness.caseId}` });
    const targetDoc = targetDocRes.json() as CaseDocument;
    expect(targetDoc).toEqual(document);

    // 2. Journal replay-identical (the journal rides in the document; a
    //    hashCaseJournal match proves the reproducible view is preserved).
    expect(await hashCaseJournal(targetDoc.history)).toBe(await hashCaseJournal(document.history));

    // 3. Scan bytes byte-identical (content-addressed store).
    const srcScan = await source.app.inject({ method: 'GET', url: `/api/meshes/${scanFileHash}` });
    const dstScan = await target.app.inject({ method: 'GET', url: `/api/meshes/${scanFileHash}` });
    expect(Buffer.from(dstScan.rawPayload).equals(Buffer.from(srcScan.rawPayload))).toBe(true);

    // 4. Final-mesh bytes byte-identical.
    const srcFinal = await source.app.inject({ method: 'GET', url: `/api/final-meshes/${harness.finalMeshHash}` });
    const dstFinal = await target.app.inject({ method: 'GET', url: `/api/final-meshes/${harness.finalMeshHash}` });
    expect(dstFinal.statusCode).toBe(200);
    expect(Buffer.from(dstFinal.rawPayload).equals(Buffer.from(srcFinal.rawPayload))).toBe(true);

    // 5. Export ledger row reconstructed verbatim + its bytes downloadable.
    //    Every release-content field is identical; the ONLY difference is the
    //    provenance marker (review F-B1): the source row is server-verified
    //    (importedUnverified null), the imported row is stamped true so the
    //    ledger never presents it as server-re-validated.
    const srcRow = await source.prisma.export.findFirstOrThrow({ where: { caseId: harness.caseId } });
    const dstRow = await target.prisma.export.findFirstOrThrow({ where: { caseId: harness.caseId } });
    expect(srcRow.importedUnverified).toBeNull();
    expect(dstRow.importedUnverified).toBe(true);
    expect({ ...dstRow, importedUnverified: srcRow.importedUnverified }).toEqual(srcRow);
    const dl = await target.app.inject({ method: 'GET', url: `/api/exports/${dstRow.bytesSha256}/download` });
    expect(dl.statusCode).toBe(200);
    expect(Buffer.from(dl.rawPayload).equals(Buffer.from(harness.bytes))).toBe(true);
  });

  it('rejects importing over an existing case without confirmation, then overwrites with ?overwrite=true', async () => {
    const { harness } = await buildReleasedCase();
    const arch = await source.app.inject({ method: 'POST', url: `/api/cases/${harness.caseId}/archive` });
    // Import once into target.
    const first = await target.app.inject({
      method: 'POST',
      url: '/api/archives/import',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from(arch.rawPayload),
    });
    expect(first.statusCode).toBe(201);

    // Second import of the SAME case id → 409 conflict (no silent overwrite).
    const conflict = await target.app.inject({
      method: 'POST',
      url: '/api/archives/import',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from(arch.rawPayload),
    });
    expect(conflict.statusCode).toBe(409);
    expect((conflict.json() as { error: string }).error).toBe('archive-import-conflict');

    // Confirmed overwrite → 200.
    const overwrite = await target.app.inject({
      method: 'POST',
      url: '/api/archives/import?overwrite=true',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from(arch.rawPayload),
    });
    expect(overwrite.statusCode).toBe(200);
    expect((overwrite.json() as { overwritten: boolean }).overwritten).toBe(true);
  });

  it('rejects a corrupted archive, naming the failing entry', async () => {
    const { harness } = await buildReleasedCase();
    const arch = await source.app.inject({ method: 'POST', url: `/api/cases/${harness.caseId}/archive` });
    const corrupt = Buffer.from(arch.rawPayload);
    corrupt[corrupt.length - 3] = (corrupt[corrupt.length - 3]! ^ 0xff) & 0xff;

    // Direct parse names the failing entry / integrity failure.
    expect(() => parseCaseArchive(new Uint8Array(corrupt))).toThrow(CaseArchiveError);

    const res = await target.app.inject({
      method: 'POST',
      url: '/api/archives/import',
      headers: { 'content-type': 'application/octet-stream' },
      payload: corrupt,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('archive-invalid');
  });

  // --- MEDIUM #2 hardening: import-integrity (crafted, integrity-VALID,
  //     unsigned archives). An adversary who rewrites the whole archive
  //     recomputes every hash, so the DQCA manifest gives integrity, not
  //     authenticity — these two write-path gaps are closed regardless. ---

  /** Serializes an entry payload the way the import path consumes it (JSON;
   * import always `JSON.parse`s these entries). */
  function jsonEntry(name: string, kind: CaseArchiveInputEntry['kind'], value: unknown): CaseArchiveInputEntry {
    return { name, kind, bytes: new TextEncoder().encode(JSON.stringify(value)) };
  }

  /** A minimal, plausibly-complete archived Export ledger row keyed to `caseId`. */
  function archivedExportRow(id: string, caseId: string): Record<string, unknown> {
    return {
      id,
      caseId,
      restorationId: 'resto-x',
      restorationType: 'crown',
      teethJson: '[11]',
      format: 'stl',
      bytesSha256: 'a'.repeat(64),
      byteLength: 1,
      meshContentHash: 'b'.repeat(64),
      reimportMeshHash: 'c'.repeat(64),
      headerText: null,
      exportOperationId: 'op-x',
      caseJournalHash: 'd'.repeat(64),
      journalOperationCount: 1,
      kernelVersion: KERNEL_VERSION,
      profileId: 'standard-zirconia',
      profileVersion: '1.0.0',
      profileChecksum: 'e'.repeat(64),
      qcReportJson: '{}',
      acknowledgmentsJson: '[]',
      traceabilityJson: null,
      importedUnverified: null,
      attestedGatesJson: null,
      releasedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  it('Defect B — rejects an import whose reconstructed case-document violates the schema (400, names the failure)', async () => {
    const badDocId = `sec-doc-${Date.now()}`;
    // A structurally-plausible document with an ILLEGAL schemaVersion (const 2)
    // + an extra field — exactly what PUT /api/cases/:id would reject.
    const badDoc = {
      ...createEmptyCaseDocument(badDocId, '2026-01-01T00:00:00.000Z'),
      schemaVersion: 99,
      hacked: true,
    };
    const archive = buildCaseArchive(
      { id: badDocId, name: 'malformed', schemaVersion: 99, kernelVersion: KERNEL_VERSION },
      [jsonEntry('case-document', 'case-document', badDoc)],
    );
    const res = await target.app.inject({
      method: 'POST',
      url: '/api/archives/import',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from(archive),
    });
    expect(res.statusCode, res.body).toBe(400);
    const body = res.json() as { error: string; message: string; entryName?: string };
    expect(body.error).toBe('archive-invalid');
    expect(body.entryName).toBe('case-document');
    expect(body.message).toContain('case-document schema');
    // Nothing was persisted for the malformed id (the write-path was blocked).
    expect(await target.prisma.case.findUnique({ where: { id: badDocId } })).toBeNull();
  });

  it('a WELL-FORMED crafted archive still imports (positive control — the validator does not over-reject)', async () => {
    const okId = `sec-ok-${Date.now()}`;
    const doc = createEmptyCaseDocument(okId, '2026-01-01T00:00:00.000Z');
    const archive = buildCaseArchive(
      { id: okId, name: 'clean', schemaVersion: 2, kernelVersion: KERNEL_VERSION },
      [jsonEntry('case-document', 'case-document', doc)],
    );
    const res = await target.app.inject({
      method: 'POST',
      url: '/api/archives/import',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from(archive),
    });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as { caseId: string }).caseId).toBe(okId);
  });

  it('Defect A — rejects an archive whose export-row is keyed to a DIFFERENT case (cross-case ledger injection)', async () => {
    const importId = `sec-inj-${Date.now()}`;
    const victimId = `sec-victim-${Date.now()}`;
    const doc = createEmptyCaseDocument(importId, '2026-01-01T00:00:00.000Z');
    // The document imports `importId`, but the ledger row targets `victimId`.
    const archive = buildCaseArchive(
      { id: importId, name: 'injector', schemaVersion: 2, kernelVersion: KERNEL_VERSION },
      [
        jsonEntry('case-document', 'case-document', doc),
        jsonEntry('export-row/forged-1', 'export-row', archivedExportRow('forged-1', victimId)),
      ],
    );
    const res = await target.app.inject({
      method: 'POST',
      url: '/api/archives/import',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from(archive),
    });
    expect(res.statusCode, res.body).toBe(400);
    const body = res.json() as { error: string; message: string };
    expect(body.error).toBe('archive-invalid');
    expect(body.message).toContain(victimId);
    // The forged row was NOT injected into ANY case's ledger, and the importing
    // case itself was not created (the whole import was refused).
    expect(await target.prisma.export.findUnique({ where: { id: 'forged-1' } })).toBeNull();
    expect(await target.prisma.export.findFirst({ where: { caseId: victimId } })).toBeNull();
    expect(await target.prisma.case.findUnique({ where: { id: importId } })).toBeNull();
  });
});
