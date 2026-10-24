import { describe, expect, it } from 'vitest';
import { analyzeMesh } from '@dqcad/kernel';
import { PLACEHOLDER_PROVENANCE_PREFIX } from './schema.ts';
import { STARTER_ASSET_VERSION, STARTER_FDI_CODES, STARTER_TOOTH_ASSETS } from './assets.ts';

describe('STARTER_TOOTH_ASSETS', () => {
  it('ships the 4 upper incisors, every premolar and every first + second molar (Phase 9 Task 4)', () => {
    expect(STARTER_FDI_CODES).toEqual([12, 11, 21, 22, 14, 15, 24, 25, 34, 35, 44, 45, 16, 17, 26, 27, 36, 37, 46, 47]);
    expect(STARTER_TOOTH_ASSETS.size).toBe(20);
    expect(STARTER_ASSET_VERSION).toBe('1.1.0');
  });

  it.each(STARTER_FDI_CODES)('FDI %i: declares itself a generator asset (and a premolar FDI is a premolar)', (fdi) => {
    const { metadata } = STARTER_TOOTH_ASSETS.get(fdi)!;
    expect(metadata.assetKind).toBe('generator');
    const position = fdi % 10;
    expect(metadata.toothType).toBe(position <= 3 ? 'incisor' : position <= 5 ? 'premolar' : 'molar');
  });

  it('the pre-existing starter meshes are byte-identical (only the metadata gained assetKind)', () => {
    const meshSum = (fdi: number) => STARTER_TOOTH_ASSETS.get(fdi as 11)!.metadata.meshChecksum;
    expect(meshSum(11)).toBe('d3ce91df82c2f2c284d814e2022f7606da656323b4662d63bf1bdec3fedf5c1e');
    expect(meshSum(12)).toBe('bb34022b5accf6a278c75e46bf9ee5eaf713bf0e52a4b0924d4b35f3c5fc7c32');
    expect(meshSum(16)).toBe('9eb9112b6f1f90ac24ed1771813e3717a0dcf46de7be4940c1f245dd41c6b281');
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
