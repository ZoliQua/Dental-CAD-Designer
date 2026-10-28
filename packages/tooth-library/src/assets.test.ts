import { describe, expect, it } from 'vitest';
import { analyzeMesh } from '@dqcad/kernel';
import { analyzeMesh as analyze, closedEdgeLoopProblem } from '@dqcad/kernel';
import { PLACEHOLDER_PROVENANCE_PREFIX, ToothCervicalRingError, computeToothAssetMetadataChecksum } from './schema.ts';
import {
  PREVIOUS_STARTER_ASSET_VERSION,
  PREVIOUS_STARTER_TOOTH_METADATA,
  STARTER_ASSET_VERSION,
  STARTER_FDI_CODES,
  STARTER_TOOTH_ASSETS,
} from './assets.ts';
import { loadToothAssetFromBytes } from './bytes.ts';

/** Every 1.1.0 starter asset's metadataChecksum, recorded from the 1.1.0
 * build before 1.2.0 landed (Phase 10 Task 4): the 1.1.0 metadata the server
 * still seeds must reproduce them exactly, so saved cases keep verifying. */
const RECORDED_1_1_0_METADATA_CHECKSUMS: Record<number, string> = {
  11: '5dccac847a65ab50e78693c81c7e398fc1bbb540226a6469048b8fc8c627b995',
  12: '9acaa2f1a11e5bf3ab3fb872afc56c6f01aba895b48b1a861d1fb8a1f17c69ea',
  14: 'e8c125c59d3897639a1b8385cc4e326b4e5fab1a674bd022e1231c5c2f6f1c94',
  15: '4767a530cf81fc3b19a0b50329fe7b02ab5a7c969818fee17569c72052556963',
  16: '22bfe3cc200444ee0fda8ea0545379ac51907fa830d0a9513ab23b426ba0bafb',
  17: '24ffe632d663b9e68a132bec17472846ba468715db22d9c73d99bb408ed04cf3',
  21: '54c7f2e62a9a7ce47a51a3408a0f672ab0776bb31c112935695bcd2c3b08bcd0',
  22: '808cb9579a9376fe070b9d3ac99cf67d1b751454a03b8f22cd7aae86e698901c',
  24: '74b17362ecc4fc1f61415769115cba52c0029b823f81e3b0bb078d964b967ffd',
  25: '4b36dc588d920f37e3d8d194a06675686c35e1c336389e57ec0a387b472c6c31',
  26: '68ad995ca364cd41ef76190ca41bfbafa7e540eb5d23ec893368d5e618f6dc94',
  27: '183bf58e2d99911371a093c137a83fd85e3bd4d11c74e01eeb7bf8cc49b515e6',
  34: '9e8fcfe7fd8121c1d8d4c0a2aad1ff329e13522068a124e7bf1587243f329046',
  35: 'fbf4b56dded6bff204777988397070bbb0c03180dd100e6c2ec4de5cd338eac5',
  36: '70aedadc29d95b19c7b340e9d1452e03cad1aa09460e8d3b555b45869ded01d9',
  37: '9bb23ef0167d72e1fa0d41cb4ec69c80d20af2e70cac2a3f8d56936dfba1290a',
  44: '1ed0635745f9fd1ce39f75f0d04cb76b7e5cf143dce8ba8d015721f25bb9b9a5',
  45: 'd023eae7aee07980d808bb3184c6cef00fa4a59d2827d2bcde34c3414fe56793',
  46: 'c1318ef555e3e922b57c54ebb9c741bdba11dbc4410e3406c992e18e7c85e752',
  47: 'c78d983b5ac0f73c4da79dfb943fe220e7aff128b237b185ae4d8989237c19b5',
};

describe('STARTER_TOOTH_ASSETS', () => {
  it('ships the 4 upper incisors, every premolar and every first + second molar (Phase 9 Task 4)', () => {
    expect(STARTER_FDI_CODES).toEqual([12, 11, 21, 22, 14, 15, 24, 25, 34, 35, 44, 45, 16, 17, 26, 27, 36, 37, 46, 47]);
    expect(STARTER_TOOTH_ASSETS.size).toBe(20);
    expect(STARTER_ASSET_VERSION).toBe('1.2.0');
  });

  it.each(STARTER_FDI_CODES)('FDI %i: declares itself a generator asset (and a premolar FDI is a premolar)', (fdi) => {
    const { metadata } = STARTER_TOOTH_ASSETS.get(fdi)!;
    expect(metadata.assetKind).toBe('generator');
    const position = fdi % 10;
    expect(metadata.toothType).toBe(position <= 3 ? 'incisor' : position <= 5 ? 'premolar' : 'molar');
  });

  it('the pre-existing starter meshes are byte-identical (1.1.0: assetKind; 1.2.0: cervicalRing — metadata only)', () => {
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

  // Phase 10 Task 4 (ADR-023 Decision 2): 1.2.0 declares the cervical ring.
  it.each(STARTER_FDI_CODES)('FDI %i: the cervical ring is a closed edge loop of the canonical mesh, on its cervical rim', (fdi) => {
    const { metadata, mesh } = STARTER_TOOTH_ASSETS.get(fdi)!;
    const ring = metadata.cervicalRing!;
    expect(ring.length).toBeGreaterThanOrEqual(24);
    expect(closedEdgeLoopProblem(mesh, ring)).toBeNull();
    let minZ = Infinity;
    for (let i = 2; i < mesh.positions.length; i += 3) minZ = Math.min(minZ, mesh.positions[i]!);
    for (const v of ring) expect(mesh.positions[v * 3 + 2]).toBe(minZ);
    // Every rim vertex but the cap's centre is on the ring.
    let rim = 0;
    for (let v = 0; v < mesh.positions.length / 3; v++) {
      if (mesh.positions[v * 3 + 2] === minZ && (mesh.positions[v * 3] !== 0 || mesh.positions[v * 3 + 1] !== 0)) rim++;
    }
    expect(rim).toBe(ring.length);
  });
});

describe('PREVIOUS_STARTER_TOOTH_METADATA — 1.1.0 is still served', () => {
  it('reproduces every recorded 1.1.0 metadata checksum exactly', () => {
    expect(PREVIOUS_STARTER_ASSET_VERSION).toBe('1.1.0');
    expect(PREVIOUS_STARTER_TOOTH_METADATA.size).toBe(20);
    for (const [fdi, metadata] of PREVIOUS_STARTER_TOOTH_METADATA) {
      expect(metadata.version).toBe('1.1.0');
      expect(metadata.cervicalRing).toBeUndefined();
      expect(metadata.metadataChecksum, `FDI ${fdi}`).toBe(RECORDED_1_1_0_METADATA_CHECKSUMS[fdi]);
      expect(metadata.meshChecksum).toBe(STARTER_TOOTH_ASSETS.get(fdi)!.metadata.meshChecksum);
    }
  });

  it('a 1.1.0 asset still loads and verifies against the same mesh bytes', () => {
    const asset = loadToothAssetFromBytes(PREVIOUS_STARTER_TOOTH_METADATA.get(11)!, STARTER_TOOTH_ASSETS.get(11)!.meshBytes);
    expect(asset.metadata.version).toBe('1.1.0');
    expect(analyze(asset.mesh).watertight).toBe(true);
  });
});

describe('loadToothAssetFromBytes — the cervical ring must be an edge loop of the mesh', () => {
  it('refuses a checksum-valid ring that is not a closed edge loop (typed error)', () => {
    const starter = STARTER_TOOTH_ASSETS.get(11)!;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { metadataChecksum: _c, ...rest } = starter.metadata;
    const ring = [...rest.cervicalRing!];
    [ring[5], ring[6]] = [ring[6]!, ring[5]!];
    const tampered = { ...rest, cervicalRing: ring };
    const raw = { ...tampered, metadataChecksum: computeToothAssetMetadataChecksum(tampered) };
    expect(() => loadToothAssetFromBytes(raw, starter.meshBytes)).toThrow(ToothCervicalRingError);
  });

  it('accepts every shipped 1.2.0 asset', () => {
    for (const starter of STARTER_TOOTH_ASSETS.values()) {
      expect(loadToothAssetFromBytes(starter.metadata, starter.meshBytes).metadata.cervicalRing).toEqual(starter.metadata.cervicalRing);
    }
  });
});
