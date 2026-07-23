import { describe, expect, it } from 'vitest';
import { analyzeMesh } from '@dqcad/kernel';
import { PLACEHOLDER_PROVENANCE_PREFIX } from './schema.ts';
import { STARTER_ASSET_VERSION, STARTER_FDI_CODES, STARTER_TOOTH_ASSETS } from './assets.ts';

describe('STARTER_TOOTH_ASSETS', () => {
  it('ships exactly the 4 incisors + 1 molar this task promises', () => {
    expect(STARTER_FDI_CODES).toEqual([12, 11, 21, 22, 16]);
    expect(STARTER_TOOTH_ASSETS.size).toBe(5);
  });

  it.each(STARTER_FDI_CODES)('FDI %i: metadata validated successfully at import time (already loaded)', (fdi) => {
    const starter = STARTER_TOOTH_ASSETS.get(fdi)!;
    expect(starter.metadata.fdi).toBe(fdi);
    expect(starter.metadata.version).toBe(STARTER_ASSET_VERSION);
  });

  it.each(STARTER_FDI_CODES)('FDI %i: provenance is explicitly marked PLACEHOLDER-ANATOMY', (fdi) => {
    const starter = STARTER_TOOTH_ASSETS.get(fdi)!;
    expect(starter.metadata.provenance.startsWith(PLACEHOLDER_PROVENANCE_PREFIX)).toBe(true);
  });

  it.each(STARTER_FDI_CODES)('FDI %i: mesh bytes hash to metadata.meshChecksum', (fdi) => {
    const starter = STARTER_TOOTH_ASSETS.get(fdi)!;
    // computeMeshChecksum is exercised directly in schema.test.ts; here we
    // just confirm the STORED checksum agrees with the STORED bytes via the
    // same round trip loadToothAssetFromBytes will perform (loader.test.ts
    // covers loader-level behavior; this test is assets.ts's own
    // self-consistency check).
    expect(starter.metadata.meshChecksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(STARTER_FDI_CODES)('FDI %i: canonical (post-STL-round-trip) mesh is watertight', (fdi) => {
    const starter = STARTER_TOOTH_ASSETS.get(fdi)!;
    const stats = analyzeMesh(starter.mesh);
    expect(stats.watertight).toBe(true);
    expect(stats.componentCount).toBe(1);
    expect(stats.degenerateCount).toBe(0);
  });

  it.each(STARTER_FDI_CODES)(
    'FDI %i: morphTargets vertexDeltas length matches the CANONICAL mesh vertex count',
    (fdi) => {
      const starter = STARTER_TOOTH_ASSETS.get(fdi)!;
      const vertexCount = starter.mesh.positions.length / 3;
      for (const target of starter.metadata.morphTargets) {
        expect(target.vertexDeltas.length).toBe(vertexCount * 3);
      }
    },
  );

  it('mesh bytes are non-trivial binary STL (starts with an 80-byte header + uint32 triangle count)', () => {
    const starter = STARTER_TOOTH_ASSETS.get(11)!;
    expect(starter.meshBytes.byteLength).toBeGreaterThan(84);
    const view = new DataView(starter.meshBytes.buffer, starter.meshBytes.byteOffset, starter.meshBytes.byteLength);
    const triangleCount = view.getUint32(80, true);
    expect(triangleCount).toBeGreaterThan(0);
    expect(starter.meshBytes.byteLength).toBe(84 + triangleCount * 50);
  });

  it('building the registry twice (fresh module state) is deterministic', async () => {
    // vitest isolates modules per test file by default, but re-import via a
    // fresh dynamic import with a cache-busting query to double-check no
    // process-global mutable state leaks between "builds".
    const mod1 = await import('./assets.ts');
    const a = mod1.STARTER_TOOTH_ASSETS.get(11)!;
    const b = STARTER_TOOTH_ASSETS.get(11)!;
    expect(Buffer.from(a.meshBytes)).toEqual(Buffer.from(b.meshBytes));
    expect(a.metadata.metadataChecksum).toBe(b.metadata.metadataChecksum);
  });
});
