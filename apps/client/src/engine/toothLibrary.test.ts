// apps/client/src/engine/toothLibrary.test.ts
//
// Phase 9 Task 4 — the anatomy for a restoration's FDI comes from the server
// tooth library, verified in a worker; every way that can fail falls back to
// the parametric placeholder WITH a named reason (never silently).
import { afterEach, describe, expect, it } from 'vitest';
import type { FdiTooth } from '@dqcad/shared-types';
import {
  __resetToothLibraryCacheForTests,
  resolveLibraryTooth,
  type ToothLibraryDeps,
} from './toothLibrary';

const METADATA = { fdi: 14, meshChecksum: 'a'.repeat(64) };
const RESULT = {
  positions: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
  indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]),
  landmarks: { buccalCusp: [0, 1, 7] },
  canonicalFrame: {
    origin: [0, 0, 0],
    mesialDistal: [1, 0, 0],
    buccoLingual: [0, 1, 0],
    occlusoGingival: [0, 0, 1],
  },
  metadata: {
    fdi: 14,
    version: '1.1.0',
    toothType: 'premolar',
    provenance: 'PLACEHOLDER-ANATOMY: generated',
    assetKind: 'generator',
    meshChecksum: 'a'.repeat(64),
    metadataChecksum: 'b'.repeat(64),
  },
};

function deps(overrides: Partial<ToothLibraryDeps> & { jobError?: Error } = {}) {
  const urls: string[] = [];
  const jobs: unknown[] = [];
  const d: ToothLibraryDeps = {
    serverStatus: () => 'online',
    fetch: (async (url: string) => {
      urls.push(url);
      if (url.endsWith('/api/tooth-library/14')) return Response.json(METADATA);
      if (url.endsWith(`/api/meshes/${'a'.repeat(64)}`))
        return new Response(new Uint8Array([1, 2, 3]));
      return new Response('not found', { status: 404 });
    }) as typeof fetch,
    pool: {
      run: (async (job: string, payload: unknown) => {
        jobs.push({ job, payload });
        if (overrides.jobError) throw overrides.jobError;
        return RESULT;
      }) as ToothLibraryDeps['pool']['run'],
    },
    ...overrides,
  };
  return { d, urls, jobs };
}

afterEach(() => __resetToothLibraryCacheForTests());

describe('resolveLibraryTooth', () => {
  it('fetches metadata + mesh bytes, verifies them in the loadToothAsset job, and labels the source', async () => {
    const { d, urls, jobs } = deps();
    const r = await resolveLibraryTooth(14 as FdiTooth, d);
    expect(urls).toEqual(['/api/tooth-library/14', `/api/meshes/${'a'.repeat(64)}`]);
    expect(jobs).toEqual([
      {
        job: 'loadToothAsset',
        payload: { metadataJson: METADATA, meshBytes: new Uint8Array([1, 2, 3]) },
      },
    ]);
    expect(r.tooth?.positions).toBe(RESULT.positions);
    expect(r.source).toEqual({
      origin: 'library',
      fdi: 14,
      version: '1.1.0',
      toothType: 'premolar',
      assetKind: 'generator',
      provenance: 'PLACEHOLDER-ANATOMY: generated',
      meshChecksum: 'a'.repeat(64),
      metadataChecksum: 'b'.repeat(64),
    });
  });

  it('client-only mode (no server): the placeholder, without any request', async () => {
    const { d, urls } = deps({ serverStatus: () => 'offline' });
    const r = await resolveLibraryTooth(14 as FdiTooth, d);
    expect(urls).toEqual([]);
    expect(r.tooth).toBeNull();
    expect(r.source).toEqual({ origin: 'builtin', reason: 'offline', detail: null });
  });

  it('an FDI the library does not have: the placeholder, reason fdiMissing', async () => {
    const { d } = deps();
    const r = await resolveLibraryTooth(18 as FdiTooth, d);
    expect(r.source).toMatchObject({ origin: 'builtin', reason: 'fdiMissing' });
  });

  it('an unreachable server: the placeholder, reason unavailable', async () => {
    const { d } = deps({
      fetch: (async () => {
        throw new TypeError('Failed to fetch');
      }) as typeof fetch,
    });
    const r = await resolveLibraryTooth(14 as FdiTooth, d);
    expect(r.source).toEqual({
      origin: 'builtin',
      reason: 'unavailable',
      detail: 'TypeError: Failed to fetch',
    });
  });

  it('an asset failing checksum verification is never placed: the placeholder, reason verificationFailed, error named', async () => {
    const err = new Error('mesh bytes for FDI 14 do not match metadata.meshChecksum');
    err.name = 'ToothMeshChecksumError';
    const { d } = deps({ jobError: err });
    const r = await resolveLibraryTooth(14 as FdiTooth, d);
    expect(r.tooth).toBeNull();
    expect(r.source).toMatchObject({ origin: 'builtin', reason: 'verificationFailed' });
    expect(r.source.origin === 'builtin' && r.source.detail).toMatch(/^ToothMeshChecksumError/);
  });

  it('caches a verified asset per FDI (one fetch), but never a failure', async () => {
    const ok = deps();
    await resolveLibraryTooth(14 as FdiTooth, ok.d);
    await resolveLibraryTooth(14 as FdiTooth, ok.d);
    expect(ok.urls).toHaveLength(2);
    const missing = deps();
    await resolveLibraryTooth(18 as FdiTooth, missing.d);
    await resolveLibraryTooth(18 as FdiTooth, missing.d);
    expect(missing.urls).toHaveLength(2);
  });
});
