// apps/server/src/export-acceptance.test.ts
//
// Phase 7 Task 8 — THE PHASE GATE: the end-to-end export acceptance harness +
// reproducibility, per restoration type (crown / inlay / onlay / bridge),
// assembled from the EXISTING P4/P5/P6 fixtures (export-acceptance-lib.ts).
//
// Proves the four PLAN.md Phase-7 acceptance criteria on the FULL loop through
// the REAL server (mandatory finalMesh persistence + outer-envelope
// certification + independent byte re-validation are all exercised end-to-end):
//   1. the exported STL re-imports as WATERTIGHT/MANIFOLD (measured per type);
//   2. the QC traceability JSON is SCHEMA-VALIDATED (schemaVersion 2, certified);
//   3. TAMPERED export bytes are REJECTED (the full tamper matrix per type,
//      each with its rejection code — nothing released);
//   4. archive round-trip reproduces IDENTICAL case state (hashes identical).
// Plus reproducibility (Part C): the exported bytes are a deterministic
// function of the finalMesh (two-record byte identity + the released bytes hash
// equal to a fresh serialization).
//
// Runtime: the fixtures' design construction + the ONE server QC recompute at
// release are the only heavy work, done once per type; the tamper matrix
// rejects BEFORE the QC recompute, so it is cheap even for the cavity fixtures.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { exportStlBinary } from '@dqcad/io';
import type { CaseDocument, QcTraceabilityDocument } from '@dqcad/shared-types';
import { hashCaseJournal } from '@dqcad/kernel-workers/journal-hash';
import { validateTraceabilityDocument } from '@dqcad/traceability/validate';
import { buildApp } from './app.js';
import {
  buildExportHarness,
  cloneBody,
  exportHeaderText,
  type ExportHarness,
} from './export-request.testutil.js';
import {
  buildBridgeBundle,
  buildCrownBundle,
  buildInlayBundle,
  buildOnlayBundle,
  flipGeometryByte,
  moveApexOutward,
  reimportWatertightManifold,
  truncateBytes,
  type AcceptanceBundle,
} from './export-acceptance-lib.js';
import { sha256HexOf } from './mesh-storage.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

interface Server {
  app: FastifyInstance;
  prisma: PrismaClient;
  dirs: string[];
  dbFile: string | null;
}

/** An app instance with isolated file stores. `freshDb` backs it with a
 * SEPARATE freshly-migrated SQLite file (the "import into a FRESH server/DB" of
 * acceptance #4); otherwise it shares the globalSetup-migrated test.db. */
async function makeServer(tag: string, freshDb: boolean): Promise<Server> {
  const dirs = ['mesh', 'tooth', 'exports', 'final'].map((k) =>
    mkdtempSync(join(tmpdir(), `dqcad-accept-${tag}-${k}-`)),
  );
  let prisma: PrismaClient;
  let dbFile: string | null = null;
  if (freshDb) {
    const dbName = `accept-${tag}-${process.pid}-${Date.now()}.db`;
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

interface ExportOkBody {
  released: true;
  exportId: string;
  caseId: string;
  bytesSha256: string;
  meshContentHash: string;
  reimportMeshHash: string;
  downloadPath: string;
  traceabilityJsonPath: string;
}

let source: Server;
let target: Server;

beforeAll(async () => {
  source = await makeServer('src', false);
  target = await makeServer('dst', true);
}, 300_000);

afterAll(async () => {
  await closeServer(source);
  await closeServer(target);
});

const CASES: readonly { name: string; build: () => Promise<AcceptanceBundle> }[] = [
  { name: 'crown', build: buildCrownBundle },
  { name: 'inlay', build: buildInlayBundle },
  { name: 'onlay', build: buildOnlayBundle },
  { name: 'bridge', build: buildBridgeBundle },
];

describe.each(CASES)('Phase 7 acceptance — $name (full loop, STL)', ({ build }) => {
  let bundle: AcceptanceBundle;
  let harness: ExportHarness;
  let release: ExportOkBody;
  let downloaded: Uint8Array;

  /** A fresh harness for a tamper variant (persists the CLEAN finalMesh; the
   * mutation only touches the delivered bytes or the request/context). */
  const freshHarness = (
    overrides?: Partial<Parameters<typeof buildExportHarness>[0]>,
  ): Promise<ExportHarness> =>
    buildExportHarness({
      app: source.app,
      restorationType: bundle.restorationType,
      teeth: bundle.teeth,
      pontics: bundle.pontics,
      finalMesh: bundle.finalMesh,
      clientReport: bundle.clientReport,
      qcContext: bundle.qcContext,
      profile: bundle.profile,
      format: 'stl',
      ...overrides,
    });

  const post = (h: ExportHarness, body?: ExportHarness['body']) =>
    source.app.inject({
      method: 'POST',
      url: `/api/restorations/${h.restorationId}/export`,
      payload: body ?? h.body,
    });

  beforeAll(async () => {
    bundle = await build();
    // The onlay's clean report carries an acknowledged seating gate.
    expect(bundle.clientReport.passed).toBe(true);
    expect(bundle.clientReport.gates.some((g) => g.acknowledged)).toBe(bundle.hasAcknowledgedGate);

    harness = await freshHarness();
    const res = await post(harness);
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    release = res.json() as ExportOkBody;

    const dl = await source.app.inject({ method: 'GET', url: release.downloadPath });
    expect(dl.statusCode).toBe(200);
    downloaded = new Uint8Array(dl.rawPayload);
    // The download is byte-identical to the delivered bytes.
    expect(Buffer.from(downloaded).equals(Buffer.from(harness.bytes))).toBe(true);
  }, 300_000);

  // === PLAN acceptance #1 — re-import watertight/manifold ===================
  it('#1 the exported STL re-imports as WATERTIGHT and MANIFOLD', () => {
    const qc = reimportWatertightManifold(downloaded, 'stl');
    console.log(
      `[ACCEPT ${bundle.restorationType}] #1 re-import: watertight=${qc.watertight} manifold=${qc.manifold} ` +
        `tris=${qc.triangleCount} verts=${qc.vertexCount}`,
    );
    expect(qc.watertight).toBe(true);
    expect(qc.manifold).toBe(true);
    expect(qc.triangleCount).toBeGreaterThan(0);
  });

  // === PLAN acceptance #2 — traceability JSON schema-validated ==============
  it('#2 the traceability JSON is SCHEMA-VALIDATED (schemaVersion 2, outer envelope certified)', async () => {
    const res = await source.app.inject({ method: 'GET', url: release.traceabilityJsonPath });
    expect(res.statusCode).toBe(200);
    const doc = JSON.parse(res.body) as QcTraceabilityDocument;
    const validation = validateTraceabilityDocument(doc);
    console.log(
      `[ACCEPT ${bundle.restorationType}] #2 traceability: schemaVersion=${doc.schemaVersion} ` +
        `kind=${doc.documentKind} certified=${doc.certification.outerEnvelopeCertified} valid=${validation.valid}`,
    );
    expect(validation).toEqual({ valid: true });
    expect(doc.schemaVersion).toBe(2);
    expect(doc.documentKind).toBe('release');
    expect(doc.certification.outerEnvelopeCertified).toBe(true);
    expect(doc.certification.limitations).toEqual([]);
    expect(doc.qc.passed).toBe(true);
    // The acknowledged onlay carries its journal-verified acknowledgment.
    expect(doc.acknowledgments.length > 0).toBe(bundle.hasAcknowledgedGate);
  });

  // === PLAN acceptance #3 — tampered bytes REJECTED (the tamper matrix) =====
  it('#3 the TAMPER MATRIX is rejected, nothing released', async () => {
    interface Case {
      label: string;
      expectStatus: number;
      expectError: string;
      make: () => Promise<{ h: ExportHarness; body?: ExportHarness['body'] }>;
    }
    const variants: Case[] = [
      {
        label: 'geometry byte-flip (breaks weld)',
        expectStatus: 400,
        expectError: 'export-reimport-integrity',
        make: async () => ({ h: await freshHarness({ mutateBytes: flipGeometryByte }) }),
      },
      {
        label: 'outer-vertex move (welds cleanly, gate-invariant)',
        expectStatus: 409,
        expectError: 'export-outer-envelope-mismatch',
        make: async () => ({ h: await freshHarness({ mutateBytes: (b) => moveApexOutward(b, 0.5) }) }),
      },
      {
        label: 'threshold tamper (loosened riding threshold)',
        expectStatus: 409,
        expectError: 'export-profile-threshold-mismatch',
        make: async () => {
          const h = await freshHarness();
          const body = cloneBody(h.body);
          body.qcContext = bundle.loosenThreshold(body.qcContext as Record<string, unknown>) as never;
          return { h, body };
        },
      },
      {
        label: 'truncation',
        expectStatus: 400,
        expectError: 'export-bytes-parse-failed',
        make: async () => ({ h: await freshHarness({ mutateBytes: truncateBytes }) }),
      },
    ];

    for (const variant of variants) {
      const { h, body } = await variant.make();
      const res = await post(h, body);
      const parsed = res.json() as { error: string };
      console.log(
        `[ACCEPT ${bundle.restorationType}] #3 ${variant.label}: ${res.statusCode} ${parsed.error}`,
      );
      expect(res.statusCode, variant.label).toBe(variant.expectStatus);
      expect(parsed.error, variant.label).toBe(variant.expectError);
      // Nothing released from this tamper's fresh case.
      expect(await source.prisma.export.findFirst({ where: { caseId: h.caseId } })).toBeNull();
    }
  }, 120_000);

  // === PLAN acceptance #4 — archive round-trip identical ====================
  it('#4 archive round-trips to IDENTICAL case state (fresh DB, hashes identical)', async () => {
    // The released case (journal + restoration + persisted finalMesh + the
    // released export row) is archived and re-imported into the FRESH target
    // server/DB.
    const srcDoc = (
      await source.app.inject({ method: 'GET', url: `/api/cases/${harness.caseId}` })
    ).json() as CaseDocument;

    const arch = await source.app.inject({
      method: 'POST',
      url: `/api/cases/${harness.caseId}/archive`,
    });
    expect(arch.statusCode).toBe(200);
    // Determinism: a second archive export is byte-identical.
    const arch2 = await source.app.inject({
      method: 'POST',
      url: `/api/cases/${harness.caseId}/archive`,
    });
    expect(Buffer.from(arch.rawPayload).equals(Buffer.from(arch2.rawPayload))).toBe(true);

    const imp = await target.app.inject({
      method: 'POST',
      url: '/api/archives/import',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from(arch.rawPayload),
    });
    expect(imp.statusCode, imp.body).toBe(201);
    const impBody = imp.json() as { caseId: string; counts: Record<string, number> };
    expect(impBody.caseId).toBe(harness.caseId);
    expect(impBody.counts.exportRows).toBe(1);
    expect(impBody.counts.finalMeshes).toBe(1);

    // 1. Case document deep-equal.
    const dstDoc = (
      await target.app.inject({ method: 'GET', url: `/api/cases/${harness.caseId}` })
    ).json() as CaseDocument;
    expect(dstDoc).toEqual(srcDoc);
    // 2. Journal replay-identical (the journal rides in the document).
    const srcJournalHash = await hashCaseJournal(srcDoc.history);
    const dstJournalHash = await hashCaseJournal(dstDoc.history);
    expect(dstJournalHash).toBe(srcJournalHash);
    // 3. Final-mesh bytes byte-identical.
    const srcFinal = await source.app.inject({ method: 'GET', url: `/api/final-meshes/${harness.finalMeshHash}` });
    const dstFinal = await target.app.inject({ method: 'GET', url: `/api/final-meshes/${harness.finalMeshHash}` });
    expect(dstFinal.statusCode).toBe(200);
    expect(Buffer.from(dstFinal.rawPayload).equals(Buffer.from(srcFinal.rawPayload))).toBe(true);
    // 4. Export ledger row reconstructed (content-identical; only the
    //    provenance marker differs — importedUnverified, the T6 F-B1 boundary).
    const srcRow = await source.prisma.export.findFirstOrThrow({ where: { caseId: harness.caseId } });
    const dstRow = await target.prisma.export.findFirstOrThrow({ where: { caseId: harness.caseId } });
    expect({ ...dstRow, importedUnverified: srcRow.importedUnverified }).toEqual(srcRow);
    // 5. The released bytes are downloadable from the target, byte-identical.
    const dl = await target.app.inject({ method: 'GET', url: `/api/exports/${dstRow.bytesSha256}/download` });
    expect(dl.statusCode).toBe(200);
    expect(Buffer.from(dl.rawPayload).equals(Buffer.from(harness.bytes))).toBe(true);

    console.log(
      `[ACCEPT ${bundle.restorationType}] #4 archive round-trip: journalHash=${dstJournalHash.slice(0, 12)}… ` +
        `identical=${dstJournalHash === srcJournalHash}`,
    );
  }, 120_000);

  // === Part C — reproducibility (the exported bytes are deterministic) ======
  it('reproducibility: the exported bytes are a deterministic function of the finalMesh (two-record identity)', () => {
    const headerText = exportHeaderText(bundle.restorationType, bundle.teeth);
    const bytesA = exportStlBinary(bundle.finalMesh, { headerText });
    const bytesB = exportStlBinary(bundle.finalMesh, { headerText });
    // Two independent serializations are BIT-IDENTICAL.
    expect(Buffer.from(bytesA).equals(Buffer.from(bytesB))).toBe(true);
    const shaA = sha256HexOf(bytesA);
    expect(sha256HexOf(bytesB)).toBe(shaA);
    // The RELEASED bytes hash equals a fresh serialization's hash (the release
    // delivered the deterministic bytes).
    expect(release.bytesSha256).toBe(shaA);
    expect(sha256HexOf(downloaded)).toBe(shaA);
    // The server's re-import hash is itself deterministic on re-run.
    const r1 = reimportWatertightManifold(downloaded, 'stl');
    const r2 = reimportWatertightManifold(downloaded, 'stl');
    expect(r1).toEqual(r2);
    console.log(
      `[ACCEPT ${bundle.restorationType}] Part C reproducibility: bytesSha256=${shaA.slice(0, 12)}… ` +
        `two-record identical; reimportMeshHash=${release.reimportMeshHash.slice(0, 12)}…`,
    );
  });
});
