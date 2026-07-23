import { describe, expect, it } from 'vitest';
import {
  assertOrthonormalFrame,
  computeMeshChecksum,
  computeToothAssetMetadataChecksum,
  loadToothAssetMetadata,
  ToothAssetMetadataChecksumError,
  ToothAssetMetadataValidationError,
  validateToothAssetMetadataShape,
  type CanonicalFrame,
  type ToothAssetMetadata,
} from './schema.ts';

const IDENTITY_FRAME: CanonicalFrame = {
  origin: [0, 0, 0],
  mesialDistal: [1, 0, 0],
  buccoLingual: [0, 1, 0],
  occlusoGingival: [0, 0, 1],
};

function baseMetadataWithoutChecksum(): Omit<ToothAssetMetadata, 'metadataChecksum'> {
  return {
    fdi: 11,
    version: '1.0.0',
    toothType: 'incisor',
    provenance: 'PLACEHOLDER-ANATOMY: test fixture',
    landmarks: { incisalEdge: [0, 0, 10] },
    canonicalFrame: IDENTITY_FRAME,
    morphTargets: [{ name: 'cuspHeight', vertexDeltas: [0, 0, 1, 0, 0, 0] }],
    meshChecksum: computeMeshChecksum(new Uint8Array([1, 2, 3])),
  };
}

function validRawMetadata(): Record<string, unknown> {
  const withoutChecksum = baseMetadataWithoutChecksum();
  const metadataChecksum = computeToothAssetMetadataChecksum(withoutChecksum);
  return { ...withoutChecksum, metadataChecksum };
}

describe('validateToothAssetMetadataShape', () => {
  it('accepts a well-formed asset', () => {
    const metadata = validateToothAssetMetadataShape(validRawMetadata());
    expect(metadata.fdi).toBe(11);
    expect(metadata.toothType).toBe('incisor');
    expect(metadata.landmarks.incisalEdge).toEqual([0, 0, 10]);
  });

  it('rejects a non-object', () => {
    expect(() => validateToothAssetMetadataShape('not an object')).toThrow(
      ToothAssetMetadataValidationError,
    );
  });

  it('rejects an invalid FDI code', () => {
    const raw = { ...validRawMetadata(), fdi: 99 };
    expect(() => validateToothAssetMetadataShape(raw)).toThrow(ToothAssetMetadataValidationError);
  });

  it('rejects an unknown toothType', () => {
    const raw = { ...validRawMetadata(), toothType: 'canine' };
    expect(() => validateToothAssetMetadataShape(raw)).toThrow(ToothAssetMetadataValidationError);
  });

  it('rejects an empty landmarks object', () => {
    const raw = { ...validRawMetadata(), landmarks: {} };
    expect(() => validateToothAssetMetadataShape(raw)).toThrow(ToothAssetMetadataValidationError);
  });

  it('rejects a landmark that is not a 3-vector', () => {
    const raw = { ...validRawMetadata(), landmarks: { incisalEdge: [0, 0] } };
    expect(() => validateToothAssetMetadataShape(raw)).toThrow(ToothAssetMetadataValidationError);
  });

  it('rejects a non-orthonormal canonical frame', () => {
    const raw = {
      ...validRawMetadata(),
      canonicalFrame: { ...IDENTITY_FRAME, buccoLingual: [1, 0, 0] }, // parallel to mesialDistal
    };
    expect(() => validateToothAssetMetadataShape(raw)).toThrow(ToothAssetMetadataValidationError);
  });

  it('rejects a non-unit-length frame axis', () => {
    const raw = { ...validRawMetadata(), canonicalFrame: { ...IDENTITY_FRAME, mesialDistal: [2, 0, 0] } };
    expect(() => validateToothAssetMetadataShape(raw)).toThrow(ToothAssetMetadataValidationError);
  });

  it('rejects a malformed meshChecksum', () => {
    const raw = { ...validRawMetadata(), meshChecksum: 'not-hex' };
    expect(() => validateToothAssetMetadataShape(raw)).toThrow(ToothAssetMetadataValidationError);
  });

  it('rejects an unrecognized top-level field', () => {
    const raw = { ...validRawMetadata(), extraField: 'nope' };
    expect(() => validateToothAssetMetadataShape(raw)).toThrow(ToothAssetMetadataValidationError);
  });

  it('rejects a morphTarget vertexDeltas length not a multiple of 3', () => {
    const raw = {
      ...validRawMetadata(),
      morphTargets: [{ name: 'cuspHeight', vertexDeltas: [1, 2] }],
    };
    expect(() => validateToothAssetMetadataShape(raw)).toThrow(ToothAssetMetadataValidationError);
  });

  it('cross-checks vertexDeltas length against an expected vertex count when given', () => {
    const raw = validRawMetadata(); // 1 morph target with 2 vertices (6 numbers)
    expect(() => validateToothAssetMetadataShape(raw, 2)).not.toThrow();
    expect(() => validateToothAssetMetadataShape(raw, 3)).toThrow(ToothAssetMetadataValidationError);
  });
});

describe('loadToothAssetMetadata — checksum verification (tamper detection)', () => {
  it('loads a correctly-checksummed asset', () => {
    const metadata = loadToothAssetMetadata(validRawMetadata());
    expect(metadata.fdi).toBe(11);
  });

  it('throws a loud, typed error when a field is tampered with after checksumming', () => {
    const raw = validRawMetadata();
    const tampered = { ...raw, version: '9.9.9' }; // metadataChecksum now stale
    expect(() => loadToothAssetMetadata(tampered)).toThrow(ToothAssetMetadataChecksumError);
  });

  it('throws when metadataChecksum itself is corrupted', () => {
    const raw = validRawMetadata();
    const tampered = { ...raw, metadataChecksum: '0'.repeat(64) };
    expect(() => loadToothAssetMetadata(tampered)).toThrow(ToothAssetMetadataChecksumError);
  });

  it('returns a deeply frozen object', () => {
    const metadata = loadToothAssetMetadata(validRawMetadata());
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.isFrozen(metadata.landmarks)).toBe(true);
    expect(Object.isFrozen(metadata.canonicalFrame)).toBe(true);
  });
});

describe('computeMeshChecksum', () => {
  it('is deterministic and matches a known SHA-256 test vector', () => {
    // "abc" in ASCII bytes; matches the FIPS 180-4 published SHA-256 vector
    // (same one sha256.test.ts checks against `sha256HexOfString('abc')`).
    const bytes = new Uint8Array([0x61, 0x62, 0x63]);
    expect(computeMeshChecksum(bytes)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(computeMeshChecksum(bytes)).toBe(computeMeshChecksum(bytes));
  });

  it('changes when even one byte changes', () => {
    const a = computeMeshChecksum(new Uint8Array([1, 2, 3]));
    const b = computeMeshChecksum(new Uint8Array([1, 2, 4]));
    expect(a).not.toBe(b);
  });
});

describe('assertOrthonormalFrame', () => {
  it('accepts the identity frame', () => {
    expect(() => assertOrthonormalFrame(IDENTITY_FRAME)).not.toThrow();
  });

  it('accepts a rotated-but-still-orthonormal frame', () => {
    const c = Math.SQRT1_2;
    const rotated: CanonicalFrame = {
      origin: [1, 2, 3],
      mesialDistal: [c, c, 0],
      buccoLingual: [-c, c, 0],
      occlusoGingival: [0, 0, 1],
    };
    expect(() => assertOrthonormalFrame(rotated)).not.toThrow();
  });

  it('rejects nearly-but-not-quite-orthogonal axes beyond tolerance', () => {
    const skewed: CanonicalFrame = {
      origin: [0, 0, 0],
      mesialDistal: [1, 0, 0],
      buccoLingual: [0.05, Math.sqrt(1 - 0.05 * 0.05), 0], // ~2.9 degrees off perpendicular
      occlusoGingival: [0, 0, 1],
    };
    expect(() => assertOrthonormalFrame(skewed)).toThrow(ToothAssetMetadataValidationError);
  });
});
