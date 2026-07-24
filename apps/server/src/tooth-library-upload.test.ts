// apps/server/src/tooth-library-upload.test.ts
//
// Phase 4 Task 11 — admin upload of a tooth-library asset: content-addressed +
// versioned + schema/checksum/watertight validated server-side, write-once.
// A valid asset stores + is fetchable via the GET routes; a tampered checksum
// or non-watertight mesh is rejected loudly (4xx); a byte-identical re-upload
// is idempotent; a conflicting (same fdi+version, different bytes) asset is a
// 409 integrity error; a malformed body is a 400.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  STARTER_TOOTH_ASSETS,
  computeToothAssetMetadataChecksum,
  type ToothAssetMetadata,
} from '@dqcad/tooth-library';
import { buildApp } from './app.js';

const FDI = 11;

function baseAsset(): { metadata: ToothAssetMetadata; meshBytes: Uint8Array } {
  const starter = STARTER_TOOTH_ASSETS.get(FDI);
  if (!starter) throw new Error('missing starter asset for FDI 11');
  return { metadata: starter.metadata, meshBytes: starter.meshBytes };
}

function withoutChecksum(meta: ToothAssetMetadata): Omit<ToothAssetMetadata, 'metadataChecksum'> {
  const clone: Partial<ToothAssetMetadata> = { ...meta };
  delete clone.metadataChecksum;
  return clone as Omit<ToothAssetMetadata, 'metadataChecksum'>;
}

/** Re-versions a valid asset's metadata (re-deriving `metadataChecksum` so it
 * stays a genuinely valid asset), optionally perturbing `provenance` so two
 * distinct-content assets can share a version for the conflict test. */
function reversion(meta: ToothAssetMetadata, version: string, provenanceSuffix = ''): ToothAssetMetadata {
  const rest = withoutChecksum(meta);
  const next = { ...rest, version, provenance: rest.provenance + provenanceSuffix };
  return { ...next, metadataChecksum: computeToothAssetMetadataChecksum(next) };
}

/** A valid asset whose `meshChecksum` is swapped (and `metadataChecksum`
 * re-derived so ONLY the mesh-byte checksum gate can fire). */
function withMeshChecksum(meta: ToothAssetMetadata, meshChecksum: string): ToothAssetMetadata {
  const next = { ...withoutChecksum(meta), meshChecksum };
  return { ...next, metadataChecksum: computeToothAssetMetadataChecksum(next) };
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** A minimal 1-triangle binary STL — parses fine but is NOT watertight. */
function singleTriangleStl(): Uint8Array {
  const buf = new ArrayBuffer(84 + 50);
  const dv = new DataView(buf);
  dv.setUint32(80, 1, true);
  const floats = [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0]; // normal + 3 verts
  let off = 84;
  for (const f of floats) {
    dv.setFloat32(off, f, true);
    off += 4;
  }
  return new Uint8Array(buf);
}

describe('POST /api/tooth-library — admin asset upload (content-addressed, versioned, validated)', () => {
  let app: FastifyInstance;
  let meshDataDir: string;
  let toothLibraryDataDir: string;

  beforeEach(async () => {
    meshDataDir = mkdtempSync(join(tmpdir(), 'dqcad-upload-mesh-'));
    toothLibraryDataDir = mkdtempSync(join(tmpdir(), 'dqcad-upload-tooth-'));
    app = await buildApp({ meshDataDir, toothLibraryDataDir });
  });

  afterEach(async () => {
    await app.close();
    rmSync(meshDataDir, { recursive: true, force: true });
    rmSync(toothLibraryDataDir, { recursive: true, force: true });
  });

  const upload = (metadata: ToothAssetMetadata, meshBytes: Uint8Array) =>
    app.inject({ method: 'POST', url: '/api/tooth-library', payload: { metadata, meshBase64: b64(meshBytes) } });

  it('stores a valid asset (content-addressed + versioned) and serves it back via the GET routes', async () => {
    const { metadata, meshBytes } = baseAsset();
    const v2 = reversion(metadata, '2.0.0');

    const res = await upload(v2, meshBytes);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual(v2);

    // GET returns the LATEST version (2.0.0 > the seeded 1.0.0).
    const getRes = await app.inject({ method: 'GET', url: `/api/tooth-library/${FDI}` });
    expect(getRes.statusCode).toBe(200);
    expect((getRes.json() as ToothAssetMetadata).version).toBe('2.0.0');

    // The mesh bytes are content-addressed in the P1 store, fetchable by the
    // asset's own meshChecksum, and really hash to it.
    const meshRes = await app.inject({ method: 'GET', url: `/api/meshes/${v2.meshChecksum}` });
    expect(meshRes.statusCode).toBe(200);
    expect(createHash('sha256').update(meshRes.rawPayload).digest('hex')).toBe(v2.meshChecksum);
  });

  it('is idempotent on a byte-identical re-upload of the same version', async () => {
    const { metadata, meshBytes } = baseAsset();
    const v2 = reversion(metadata, '2.0.0');
    const first = await upload(v2, meshBytes);
    const second = await upload(v2, meshBytes);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
  });

  it('409s a conflicting upload (same fdi+version, DIFFERENT content — a version is immutable)', async () => {
    const { metadata, meshBytes } = baseAsset();
    const variantA = reversion(metadata, '2.0.0', ' [variant A]');
    const variantB = reversion(metadata, '2.0.0', ' [variant B]');

    expect((await upload(variantA, meshBytes)).statusCode).toBe(201);
    const conflict = await upload(variantB, meshBytes);
    expect(conflict.statusCode).toBe(409);
  });

  it('rejects a TAMPERED mesh checksum with 400 (never trusts the claimed checksum)', async () => {
    const { metadata, meshBytes } = baseAsset();
    const tampered = withMeshChecksum(reversion(metadata, '2.0.0'), 'f'.repeat(64));
    const res = await upload(tampered, meshBytes);
    expect(res.statusCode).toBe(400);
  });

  it('rejects a NON-WATERTIGHT mesh with 400', async () => {
    const { metadata } = baseAsset();
    const bad = singleTriangleStl();
    const meshChecksum = createHash('sha256').update(bad).digest('hex');
    const asset = withMeshChecksum(reversion(metadata, '2.0.0'), meshChecksum);
    const res = await upload(asset, bad);
    expect(res.statusCode).toBe(400);
  });

  it('rejects a malformed upload body with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tooth-library',
      payload: { metadata: { fdi: FDI }, meshBase64: 'AAAA' },
    });
    expect(res.statusCode).toBe(400);
  });
});
