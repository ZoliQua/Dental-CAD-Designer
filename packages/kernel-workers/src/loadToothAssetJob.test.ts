// loadToothAsset job tests (Phase 9 Task 4) — via a real Node worker_threads
// WorkerPool. The format, checksums and watertight gate are covered in
// @dqcad/tooth-library (schema/loader tests); these prove the JOB verifies a
// FETCHED asset (metadata JSON + mesh bytes) exactly like the package loader,
// and refuses a tampered one loudly.
import { afterEach, describe, expect, it } from 'vitest';
import { PREVIOUS_STARTER_TOOTH_METADATA, STARTER_TOOTH_ASSETS, loadToothAssetFromBytes } from '@dqcad/tooth-library';
import { WorkerPool } from './pool.js';

const pools: WorkerPool[] = [];
function createPool(): WorkerPool {
  const pool = new WorkerPool({ size: 1 });
  pools.push(pool);
  return pool;
}
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.destroy()));
});

/** The asset as the server serves it: metadata as parsed JSON, mesh bytes. */
function fetched(fdi: 14 | 11) {
  const starter = STARTER_TOOTH_ASSETS.get(fdi)!;
  return {
    metadataJson: JSON.parse(JSON.stringify(starter.metadata)) as unknown,
    meshBytes: starter.meshBytes.slice(),
  };
}

describe('loadToothAsset job', () => {
  it('verifies a fetched asset and returns exactly what the package loader returns', async () => {
    const pool = createPool();
    const { metadataJson, meshBytes } = fetched(14);
    const result = await pool.run('loadToothAsset', { metadataJson, meshBytes: meshBytes.slice() });
    const direct = loadToothAssetFromBytes(metadataJson, meshBytes);
    expect(Array.from(result.positions)).toEqual(Array.from(direct.mesh.positions));
    expect(Array.from(result.indices)).toEqual(Array.from(direct.mesh.indices));
    expect(result.landmarks).toEqual(direct.landmarks);
    expect(result.canonicalFrame).toEqual(direct.canonicalFrame);
    expect(result.metadata).toEqual({
      fdi: 14,
      version: direct.metadata.version,
      toothType: 'premolar',
      provenance: direct.metadata.provenance,
      assetKind: 'generator',
      meshChecksum: direct.metadata.meshChecksum,
      metadataChecksum: direct.metadata.metadataChecksum,
    });
    // Phase 10 Task 5: the verified cervical ring rides along (the fit needs it).
    expect(direct.metadata.cervicalRing?.length).toBeGreaterThan(8);
    expect(result.cervicalRing).toEqual([...direct.metadata.cervicalRing!]);
  });

  it('returns a null cervical ring for an asset version without one (1.1.0)', async () => {
    const pool = createPool();
    const metadataJson = JSON.parse(JSON.stringify(PREVIOUS_STARTER_TOOTH_METADATA.get(14))) as unknown;
    const result = await pool.run('loadToothAsset', { metadataJson, meshBytes: STARTER_TOOTH_ASSETS.get(14)!.meshBytes.slice() });
    expect(result.metadata.version).toBe('1.1.0');
    expect(result.cervicalRing).toBeNull();
  });

  it('refuses mesh bytes that do not hash to the metadata (ToothMeshChecksumError)', async () => {
    const pool = createPool();
    const { metadataJson, meshBytes } = fetched(11);
    meshBytes[200] = meshBytes[200]! ^ 0xff;
    await expect(pool.run('loadToothAsset', { metadataJson, meshBytes })).rejects.toMatchObject({
      name: 'ToothMeshChecksumError',
    });
  });

  it('refuses tampered metadata (ToothAssetMetadataChecksumError)', async () => {
    const pool = createPool();
    const { metadataJson, meshBytes } = fetched(11);
    (metadataJson as { provenance: string }).provenance = 'PLACEHOLDER-ANATOMY: edited';
    await expect(pool.run('loadToothAsset', { metadataJson, meshBytes })).rejects.toMatchObject({
      name: 'ToothAssetMetadataChecksumError',
    });
  });
});
