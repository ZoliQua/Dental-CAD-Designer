import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CaseDocument } from '@dqcad/shared-types';
import { KERNEL_VERSION } from '@dqcad/kernel';
import { buildApp } from './app.js';
import { createEmptyCaseDocument } from './case-document.js';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

// Isolated per test-run temp dir — never the real apps/server/data/meshes
// (which is git-ignored and shared with `npm run dev`); see mesh-storage.ts's
// module doc.
const meshDataDir = mkdtempSync(join(tmpdir(), 'dqcad-mesh-storage-'));

describe('server app', () => {
  let app: FastifyInstance;

  beforeAll(() => {
    app = buildApp({ meshDataDir });
  });

  afterAll(async () => {
    await app.close();
    rmSync(meshDataDir, { recursive: true, force: true });
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
      const tinyApp = buildApp({ meshDataDir: tinyLimitDataDir, meshMaxBytes: 16 });
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
});
