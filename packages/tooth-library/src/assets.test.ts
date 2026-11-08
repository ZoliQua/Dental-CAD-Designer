import { describe, expect, it } from 'vitest';
import { analyzeMesh } from '@dqcad/kernel';
import { analyzeMesh as analyze, closedEdgeLoopProblem } from '@dqcad/kernel';
import { PLACEHOLDER_PROVENANCE_PREFIX, ToothCervicalRingError, computeToothAssetMetadataChecksum } from './schema.ts';
import {
  SERVED_STARTER_VERSIONS,
  STARTER_ASSET_VERSION,
  STARTER_FDI_CODES,
  STARTER_TOOTH_ASSETS,
  STARTER_TOOTH_ASSETS_BY_VERSION,
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

/** Every 1.2.0 starter asset's metadataChecksum and meshChecksum, recorded
 * from the 1.2.0 build before 1.3.0 landed (Phase 11 Task 3): the frozen
 * `_V1` incisor tables and the unchanged posterior generators must
 * reproduce them exactly, so saved cases keep verifying. */
const RECORDED_1_2_0_METADATA_CHECKSUMS: Record<number, string> = {
  11: '9361bbcaca39c13b1b01a416ede18e6afd1b2f0c17d8de7aa9b95bddd98f44ec',
  12: 'a27ca29b6645ada06a0c051441aa57de3fc7157c0e9ea6a1a53f643964eb6211',
  14: '005c88ab218a65234244e67ad9eb1b2cc62f8f6474c17c0fc40b89bdb9e1129e',
  15: 'bad8971622440c3e7108fc7c2b605aee53ec31244f7713694d4854fb8d5fbd81',
  16: '14bb2de96bc1757b8a8ea970a3e9de47602e8735fb1f3eb94ea43adb945d6e9b',
  17: 'ecd43a63cfb7c572b571f4cba2f172a6a72739dc6194f03603a45120933ee031',
  21: 'b39cfde0d3110b8e2e3c95b260d160276102605593976921b06c004fc1dd347e',
  22: '489fd8c9ec523657cd3cc33f38f3be7c74dbe54ec532918b7c7fbe0a94c529ae',
  24: 'bcf4ed116e41ca438a5d4f4382e1ff9fd321dcad5b4c789050c746914fa6d492',
  25: 'f6f988f59c4d42271d16516a956cab0b2d20d873b632e552b5e4f84fd8e15365',
  26: '20b3dae672b1d091894a3651ecb080e1e05544dd1ef0adba2f09d4a020c75b5e',
  27: 'ba25fd759152514e2beae6ca30866b7a8af6075a00b8ff4523d8264536e31778',
  34: 'b179f8743c87e8a4c7a4403a54013fc1b0e811572a3ea1ac8f117bf2a8c27328',
  35: 'bf821086b84c85c4006695ec7dd6bd7286444b026b14f2e01abad97f263868cc',
  36: '6d6432226d226221bcdce4420091d83713b17ade95f720dd4f51835baaf32acb',
  37: 'd791af60b54340ea68e8c100c3e346d9ce25e27be0b76b60376cd839485dceac',
  44: 'd605c2fc362ceccdc07101f90307136a7f03c9190c9709d0443174691308d298',
  45: '4bb46a07c29e015ea4fc4dbb7f5252e63458682934110d588c4c9ffa680e0dbc',
  46: '899dbdaa68cc92bd3760775f6c4e515263979c226be74c0f414f94f731966c74',
  47: '253755ffd1d22f6bbdb0a5230227e09d2e720a3183e5a54975f5cda1e522e334',
};
const RECORDED_1_2_0_MESH_CHECKSUMS: Record<number, string> = {
  11: 'd3ce91df82c2f2c284d814e2022f7606da656323b4662d63bf1bdec3fedf5c1e',
  12: 'bb34022b5accf6a278c75e46bf9ee5eaf713bf0e52a4b0924d4b35f3c5fc7c32',
  14: 'a629129f1c65716f0bfd1adbb5ca2dcc36a3534803c15988ece03fd1bcfe0a8a',
  15: 'f018b41a90f96f35039972e94f4b84b8afcc8fd4636d4e1cd738c25949a6e3fb',
  16: '9eb9112b6f1f90ac24ed1771813e3717a0dcf46de7be4940c1f245dd41c6b281',
  17: 'dbef90eb381f41270a8ead27c8cb7c2deb36765fa5a368d6ffbdf53099ccc4cd',
  21: 'd3ce91df82c2f2c284d814e2022f7606da656323b4662d63bf1bdec3fedf5c1e',
  22: 'bb34022b5accf6a278c75e46bf9ee5eaf713bf0e52a4b0924d4b35f3c5fc7c32',
  24: 'a629129f1c65716f0bfd1adbb5ca2dcc36a3534803c15988ece03fd1bcfe0a8a',
  25: 'f018b41a90f96f35039972e94f4b84b8afcc8fd4636d4e1cd738c25949a6e3fb',
  26: '9eb9112b6f1f90ac24ed1771813e3717a0dcf46de7be4940c1f245dd41c6b281',
  27: 'dbef90eb381f41270a8ead27c8cb7c2deb36765fa5a368d6ffbdf53099ccc4cd',
  34: 'da314c865b7a3581e76787ab556253f0de12fbd03eba41139aa7f1c9d9939222',
  35: '92b7679f2f6991499b57dc0fdccd92a25ff34a695f07d621bd335018480f5930',
  36: '7f49f55ecc1b49db8443c07c05b5e2ced7960d70a784fcb93ca4428e626107e1',
  37: 'c87883e4d06f879c2fa42ce7e5af4cc9825cd06fc188f531094c125b44411f05',
  44: 'da314c865b7a3581e76787ab556253f0de12fbd03eba41139aa7f1c9d9939222',
  45: '92b7679f2f6991499b57dc0fdccd92a25ff34a695f07d621bd335018480f5930',
  46: '7f49f55ecc1b49db8443c07c05b5e2ced7960d70a784fcb93ca4428e626107e1',
  47: 'c87883e4d06f879c2fa42ce7e5af4cc9825cd06fc188f531094c125b44411f05',
};

const INCISORS = new Set([11, 12, 21, 22]);

describe('STARTER_TOOTH_ASSETS', () => {
  it('ships the 4 upper incisors, every premolar and every first + second molar (Phase 9 Task 4)', () => {
    expect(STARTER_FDI_CODES).toEqual([12, 11, 21, 22, 14, 15, 24, 25, 34, 35, 44, 45, 16, 17, 26, 27, 36, 37, 46, 47]);
    expect(STARTER_TOOTH_ASSETS.size).toBe(20);
    expect(STARTER_ASSET_VERSION).toBe('1.3.0');
  });

  it.each(STARTER_FDI_CODES)('FDI %i: declares itself a generator asset (and a premolar FDI is a premolar)', (fdi) => {
    const { metadata } = STARTER_TOOTH_ASSETS.get(fdi)!;
    expect(metadata.assetKind).toBe('generator');
    const position = fdi % 10;
    expect(metadata.toothType).toBe(position <= 3 ? 'incisor' : position <= 5 ? 'premolar' : 'molar');
  });

  it('the premolar and molar meshes are byte-identical to 1.2.0; the incisor meshes changed (1.3.0: proportions)', () => {
    for (const [fdi, starter] of STARTER_TOOTH_ASSETS) {
      if (INCISORS.has(fdi)) expect(starter.metadata.meshChecksum, `FDI ${fdi}`).not.toBe(RECORDED_1_2_0_MESH_CHECKSUMS[fdi]);
      else expect(starter.metadata.meshChecksum, `FDI ${fdi}`).toBe(RECORDED_1_2_0_MESH_CHECKSUMS[fdi]);
    }
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

describe('STARTER_TOOTH_ASSETS_BY_VERSION — every released version is still served (Phase 11 Task 3)', () => {
  it('serves 1.1.0, 1.2.0 and 1.3.0; the current one is STARTER_TOOTH_ASSETS', () => {
    expect(SERVED_STARTER_VERSIONS).toEqual(['1.1.0', '1.2.0', '1.3.0']);
    expect([...STARTER_TOOTH_ASSETS_BY_VERSION.keys()]).toEqual(['1.1.0', '1.2.0', '1.3.0']);
    expect(STARTER_TOOTH_ASSETS_BY_VERSION.get(STARTER_ASSET_VERSION)).toBe(STARTER_TOOTH_ASSETS);
    for (const set of STARTER_TOOTH_ASSETS_BY_VERSION.values()) expect([...set.keys()]).toEqual(STARTER_FDI_CODES);
  });

  it('1.2.0 reproduces every recorded 1.2.0 metadata and mesh checksum exactly', () => {
    for (const [fdi, starter] of STARTER_TOOTH_ASSETS_BY_VERSION.get('1.2.0')!) {
      expect(starter.metadata.version).toBe('1.2.0');
      expect(starter.metadata.metadataChecksum, `FDI ${fdi}`).toBe(RECORDED_1_2_0_METADATA_CHECKSUMS[fdi]);
      expect(starter.metadata.meshChecksum, `FDI ${fdi}`).toBe(RECORDED_1_2_0_MESH_CHECKSUMS[fdi]);
    }
  });

  it('1.1.0 reproduces every recorded 1.1.0 metadata checksum exactly, on the 1.2.0 meshes', () => {
    for (const [fdi, starter] of STARTER_TOOTH_ASSETS_BY_VERSION.get('1.1.0')!) {
      expect(starter.metadata.version).toBe('1.1.0');
      expect(starter.metadata.cervicalRing).toBeUndefined();
      expect(starter.metadata.metadataChecksum, `FDI ${fdi}`).toBe(RECORDED_1_1_0_METADATA_CHECKSUMS[fdi]);
      expect(starter.metadata.meshChecksum).toBe(RECORDED_1_2_0_MESH_CHECKSUMS[fdi]);
    }
  });

  it.each(SERVED_STARTER_VERSIONS)('every %s asset loads and verifies against its own mesh bytes', (version) => {
    for (const starter of STARTER_TOOTH_ASSETS_BY_VERSION.get(version)!.values()) {
      const asset = loadToothAssetFromBytes(starter.metadata, starter.meshBytes);
      expect(asset.metadata.version).toBe(version);
      expect(analyze(asset.mesh).watertight).toBe(true);
    }
  });
});

describe('the 1.3.0 incisors have textbook cervical proportions (ADR-024 Decision 3)', () => {
  /** The cervical ring's extent: mesio-distal (x) and bucco-lingual (y). */
  function ringExtent(fdi: number): { md: number; bl: number } {
    const { metadata, mesh } = STARTER_TOOTH_ASSETS.get(fdi as 11)!;
    const xs = metadata.cervicalRing!.map((v) => mesh.positions[v * 3]!);
    const ys = metadata.cervicalRing!.map((v) => mesh.positions[v * 3 + 1]!);
    return { md: Math.max(...xs) - Math.min(...xs), bl: Math.max(...ys) - Math.min(...ys) };
  }

  it.each([11, 21])('central %i: the cervix is 7.0 × 6.0 mm (± 0.05)', (fdi) => {
    const { md, bl } = ringExtent(fdi);
    expect(Math.abs(md - 7.0)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(bl - 6.0)).toBeLessThanOrEqual(0.05);
  });

  it.each([12, 22])('lateral %i: the cervix is 5.0 × 5.0 mm (± 0.05)', (fdi) => {
    const { md, bl } = ringExtent(fdi);
    expect(Math.abs(md - 5.0)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(bl - 5.0)).toBeLessThanOrEqual(0.05);
  });

  it.each([
    [11, 8.5],
    [12, 6.5],
  ])('FDI %i: the mesio-distal width at the contact level is %f mm (± 0.05)', (fdi, expected) => {
    const { metadata } = STARTER_TOOTH_ASSETS.get(fdi as 11)!;
    const mesial = metadata.landmarks.mesialContact!, distal = metadata.landmarks.distalContact!;
    expect(Math.abs(Math.abs(distal[0] - mesial[0]) - expected)).toBeLessThanOrEqual(0.05);
  });

  it.each([11, 12])('FDI %i: the incisal edge is about 1.2 mm thick (1.0–1.5 mm on the last ring)', (fdi) => {
    const { mesh } = STARTER_TOOTH_ASSETS.get(fdi as 11)!;
    // The last ring: the highest z below the apex.
    const zs = [...new Set(Array.from(mesh.positions.filter((_, i) => i % 3 === 2)))].sort((a, b) => b - a);
    const lastRingZ = zs[1]!;
    const ys: number[] = [];
    for (let v = 0; v < mesh.positions.length / 3; v++) if (mesh.positions[v * 3 + 2] === lastRingZ) ys.push(mesh.positions[v * 3 + 1]!);
    const thickness = Math.max(...ys) - Math.min(...ys);
    expect(thickness).toBeGreaterThanOrEqual(1.0);
    expect(thickness).toBeLessThanOrEqual(1.5);
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

  it('accepts every shipped 1.3.0 asset', () => {
    for (const starter of STARTER_TOOTH_ASSETS.values()) {
      expect(loadToothAssetFromBytes(starter.metadata, starter.meshBytes).metadata.cervicalRing).toEqual(starter.metadata.cervicalRing);
    }
  });
});
