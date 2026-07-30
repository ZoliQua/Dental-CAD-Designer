// Phase 8 Task 6 — backend input validation is GENUINELY enforced (Deliverable
// 2): schema-invalid input → a TYPED 4xx on every route class, NEVER a 500,
// NEVER a silent accept. The P7 `qc-invalid-input` 400 mapping is the pattern;
// this suite extends the discipline across the route classes (malformed body,
// wrong types, extra props, bad params, wrong content-type). Runs with auth
// disabled (the NODE_ENV=test default) so it isolates VALIDATION behavior.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';

const meshDataDir = mkdtempSync(join(tmpdir(), 'dqcad-validate-mesh-'));
const toothLibraryDataDir = mkdtempSync(join(tmpdir(), 'dqcad-validate-tooth-'));

describe('backend input validation (typed 4xx, never 500, never silent accept)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ meshDataDir, toothLibraryDataDir });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(meshDataDir, { recursive: true, force: true });
    rmSync(toothLibraryDataDir, { recursive: true, force: true });
  });

  const expect4xxNot500 = (status: number, ctx: string) => {
    expect(status, `${ctx}: expected a 4xx`).toBeGreaterThanOrEqual(400);
    expect(status, `${ctx}: must not be a 500 (a validation failure is the client's fault)`).toBeLessThan(500);
  };

  describe('POST /api/cases', () => {
    it('missing name → 400', async () => {
      const r = await app.inject({ method: 'POST', url: '/api/cases', payload: {} });
      expect(r.statusCode).toBe(400);
    });
    it('name a non-coercible type (object) → 400', async () => {
      // NB: Fastify's default AJV `coerceTypes` (kept on because the archive
      // `?overwrite=true` boolean querystring + numeric params rely on it)
      // coerces a scalar like `42` to `"42"`; an object/array cannot coerce to
      // a string, so it is a genuine rejection.
      const r = await app.inject({ method: 'POST', url: '/api/cases', payload: { name: { nested: true } } });
      expect(r.statusCode).toBe(400);
    });
    it('unknown extra property → 400 (additionalProperties:false is genuinely enforced)', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/cases',
        payload: { name: 'ok', smuggled: 'should-be-rejected' },
      });
      // Proves the removeAdditional:false override in buildApp: an unknown field
      // is a REJECTION, not a silent strip-and-accept.
      expect(r.statusCode).toBe(400);
    });
  });

  describe('PATCH /api/cases/:id', () => {
    it('missing name → 400 (before the case even exists — validation precedes lookup)', async () => {
      const r = await app.inject({ method: 'PATCH', url: '/api/cases/whatever', payload: {} });
      expect(r.statusCode).toBe(400);
    });
  });

  describe('PUT /api/cases/:id', () => {
    it('a document with the wrong schemaVersion → 400', async () => {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/cases/some-id',
        payload: { id: 'some-id', schemaVersion: 1 },
      });
      expect(r.statusCode).toBe(400);
    });
    it('a non-object body → 400', async () => {
      const r = await app.inject({
        method: 'PUT',
        url: '/api/cases/some-id',
        headers: { 'content-type': 'application/json' },
        payload: '"just a string"',
      });
      expect4xxNot500(r.statusCode, 'PUT non-object');
    });
  });

  describe('raw-body upload routes reject a non-octet-stream body with a typed 4xx', () => {
    it('POST /api/meshes with a JSON body → 415 (not a 500)', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/meshes',
        headers: { 'content-type': 'application/json' },
        payload: { not: 'bytes' },
      });
      expect(r.statusCode).toBe(415);
      expect((r.json() as { message?: string }).message).toBeTypeOf('string');
    });
    it('POST /api/final-meshes with a JSON body → 415', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/final-meshes',
        headers: { 'content-type': 'application/json' },
        payload: { not: 'bytes' },
      });
      expect(r.statusCode).toBe(415);
    });
    it('POST /api/archives/import with a garbage octet-stream → typed 4xx (never 500)', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/archives/import',
        headers: { 'content-type': 'application/octet-stream' },
        payload: Buffer.from('not a real dqca archive'),
      });
      expect4xxNot500(r.statusCode, 'archive import garbage');
      expect((r.json() as { error?: string }).error).toBeTypeOf('string');
    });
  });

  describe('POST /api/tooth-library', () => {
    it('malformed metadata → 400', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/tooth-library',
        payload: { metadata: { nonsense: true }, meshBase64: 'AAAA' },
      });
      expect(r.statusCode).toBe(400);
    });
    it('missing meshBase64 → 400', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/tooth-library',
        payload: { metadata: {} },
      });
      expect(r.statusCode).toBe(400);
    });
  });

  describe('POST /api/restorations/:id/validate-qc', () => {
    it('a body matching NONE of the oneOf branches → 400 (never a silent accept)', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/restorations/r1/validate-qc',
        payload: { garbage: true },
      });
      expect(r.statusCode).toBe(400);
    });
  });

  describe('POST /api/restorations/:id/export', () => {
    it('a malformed body → 400', async () => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/restorations/r1/export',
        payload: { request: {}, qcContext: {} },
      });
      expect4xxNot500(r.statusCode, 'export malformed');
    });
  });

  describe('params validation', () => {
    it('GET /api/meshes/:hash with a non-hex hash → 400', async () => {
      const r = await app.inject({ method: 'GET', url: '/api/meshes/NOT-A-HASH' });
      expect(r.statusCode).toBe(400);
    });
    it('GET /api/tooth-library/:fdi with an invalid FDI → 400', async () => {
      const r = await app.inject({ method: 'GET', url: '/api/tooth-library/99' });
      expect(r.statusCode).toBe(400);
    });
  });

  describe('querystring validation', () => {
    it('GET traceability.html with an unknown lang → 400 (enum enforced)', async () => {
      const r = await app.inject({
        method: 'GET',
        url: '/api/exports/some-id/traceability.html?lang=zz',
      });
      expect(r.statusCode).toBe(400);
    });
  });
});
