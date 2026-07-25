import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import type { CaseDocument } from '@dqcad/shared-types';
import { KERNEL_VERSION } from '@dqcad/kernel';
import { buildApp } from './app.js';
import { createEmptyCaseDocument } from './case-document.js';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

// Isolated per test-run temp dirs — never the real apps/server/data/meshes
// or apps/server/data/tooth-library (both git-ignored, shared with `npm run
// dev`); see mesh-storage.ts's and tooth-library-storage.ts's module docs.
const meshDataDir = mkdtempSync(join(tmpdir(), 'dqcad-mesh-storage-'));
const toothLibraryDataDir = mkdtempSync(join(tmpdir(), 'dqcad-tooth-library-storage-'));

describe('server app', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ meshDataDir, toothLibraryDataDir });
  });

  afterAll(async () => {
    await app.close();
    rmSync(meshDataDir, { recursive: true, force: true });
    rmSync(toothLibraryDataDir, { recursive: true, force: true });
  });

  it('GET /api/health returns ok with version and kernelVersion', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      version: packageJson.version,
      // Asserted against the LIVE @dqcad/kernel export, not a hardcoded
      // literal — a hardcoded '0.0.0' here would break on every legitimate
      // KERNEL_VERSION bump (Phase 2 Task 9's undercutScan golden addition
      // is the first one) for a reason unrelated to what this test actually
      // checks (that /api/health echoes the kernel's real version string).
      kernelVersion: KERNEL_VERSION,
    });
  });

  it('round-trips a case through POST then GET', async () => {
    const postResponse = await app.inject({
      method: 'POST',
      url: '/api/cases',
      payload: { name: 'Molar crown, patient A' },
    });

    expect(postResponse.statusCode).toBe(201);
    const created = postResponse.json() as {
      id: string;
      name: string;
      createdAt: string;
      updatedAt: string;
      schemaVersion: number;
    };
    expect(created).toMatchObject({
      name: 'Molar crown, patient A',
      schemaVersion: 2,
    });
    expect(typeof created.id).toBe('string');
    expect(typeof created.createdAt).toBe('string');
    expect(typeof created.updatedAt).toBe('string');

    const getResponse = await app.inject({ method: 'GET', url: '/api/cases' });

    expect(getResponse.statusCode).toBe(200);
    const cases = getResponse.json() as unknown[];
    expect(Array.isArray(cases)).toBe(true);
    expect(cases).toContainEqual(created);
  });

  it('rejects POST /api/cases with a missing name with 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/cases',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });

  describe('PATCH /api/cases/:id (rename)', () => {
    it('renames an existing case', async () => {
      const created = await app
        .inject({ method: 'POST', url: '/api/cases', payload: { name: 'Original name' } })
        .then((r) => r.json() as { id: string });

      const patchResponse = await app.inject({
        method: 'PATCH',
        url: `/api/cases/${created.id}`,
        payload: { name: 'Renamed case' },
      });

      expect(patchResponse.statusCode).toBe(200);
      expect(patchResponse.json()).toMatchObject({ id: created.id, name: 'Renamed case' });

      const getResponse = await app.inject({ method: 'GET', url: '/api/cases' });
      const cases = getResponse.json() as Array<{ id: string; name: string }>;
      expect(cases.find((c) => c.id === created.id)?.name).toBe('Renamed case');
    });

    it('404s renaming a case that does not exist', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/cases/does-not-exist',
        payload: { name: 'Whatever' },
      });
      expect(response.statusCode).toBe(404);
    });

    it('rejects an empty name with 400', async () => {
      const created = await app
        .inject({ method: 'POST', url: '/api/cases', payload: { name: 'Rename target' } })
        .then((r) => r.json() as { id: string });

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/cases/${created.id}`,
        payload: { name: '' },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('PUT/GET /api/cases/:id (full document save/load)', () => {
    it('round-trips a full CaseDocument through PUT then GET', async () => {
      const created = await app
        .inject({ method: 'POST', url: '/api/cases', payload: { name: 'Full doc case' } })
        .then((r) => r.json() as { id: string; createdAt: string });

      const document: CaseDocument = {
        ...createEmptyCaseDocument(created.id, created.createdAt),
        meshes: [
          {
            id: 'mesh-1',
            contentHash: 'a'.repeat(64),
            name: 'upper.stl',
            unit: 'mm',
            triangleCount: 12,
            fileHash: 'b'.repeat(64),
          },
        ],
        scene: [
          {
            id: 'node-1',
            meshId: 'mesh-1',
            role: 'upperJaw',
            transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
            visible: true,
            opacity: 1,
          },
        ],
        measurements: [
          {
            id: 'measurement-1',
            kind: 'pointToPoint',
            points: [
              { nodeId: 'node-1', position: [0, 0, 0] },
              { nodeId: 'node-1', position: [1, 1, 1] },
            ],
            value: 1.7320508075688772,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        history: [
          {
            id: 'op-1',
            name: 'import-mesh',
            params: { fileName: 'upper.stl' },
            inputHashes: ['c'.repeat(64)],
            outputHashes: ['a'.repeat(64)],
            kernelVersion: '0.0.0',
            timestamp: '2026-01-01T00:00:00.000Z',
          },
        ],
      };

      const putResponse = await app.inject({
        method: 'PUT',
        url: `/api/cases/${created.id}`,
        payload: document,
      });
      expect(putResponse.statusCode).toBe(200);
      const summary = putResponse.json() as { id: string; updatedAt: string };
      expect(summary.id).toBe(created.id);

      const getResponse = await app.inject({ method: 'GET', url: `/api/cases/${created.id}` });
      expect(getResponse.statusCode).toBe(200);
      expect(getResponse.json()).toEqual(document);
    });

    it('404s GET for a case that does not exist', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/cases/does-not-exist' });
      expect(response.statusCode).toBe(404);
    });

    // Task-11-review Critical 4: GET must return whatever is actually
    // stored, EVEN a pre-backfill-v2 (or otherwise legacy-shaped) document
    // that would never pass the strict `caseDocumentSchema` — that schema
    // is correctly used to VALIDATE PUT's request body (a client that wants
    // to save must migrate first), but was ALSO wrongly reused for GET's
    // response, where fast-json-stringify's strict serializer throws on a
    // missing required property (here: a `Restoration` missing
    // `pontics`/`targetNodeId`, backfilled only by the CLIENT's migration
    // layer) and silently drops any unlisted one (here: a since-removed
    // `controlPoints` field) — meaning a real pre-migration row could NEVER
    // reach the client at all. This writes a legacy-shaped document
    // DIRECTLY via Prisma (bypassing the — correctly strict — PUT route) to
    // simulate exactly that stored row, then asserts GET hands it back
    // completely intact.
    it('GET returns a pre-backfill-v2, legacy-shaped stored document byte-intact (permissive response serialization)', async () => {
      const created = await app
        .inject({ method: 'POST', url: '/api/cases', payload: { name: 'Legacy doc case' } })
        .then((r) => r.json() as { id: string; createdAt: string });

      const legacyDocument = {
        id: created.id,
        schemaVersion: 1,
        createdAt: created.createdAt,
        meshes: [],
        scene: [],
        restorations: [
          {
            id: 'restoration-legacy',
            type: 'crown',
            teeth: [16],
            // `pontics`/`targetNodeId` deliberately OMITTED — this is
            // exactly the pre-backfill-v2 shape (apps/client/src/engine/
            // caseDocumentMigration.ts's own field-presence backfill exists
            // to fix this up CLIENT-side, never server-side).
            marginLines: {},
            insertionAxis: [0, 0, 1],
            params: {
              cementGapMm: 0.05,
              marginalGapMm: 0.03,
              spacerStartMm: 0.5,
              minWallThicknessMm: 0.5,
              proximalContactPenetrationMm: 0.03,
              occlusalContactMm: 0.03,
            },
            stages: {},
            qc: null,
            // A since-removed field a real historical row might still
            // carry — `caseDocumentSchema`'s `additionalProperties: false`
            // would have silently DROPPED this on the way out; the
            // permissive GET path must not.
            controlPoints: [[0, 0, 0]],
          },
        ],
        measurements: [],
        history: [],
        settings: { materialProfileId: 'unassigned', profileVersion: '0.0.0' },
      };

      const prisma = new PrismaClient();
      try {
        await prisma.case.update({
          where: { id: created.id },
          data: { schemaVersion: 1, documentJson: JSON.stringify(legacyDocument) },
        });
      } finally {
        await prisma.$disconnect();
      }

      const getResponse = await app.inject({ method: 'GET', url: `/api/cases/${created.id}` });
      expect(getResponse.statusCode).toBe(200);
      expect(getResponse.json()).toEqual(legacyDocument);
    });

    it('PUT still rejects the same legacy shape with 400 (strict request validation is unchanged by the permissive GET fix)', async () => {
      const created = await app
        .inject({ method: 'POST', url: '/api/cases', payload: { name: 'Legacy doc case, PUT attempt' } })
        .then((r) => r.json() as { id: string; createdAt: string });

      const legacyDocument = {
        id: created.id,
        schemaVersion: 1,
        createdAt: created.createdAt,
        meshes: [],
        scene: [],
        restorations: [
          {
            id: 'restoration-legacy',
            type: 'crown',
            teeth: [16],
            marginLines: {},
            insertionAxis: [0, 0, 1],
            params: {
              cementGapMm: 0.05,
              marginalGapMm: 0.03,
              spacerStartMm: 0.5,
              minWallThicknessMm: 0.5,
              proximalContactPenetrationMm: 0.03,
              occlusalContactMm: 0.03,
            },
            stages: {},
            qc: null,
          },
        ],
        measurements: [],
        history: [],
        settings: { materialProfileId: 'unassigned', profileVersion: '0.0.0' },
      };

      const response = await app.inject({
        method: 'PUT',
        url: `/api/cases/${created.id}`,
        payload: legacyDocument,
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects a schemaVersion other than 2 with 400 (including a legacy schemaVersion-1 document — Phase 3 Task 1: server never migrates, client must)', async () => {
      const created = await app
        .inject({ method: 'POST', url: '/api/cases', payload: { name: 'Bad schema version' } })
        .then((r) => r.json() as { id: string; createdAt: string });

      for (const schemaVersion of [1, 3]) {
        const document = {
          ...createEmptyCaseDocument(created.id, created.createdAt),
          schemaVersion,
        };

        const response = await app.inject({
          method: 'PUT',
          url: `/api/cases/${created.id}`,
          payload: document,
        });
        expect(response.statusCode).toBe(400);
      }
    });

    it('rejects a document shape that violates the schema (extra property) with 400', async () => {
      const created = await app
        .inject({ method: 'POST', url: '/api/cases', payload: { name: 'Bad shape' } })
        .then((r) => r.json() as { id: string; createdAt: string });

      const document = {
        ...createEmptyCaseDocument(created.id, created.createdAt),
        notARealField: 'nope',
      };

      const response = await app.inject({
        method: 'PUT',
        url: `/api/cases/${created.id}`,
        payload: document,
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects a MarginAnchor.barycentric component outside [0, 1] with 400', async () => {
      const created = await app
        .inject({ method: 'POST', url: '/api/cases', payload: { name: 'Bad barycentric' } })
        .then((r) => r.json() as { id: string; createdAt: string });

      const document: CaseDocument = {
        ...createEmptyCaseDocument(created.id, created.createdAt),
        restorations: [
          {
            id: 'restoration-1',
            type: 'crown',
            teeth: [16],
            pontics: [],
            targetNodeId: null,
            marginLines: {
              16: {
                anchors: [
                  {
                    position: [0, 0, 0],
                    triangleIndex: 0,
                    // Out of range: a real barycentric weight is in [0, 1]
                    // (shared-types' `MarginAnchor.barycentric` doc) —
                    // 1.5 must be rejected by the schema's per-item bounds.
                    barycentric: [1.5, -0.5, 0],
                  },
                ],
                closed: false,
              },
            },
            insertionAxis: [0, 0, 1],
            params: {
              cementGapMm: 0.05,
              marginalGapMm: 0.03,
              spacerStartMm: 0.5,
              minWallThicknessMm: 0.4,
              proximalContactPenetrationMm: 0.02,
              occlusalContactMm: 0.03,
            },
            stages: {},
            qc: null,
          },
        ],
      };

      const response = await app.inject({
        method: 'PUT',
        url: `/api/cases/${created.id}`,
        payload: document,
      });
      expect(response.statusCode).toBe(400);
    });

    // Phase 3 Task 2: restorationSchema tightened to the real shared-types
    // `Restoration` shape (pontics/targetNodeId, FDI-enum teeth, PLAN.md §3
    // param bounds, real stages/qc shapes) — this proves a full, realistic
    // restoration (a bridge, mirroring arch-case-01's 12/11/21/22 span)
    // round-trips through PUT then GET byte-for-byte.
    it('round-trips a full CaseDocument with a bridge Restoration (pontics + targetNodeId) through PUT then GET', async () => {
      const created = await app
        .inject({ method: 'POST', url: '/api/cases', payload: { name: 'Bridge restoration case' } })
        .then((r) => r.json() as { id: string; createdAt: string });

      const document: CaseDocument = {
        ...createEmptyCaseDocument(created.id, created.createdAt),
        scene: [
          {
            id: 'node-1',
            meshId: 'mesh-1',
            role: 'upperJaw',
            transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
            visible: true,
            opacity: 1,
          },
        ],
        restorations: [
          {
            id: 'restoration-1',
            type: 'bridge',
            teeth: [12, 11, 21, 22],
            pontics: [12, 22],
            targetNodeId: 'node-1',
            marginLines: {},
            insertionAxis: [0, 0, 1],
            params: {
              cementGapMm: 0.05,
              marginalGapMm: 0.02,
              spacerStartMm: 0.8,
              minWallThicknessMm: 0.5,
              proximalContactPenetrationMm: 0.02,
              occlusalContactMm: 0,
            },
            stages: {},
            qc: null,
          },
        ],
        history: [
          {
            id: 'op-1',
            name: 'restoration-create',
            params: { restorationId: 'restoration-1' },
            inputHashes: [],
            outputHashes: [],
            kernelVersion: '0.0.0',
            timestamp: '2026-01-01T00:00:00.000Z',
          },
        ],
      };

      const putResponse = await app.inject({
        method: 'PUT',
        url: `/api/cases/${created.id}`,
        payload: document,
      });
      expect(putResponse.statusCode).toBe(200);

      const getResponse = await app.inject({ method: 'GET', url: `/api/cases/${created.id}` });
      expect(getResponse.statusCode).toBe(200);
      expect(getResponse.json()).toEqual(document);
    });

    it('rejects a Restoration.teeth entry outside the 32 valid FDI codes with 400', async () => {
      const created = await app
        .inject({ method: 'POST', url: '/api/cases', payload: { name: 'Bad FDI tooth' } })
        .then((r) => r.json() as { id: string; createdAt: string });

      const document: CaseDocument = {
        ...createEmptyCaseDocument(created.id, created.createdAt),
        restorations: [
          {
            id: 'restoration-1',
            type: 'crown',
            teeth: [99 as unknown as CaseDocument['restorations'][number]['teeth'][number]],
            pontics: [],
            targetNodeId: null,
            marginLines: {},
            insertionAxis: [0, 0, 1],
            params: {
              cementGapMm: 0.05,
              marginalGapMm: 0.02,
              spacerStartMm: 0.8,
              minWallThicknessMm: 0.5,
              proximalContactPenetrationMm: 0.02,
              occlusalContactMm: 0,
            },
            stages: {},
            qc: null,
          },
        ],
      };

      const response = await app.inject({ method: 'PUT', url: `/api/cases/${created.id}`, payload: document });
      expect(response.statusCode).toBe(400);
    });

    it('rejects a RestorationParams field outside its PLAN.md §3 range with 400', async () => {
      const created = await app
        .inject({ method: 'POST', url: '/api/cases', payload: { name: 'Bad params range' } })
        .then((r) => r.json() as { id: string; createdAt: string });

      const document: CaseDocument = {
        ...createEmptyCaseDocument(created.id, created.createdAt),
        restorations: [
          {
            id: 'restoration-1',
            type: 'crown',
            teeth: [11],
            pontics: [],
            targetNodeId: null,
            marginLines: {},
            insertionAxis: [0, 0, 1],
            params: {
              cementGapMm: 0.05,
              marginalGapMm: 0.02,
              spacerStartMm: 5, // way outside 0.5-1.0 mm
              minWallThicknessMm: 0.5,
              proximalContactPenetrationMm: 0.02,
              occlusalContactMm: 0,
            },
            stages: {},
            qc: null,
          },
        ],
      };

      const response = await app.inject({ method: 'PUT', url: `/api/cases/${created.id}`, payload: document });
      expect(response.statusCode).toBe(400);
    });

    it('rejects a Restoration missing the pontics/targetNodeId fields with 400', async () => {
      const created = await app
        .inject({ method: 'POST', url: '/api/cases', payload: { name: 'Missing new fields' } })
        .then((r) => r.json() as { id: string; createdAt: string });

      const document = {
        ...createEmptyCaseDocument(created.id, created.createdAt),
        restorations: [
          {
            id: 'restoration-1',
            type: 'crown',
            teeth: [11],
            marginLines: {},
            insertionAxis: [0, 0, 1],
            params: {
              cementGapMm: 0.05,
              marginalGapMm: 0.02,
              spacerStartMm: 0.8,
              minWallThicknessMm: 0.5,
              proximalContactPenetrationMm: 0.02,
              occlusalContactMm: 0,
            },
            stages: {},
            qc: null,
          },
        ],
      };

      const response = await app.inject({ method: 'PUT', url: `/api/cases/${created.id}`, payload: document });
      expect(response.statusCode).toBe(400);
    });

    it('rejects a body.id that disagrees with the URL :id with 400', async () => {
      const created = await app
        .inject({ method: 'POST', url: '/api/cases', payload: { name: 'Mismatched id' } })
        .then((r) => r.json() as { id: string; createdAt: string });

      const document = createEmptyCaseDocument('a-totally-different-id', created.createdAt);

      const response = await app.inject({
        method: 'PUT',
        url: `/api/cases/${created.id}`,
        payload: document,
      });
      expect(response.statusCode).toBe(400);
    });

    it('404s PUT for a case that does not exist', async () => {
      const document = createEmptyCaseDocument('does-not-exist', new Date().toISOString());
      const response = await app.inject({
        method: 'PUT',
        url: '/api/cases/does-not-exist',
        payload: document,
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('POST/GET/HEAD /api/meshes (content-addressed mesh storage)', () => {
    it('uploads bytes, computes the sha256 hash server-side, and fetches byte-identical bytes back', async () => {
      const bytes = randomBytes(4096);
      const expectedHash = createHash('sha256').update(bytes).digest('hex');

      const postResponse = await app.inject({
        method: 'POST',
        url: '/api/meshes',
        headers: { 'content-type': 'application/octet-stream' },
        payload: bytes,
      });
      expect(postResponse.statusCode).toBe(200);
      expect(postResponse.json()).toEqual({ hash: expectedHash, byteLength: bytes.byteLength });

      const headResponse = await app.inject({ method: 'HEAD', url: `/api/meshes/${expectedHash}` });
      expect(headResponse.statusCode).toBe(200);
      expect(headResponse.headers['content-length']).toBe(String(bytes.byteLength));

      const getResponse = await app.inject({ method: 'GET', url: `/api/meshes/${expectedHash}` });
      expect(getResponse.statusCode).toBe(200);
      expect(getResponse.headers['content-type']).toBe('application/octet-stream');
      expect(Buffer.compare(getResponse.rawPayload, bytes)).toBe(0);
    });

    it('is idempotent on re-upload of the exact same bytes', async () => {
      const bytes = randomBytes(2048);

      const first = await app.inject({
        method: 'POST',
        url: '/api/meshes',
        headers: { 'content-type': 'application/octet-stream' },
        payload: bytes,
      });
      const second = await app.inject({
        method: 'POST',
        url: '/api/meshes',
        headers: { 'content-type': 'application/octet-stream' },
        payload: bytes,
      });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(first.json()).toEqual(second.json());
    });

    it('HEAD 404s for a hash that was never uploaded', async () => {
      const response = await app.inject({ method: 'HEAD', url: `/api/meshes/${'0'.repeat(64)}` });
      expect(response.statusCode).toBe(404);
    });

    it('GET 404s for a hash that was never uploaded', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/meshes/${'0'.repeat(64)}` });
      expect(response.statusCode).toBe(404);
    });

    it('rejects a malformed hash route param with 400', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/meshes/not-a-valid-hash' });
      expect(response.statusCode).toBe(400);
    });

    it('rejects an oversized upload with 413', async () => {
      const tinyLimitDataDir = mkdtempSync(join(tmpdir(), 'dqcad-mesh-storage-tiny-'));
      const tinyToothLibraryDataDir = mkdtempSync(join(tmpdir(), 'dqcad-tooth-library-storage-tiny-'));
      const tinyApp = await buildApp({
        meshDataDir: tinyLimitDataDir,
        meshMaxBytes: 16,
        toothLibraryDataDir: tinyToothLibraryDataDir,
      });
      try {
        const response = await tinyApp.inject({
          method: 'POST',
          url: '/api/meshes',
          headers: { 'content-type': 'application/octet-stream' },
          payload: randomBytes(1024),
        });
        expect(response.statusCode).toBe(413);
      } finally {
        await tinyApp.close();
        rmSync(tinyLimitDataDir, { recursive: true, force: true });
        rmSync(tinyToothLibraryDataDir, { recursive: true, force: true });
      }
    });

    it('rejects a non-octet-stream content type with 415', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/meshes',
        headers: { 'content-type': 'text/plain' },
        payload: 'not mesh bytes',
      });
      expect(response.statusCode).toBe(415);
    });
  });

  describe('GET /api/tooth-library[/:fdi] (Phase 4 Task 2)', () => {
    it('lists the 5 seeded starter assets (4 incisors + 1 molar)', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/tooth-library' });
      expect(response.statusCode).toBe(200);
      const list = response.json() as Array<{ fdi: number; version: string; toothType: string }>;
      expect(list).toHaveLength(5);
      expect(list.map((a) => a.fdi).sort((a, b) => a - b)).toEqual([11, 12, 16, 21, 22]);
      expect(list.find((a) => a.fdi === 16)?.toothType).toBe('molar');
      expect(list.find((a) => a.fdi === 11)?.toothType).toBe('incisor');
      for (const entry of list) {
        expect(entry.version).toBe('1.0.0');
      }
    });

    it('GET /api/tooth-library/:fdi returns the full checksum-verified metadata for an incisor', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/tooth-library/11' });
      expect(response.statusCode).toBe(200);
      const metadata = response.json() as {
        fdi: number;
        toothType: string;
        landmarks: Record<string, [number, number, number]>;
        canonicalFrame: { origin: number[] };
        meshChecksum: string;
        metadataChecksum: string;
      };
      expect(metadata.fdi).toBe(11);
      expect(metadata.toothType).toBe('incisor');
      expect(metadata.landmarks.incisalEdge).toBeDefined();
      expect(metadata.meshChecksum).toMatch(/^[0-9a-f]{64}$/);
      expect(metadata.metadataChecksum).toMatch(/^[0-9a-f]{64}$/);
    });

    it("GET /api/tooth-library/:fdi's meshChecksum is fetchable via the existing GET /api/meshes/:hash route", async () => {
      const metadataResponse = await app.inject({ method: 'GET', url: '/api/tooth-library/16' });
      const metadata = metadataResponse.json() as { meshChecksum: string };

      const meshResponse = await app.inject({ method: 'GET', url: `/api/meshes/${metadata.meshChecksum}` });
      expect(meshResponse.statusCode).toBe(200);
      expect(meshResponse.rawPayload.byteLength).toBeGreaterThan(84);

      // And that mesh really does hash to the checksum the metadata claims.
      const actualHash = createHash('sha256').update(meshResponse.rawPayload).digest('hex');
      expect(actualHash).toBe(metadata.meshChecksum);
    });

    it('404s for an FDI with no stored asset (valid FDI shape, just none seeded)', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/tooth-library/48' });
      expect(response.statusCode).toBe(404);
    });

    it('rejects a malformed :fdi route param with 400', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/tooth-library/not-a-tooth' });
      expect(response.statusCode).toBe(400);
    });

    it('rejects an out-of-range FDI shape (e.g. quadrant 9) with 400', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/tooth-library/91' });
      expect(response.statusCode).toBe(400);
    });

    it('re-seeding on a second buildApp call against the SAME data dir is idempotent (no error, same content)', async () => {
      const sharedDataDir = mkdtempSync(join(tmpdir(), 'dqcad-tooth-library-storage-shared-'));
      const sharedMeshDir = mkdtempSync(join(tmpdir(), 'dqcad-mesh-storage-shared-'));
      const appA = await buildApp({ meshDataDir: sharedMeshDir, toothLibraryDataDir: sharedDataDir });
      const appB = await buildApp({ meshDataDir: sharedMeshDir, toothLibraryDataDir: sharedDataDir });
      try {
        const responseA = await appA.inject({ method: 'GET', url: '/api/tooth-library/11' });
        const responseB = await appB.inject({ method: 'GET', url: '/api/tooth-library/11' });
        expect(responseA.json()).toEqual(responseB.json());
      } finally {
        await appA.close();
        await appB.close();
        rmSync(sharedDataDir, { recursive: true, force: true });
        rmSync(sharedMeshDir, { recursive: true, force: true });
      }
    });
  });
});
