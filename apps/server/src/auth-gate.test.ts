// Phase 8 Task 6 — local single-user auth gate (ADR-020). Falsifiable:
//  - every MUTATING route rejects an unauthenticated request (401);
//  - a valid token is ACCEPTED (never 401);
//  - an invalid token is rejected (401);
//  - read-only routes stay open;
//  - the gate COMPOSES with the enumeration guard — a new mutating route is
//    auth-gated by default (the composition test drives EVERY enumerated
//    mutating route, so a new one is covered automatically).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import {
  constantTimeEqual,
  extractPresentedToken,
  MUTATING_METHODS,
  resolveAuthConfig,
} from './auth.js';
import { collectRouteRecords, routeKey, type RouteRecord } from './route-audit.js';

const TOKEN = 'test-capability-token-4d5e6f';

const meshDataDir = mkdtempSync(join(tmpdir(), 'dqcad-auth-mesh-'));
const toothLibraryDataDir = mkdtempSync(join(tmpdir(), 'dqcad-auth-tooth-'));

/** Concrete URL for a route pattern — a placeholder per `:param`. Auth fires on
 * `onRequest` (after routing, before validation), so any structurally-matching
 * URL reaches the gate regardless of param/body validity. */
function concreteUrl(url: string): string {
  return url
    .split('/')
    .map((seg) => (seg.startsWith(':') ? 'placeholder' : seg))
    .join('/');
}

describe('local single-user auth gate', () => {
  let app: FastifyInstance;
  const records: RouteRecord[] = [];

  beforeAll(async () => {
    app = await buildApp({
      meshDataDir,
      toothLibraryDataDir,
      authToken: TOKEN, // gate ON with a known token
      onRoute: collectRouteRecords(records),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(meshDataDir, { recursive: true, force: true });
    rmSync(toothLibraryDataDir, { recursive: true, force: true });
  });

  // --- The composition property: EVERY mutating route is gated ---

  it('EVERY enumerated mutating route rejects an unauthenticated request with 401', async () => {
    const mutating = records.filter((r) => MUTATING_METHODS.has(r.method.toUpperCase()));
    // There are genuinely several (create/patch/put case, upload mesh/final-mesh/
    // tooth, validate-qc, export, archive export, archive import).
    expect(mutating.length).toBeGreaterThanOrEqual(8);

    for (const r of mutating) {
      const response = await app.inject({ method: r.method as 'POST', url: concreteUrl(r.url) });
      expect(
        response.statusCode,
        `${routeKey(r.method, r.url)} must reject unauthenticated (got ${response.statusCode})`,
      ).toBe(401);
      const body = response.json() as { error: string; message: string };
      expect(body.error).toBe('auth-required');
      // No secret / token ever appears in the rejection body.
      expect(JSON.stringify(body)).not.toContain(TOKEN);
    }
  });

  it('EVERY enumerated mutating route ACCEPTS a valid token (never 401)', async () => {
    const mutating = records.filter((r) => MUTATING_METHODS.has(r.method.toUpperCase()));
    for (const r of mutating) {
      const response = await app.inject({
        method: r.method as 'POST',
        url: concreteUrl(r.url),
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      // The request now passes the gate — the status is whatever the handler /
      // validation produces (400/404/415/…), but NEVER 401.
      expect(
        response.statusCode,
        `${routeKey(r.method, r.url)} must not 401 with a valid token (got ${response.statusCode})`,
      ).not.toBe(401);
    }
  });

  it('rejects an INVALID token with 401 auth-invalid', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/cases',
      headers: { authorization: 'Bearer wrong-token' },
      payload: { name: 'x' },
    });
    expect(response.statusCode).toBe(401);
    expect((response.json() as { error: string }).error).toBe('auth-invalid');
  });

  it('accepts the token via the X-DQCAD-Auth header too', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/cases',
      headers: { 'x-dqcad-auth': TOKEN, 'content-type': 'application/json' },
      payload: { name: 'Authed case' },
    });
    expect(response.statusCode).toBe(201);
  });

  // --- Read-only routes stay open ---

  it('leaves read-only GET routes open (no token needed)', async () => {
    for (const url of ['/api/health', '/api/cases', '/api/tooth-library']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, `${url} should be open`).toBe(200);
    }
  });

  // --- The bootstrap seam ---

  it('GET /api/auth/bootstrap returns the active token (open GET)', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/bootstrap' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ token: TOKEN });
  });

  it('a full authenticated create→save round-trip works end-to-end', async () => {
    const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
    const created = await app
      .inject({ method: 'POST', url: '/api/cases', headers: auth, payload: { name: 'Round trip' } })
      .then((r) => r.json() as { id: string });
    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/cases/${created.id}`,
      headers: auth,
      payload: { name: 'Renamed' },
    });
    expect(renamed.statusCode).toBe(200);
  });
});

// --- resolveAuthConfig precedence (ADR-020 §2) ---

describe('resolveAuthConfig precedence', () => {
  const dummyPath = join(tmpdir(), 'dqcad-never-written-auth-token');

  it('explicit null disables the gate', () => {
    expect(resolveAuthConfig({ authToken: null, authTokenPath: dummyPath })).toEqual({
      enabled: false,
      token: null,
    });
  });

  it('explicit string enables with that token', () => {
    expect(resolveAuthConfig({ authToken: 'abc', authTokenPath: dummyPath })).toEqual({
      enabled: true,
      token: 'abc',
    });
  });

  it('an empty explicit token is a loud error (never a silent disable)', () => {
    expect(() => resolveAuthConfig({ authToken: '', authTokenPath: dummyPath })).toThrow();
  });

  it('the env var enables the gate', () => {
    expect(
      resolveAuthConfig({ authTokenPath: dummyPath, env: { DQCAD_AUTH_TOKEN: 'env-tok', NODE_ENV: 'test' } }),
    ).toEqual({ enabled: true, token: 'env-tok' });
  });

  it('NODE_ENV=test with no explicit/env token disables (the test seam)', () => {
    expect(resolveAuthConfig({ authTokenPath: dummyPath, env: { NODE_ENV: 'test' } })).toEqual({
      enabled: false,
      token: null,
    });
  });

  it('a real (non-test) env with no token AUTO-PROVISIONS an enabled 0600 file token', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'dqcad-provision-')), 'auth-token');
    const first = resolveAuthConfig({ authTokenPath: path, env: { NODE_ENV: 'production' } });
    expect(first.enabled).toBe(true);
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
    // Idempotent: a second start reads the SAME persisted token.
    const second = resolveAuthConfig({ authTokenPath: path, env: { NODE_ENV: 'production' } });
    expect(second.token).toBe(first.token);
    rmSync(path, { force: true });
  });
});

// --- the token-compare + extraction primitives ---

describe('auth primitives', () => {
  it('constantTimeEqual is correct for equal/unequal/different-length', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });

  it('extractPresentedToken reads Bearer and X-DQCAD-Auth, else null', () => {
    expect(extractPresentedToken({ authorization: 'Bearer xyz' })).toBe('xyz');
    expect(extractPresentedToken({ authorization: 'bearer  xyz ' })).toBe('xyz');
    expect(extractPresentedToken({ 'x-dqcad-auth': 'qrs' })).toBe('qrs');
    expect(extractPresentedToken({})).toBeNull();
    expect(extractPresentedToken({ authorization: 'Basic zzz' })).toBeNull();
  });
});
