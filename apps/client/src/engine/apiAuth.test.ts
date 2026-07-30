// Phase 8 Task 6 — the client auth seam (ADR-020 §3). Proves the frictionless
// opt-in contract: uninitialized → no header (no fetch); initialized → the
// token from the bootstrap is attached; a disabled-gate / failed bootstrap →
// no header (mutations proceed, matching a disabled server gate).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetAuthForTests, authHeaders, initAuth } from './apiAuth';

afterEach(() => {
  __resetAuthForTests();
  vi.unstubAllGlobals();
});

describe('client apiAuth seam', () => {
  it('returns NO header and fires NO fetch when never initialized (frictionless default)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await authHeaders()).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('after initAuth, attaches the bootstrap token as a Bearer header', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ token: 'local-cap-token' }), { status: 200 })),
    );
    await initAuth();
    expect(await authHeaders()).toEqual({ authorization: 'Bearer local-cap-token' });
  });

  it('bootstraps at most once (idempotent)', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ token: 't' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    await Promise.all([initAuth(), initAuth()]);
    await initAuth();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a null token (disabled gate) → no header', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ token: null }), { status: 200 })),
    );
    await initAuth();
    expect(await authHeaders()).toEqual({});
  });

  it('a failed bootstrap → no header (tolerant; mutations still proceed unauthed)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    await initAuth();
    expect(await authHeaders()).toEqual({});
  });

  it('a non-OK bootstrap response → no header', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    await initAuth();
    expect(await authHeaders()).toEqual({});
  });
});
