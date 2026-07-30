// Phase 8 Task 6 — the route-schema enumeration guard (CLAUDE.md: "Fastify
// routes always define JSON schemas"). Enumerates EVERY registered route via
// buildApp's `onRoute` seam and asserts full request/response schema coverage.
// Falsifiable: a seeded schema-less route IS flagged (both at the unit level
// and end-to-end through a real Fastify onRoute), so a new unschema'd route
// fails CI.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import {
  auditAllowlistFreshness,
  auditRoutes,
  collectRouteRecords,
  routeKey,
  type RouteRecord,
} from './route-audit.js';

const meshDataDir = mkdtempSync(join(tmpdir(), 'dqcad-audit-mesh-'));
const toothLibraryDataDir = mkdtempSync(join(tmpdir(), 'dqcad-audit-tooth-'));

describe('route-schema enumeration guard', () => {
  let app: FastifyInstance;
  const records: RouteRecord[] = [];

  beforeAll(async () => {
    app = await buildApp({
      meshDataDir,
      toothLibraryDataDir,
      onRoute: collectRouteRecords(records),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(meshDataDir, { recursive: true, force: true });
    rmSync(toothLibraryDataDir, { recursive: true, force: true });
  });

  it('enumerates the real route set (a non-trivial number of routes)', () => {
    // Sanity: the collector actually fired for the whole app (14 app.ts + 4
    // export + 2 archive + health + bootstrap + auto HEAD/OPTIONS siblings).
    expect(records.length).toBeGreaterThan(15);
    // The routes this task explicitly reasons about are all present.
    const keys = new Set(records.map((r) => routeKey(r.method, r.url)));
    for (const k of [
      'GET /api/health',
      'GET /api/auth/bootstrap',
      'POST /api/cases',
      'PUT /api/cases/:id',
      'POST /api/restorations/:id/validate-qc',
      'POST /api/restorations/:id/export',
      'POST /api/archives/import',
    ]) {
      expect(keys.has(k), `expected live route ${k}`).toBe(true);
    }
  });

  it('every registered route has full request + response schema coverage', () => {
    const violations = auditRoutes(records);
    // A readable failure: list exactly which routes lack which schema.
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('has no STALE allowlist entries (a removed route cannot mask a gap)', () => {
    expect(auditAllowlistFreshness(records)).toEqual([]);
  });

  // --- Falsifiability: the guard MUST flag a schema-less route ---

  it('FLAGS a seeded schema-less mutating route (unit level)', () => {
    const seeded: RouteRecord[] = [
      ...records,
      {
        method: 'POST',
        url: '/api/bogus-unschemad',
        hasBodySchema: false,
        hasParamsSchema: false,
        hasQuerySchema: false,
        hasSuccessResponseSchema: false,
      },
    ];
    const violations = auditRoutes(seeded);
    expect(violations.some((v) => v.includes('POST /api/bogus-unschemad'))).toBe(true);
    // And specifically catches BOTH the missing body and the missing response.
    expect(violations.filter((v) => v.includes('/api/bogus-unschemad')).length).toBe(2);
  });

  it('FLAGS a seeded schema-less route registered through a REAL Fastify onRoute', async () => {
    const probeRecords: RouteRecord[] = [];
    const probe = Fastify();
    probe.addHook('onRoute', collectRouteRecords(probeRecords));
    // A genuinely schema-less mutating route + a params route with no params schema.
    probe.post('/api/probe-no-schema', async () => ({ ok: true }));
    probe.get('/api/probe/:id', async () => ({ ok: true }));
    await probe.ready();

    const violations = auditRoutes(probeRecords);
    expect(violations.some((v) => v.includes('POST /api/probe-no-schema'))).toBe(true);
    expect(violations.some((v) => v.includes('GET /api/probe/:id') && v.includes('params'))).toBe(true);
    await probe.close();
  });
});
