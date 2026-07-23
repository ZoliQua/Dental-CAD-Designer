import { describe, expect, it } from 'vitest';
import { STARTER_TOOTH_ASSETS } from './assets.ts';
import {
  loadToothAssetFromBytes,
  loadToothAssetInProcess,
  ToothLibraryFdiNotFoundError,
} from './loader.ts';
import {
  computeMeshChecksum,
  computeToothAssetMetadataChecksum,
  ToothAssetMetadataChecksumError,
  ToothMeshChecksumError,
  ToothMeshNotWatertightError,
  type CanonicalFrame,
} from './schema.ts';

const IDENTITY_FRAME: CanonicalFrame = {
  origin: [0, 0, 0],
  mesialDistal: [1, 0, 0],
  buccoLingual: [0, 1, 0],
  occlusoGingival: [0, 0, 1],
};

/** A minimal, structurally-valid binary STL: one triangle — a genuinely
 * OPEN (non-watertight) surface, deliberately, for the watertight-gate
 * test below. */
function singleTriangleStlBytes(): Uint8Array {
  const bytes = new Uint8Array(84 + 50);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, 1, true); // triangle count
  // facet normal (12 bytes, left zero) + 3 vertices (36 bytes) + 2-byte
  // attribute count (left zero).
  view.setFloat32(84 + 12, 0, true);
  view.setFloat32(84 + 16, 0, true);
  view.setFloat32(84 + 20, 0, true);
  view.setFloat32(84 + 24, 1, true);
  view.setFloat32(84 + 28, 0, true);
  view.setFloat32(84 + 32, 0, true);
  view.setFloat32(84 + 36, 0, true);
  view.setFloat32(84 + 40, 1, true);
  view.setFloat32(84 + 44, 0, true);
  return bytes;
}

describe('loadToothAssetInProcess', () => {
  it.each([12, 11, 21, 22, 16] as const)('round-trips FDI %i: mesh + landmarks + frame + morph targets', (fdi) => {
    const asset = loadToothAssetInProcess(fdi);
    expect(asset.metadata.fdi).toBe(fdi);
    expect(asset.mesh.positions.length).toBeGreaterThan(0);
    expect(asset.mesh.indices.length).toBeGreaterThan(0);
    expect(Object.keys(asset.landmarks).length).toBeGreaterThan(0);
    expect(asset.canonicalFrame.origin).toEqual([0, 0, 0]);
    expect(asset.morphTargets.length).toBeGreaterThan(0);
    // The returned mesh vertex count matches every morph target's deltas.
    const vertexCount = asset.mesh.positions.length / 3;
    for (const target of asset.morphTargets) {
      expect(target.vertexDeltas.length).toBe(vertexCount * 3);
    }
  });

  it('throws a typed, loud error for an FDI with no starter asset', () => {
    expect(() => loadToothAssetInProcess(48)).toThrow(ToothLibraryFdiNotFoundError);
  });

  it('is deterministic (repeated in-process loads of the same FDI agree)', () => {
    const a = loadToothAssetInProcess(11);
    const b = loadToothAssetInProcess(11);
    expect(Buffer.from(a.mesh.positions.buffer)).toEqual(Buffer.from(b.mesh.positions.buffer));
    expect(a.metadata.metadataChecksum).toBe(b.metadata.metadataChecksum);
  });
});

describe('loadToothAssetFromBytes', () => {
  it('round-trips a starter asset from its raw metadata + mesh bytes', () => {
    const starter = STARTER_TOOTH_ASSETS.get(11)!;
    const asset = loadToothAssetFromBytes(starter.metadata, starter.meshBytes);
    expect(asset.metadata.fdi).toBe(11);
    expect(asset.mesh.positions.length / 3).toBe(starter.mesh.positions.length / 3);
  });

  it('throws ToothMeshChecksumError when mesh bytes are tampered with', () => {
    const starter = STARTER_TOOTH_ASSETS.get(11)!;
    const tamperedBytes = new Uint8Array(starter.meshBytes);
    // Flip a byte deep inside the triangle data (past the 84-byte header),
    // so the file remains STRUCTURALLY parseable STL but hashes differently.
    tamperedBytes[200] = (tamperedBytes[200]! + 1) % 256;
    expect(() => loadToothAssetFromBytes(starter.metadata, tamperedBytes)).toThrow(ToothMeshChecksumError);
  });

  it('throws ToothAssetMetadataChecksumError when metadata is tampered with', () => {
    const starter = STARTER_TOOTH_ASSETS.get(11)!;
    const tamperedMetadata = { ...starter.metadata, version: '99.0.0' };
    expect(() => loadToothAssetFromBytes(tamperedMetadata, starter.meshBytes)).toThrow(
      ToothAssetMetadataChecksumError,
    );
  });

  it('throws ToothMeshChecksumError (not a silent pass) when bytes belong to a DIFFERENT tooth', () => {
    const eleven = STARTER_TOOTH_ASSETS.get(11)!;
    const twelve = STARTER_TOOTH_ASSETS.get(12)!;
    expect(() => loadToothAssetFromBytes(eleven.metadata, twelve.meshBytes)).toThrow(ToothMeshChecksumError);
  });

  it('throws ToothMeshNotWatertightError for byte-valid but non-watertight mesh bytes', () => {
    // A genuinely open (single-triangle) mesh, with a metadata object whose
    // checksums are computed to GENUINELY match — so both checksum gates
    // pass, and the watertight gate is what's actually under test.
    const meshBytes = singleTriangleStlBytes();
    const meshChecksum = computeMeshChecksum(meshBytes);
    const withoutChecksum = {
      fdi: 11 as const,
      version: '1.0.0',
      toothType: 'incisor' as const,
      provenance: 'PLACEHOLDER-ANATOMY: test fixture (deliberately open mesh)',
      landmarks: { incisalEdge: [0, 0, 1] as const },
      canonicalFrame: IDENTITY_FRAME,
      morphTargets: [],
      meshChecksum,
    };
    const metadataChecksum = computeToothAssetMetadataChecksum(withoutChecksum);
    const rawMetadata = { ...withoutChecksum, metadataChecksum };

    expect(() => loadToothAssetFromBytes(rawMetadata, meshBytes)).toThrow(ToothMeshNotWatertightError);
  });
});
