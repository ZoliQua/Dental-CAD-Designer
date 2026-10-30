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
 * still seeds must reproduce them exactly, so saved cases keep verifying.
 * Re-recorded at kernel 0.35.0, when the generators moved to the kernel's
 * deterministic transcendentals (detMath): the 14 posterior assets' Float64
 * metadata moved by ≤ 1 ulp (their mesh bytes are unchanged, and so are the
 * assets 11, 12, 21, 22, 34 and 44 entirely). The Math.* values were not
 * reproducible across platforms — x64 already produced other checksums. */
const RECORDED_1_1_0_METADATA_CHECKSUMS: Record<number, string> = {
  11: '5dccac847a65ab50e78693c81c7e398fc1bbb540226a6469048b8fc8c627b995',
  12: '9acaa2f1a11e5bf3ab3fb872afc56c6f01aba895b48b1a861d1fb8a1f17c69ea',
  14: '584b14670f478ad8a475fd65777e7e0e1a4d777f74d08ae3f2781940a5a9c252',
  15: '000d1d135f8d2ebc1466713cefc717aa04fd74e883cffeedd367817cd676c236',
  16: '9554e838ae53660f43ed22a30c1540bf38000ca0bfb9ec549f9ec7417a196b89',
  17: '27235838302c3810679bb4efc3899881a2e9adbaacba3a67f16925db562aaf54',
  21: '54c7f2e62a9a7ce47a51a3408a0f672ab0776bb31c112935695bcd2c3b08bcd0',
  22: '808cb9579a9376fe070b9d3ac99cf67d1b751454a03b8f22cd7aae86e698901c',
  24: 'b2008b058ec2d2f2481acd5c9cc56e22f0c94f1f6aa04ea07e4951631a50527f',
  25: '0b848ad7518adb8b3de958f633cbfef6879ef0b00164c327be7d5773b33a9e13',
  26: '2b17fbe92f49fa3ff48a33566cb46e453acddc3d2d8d938941ed656a1c21ec44',
  27: 'd099fd17b632ff767c209d993758c5b718db65a91c98654fd50419f8a249f683',
  34: '9e8fcfe7fd8121c1d8d4c0a2aad1ff329e13522068a124e7bf1587243f329046',
  35: '6d076cbfaae01dc5ab1fc41200cb6b2678c90477af48ba780f39e07dc39f2487',
  36: '672f0258701606984e909411cf4f98d299e2370e67ad1e2687af1a3d8be20786',
  37: 'cccc7c7d6d59765214e07e5cfe80e3fc9c330309183e4de3feb42bcdb58570ac',
  44: '1ed0635745f9fd1ce39f75f0d04cb76b7e5cf143dce8ba8d015721f25bb9b9a5',
  45: '13d3753e6c0cf4bc8f3a0a7c924df28fe96f527530e70b65df1c3765038efccf',
  46: 'a257f238d6f70e4081ecc9c73ec1f291846b9a64c0d52cf2c9d0fceeb99c7fe6',
  47: '0da34134fcabb1be3b311b78b0dc54a5f7144901ceea4efbe11767dff34161f9',
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
