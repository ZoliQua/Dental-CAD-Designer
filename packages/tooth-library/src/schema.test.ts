import { describe, expect, it } from 'vitest';
import {
  assertOrthonormalFrame,
  computeMeshChecksum,
  computeToothAssetMetadataChecksum,
  loadToothAssetMetadata,
  ToothAssetMetadataChecksumError,
  ToothAssetMetadataValidationError,
  resolveToothAssetKind,
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

describe('assetKind — where the anatomy came from (Phase 9 Task 4)', () => {
  function withKind(assetKind: unknown, provenance = 'PLACEHOLDER-ANATOMY: test fixture'): Record<string, unknown> {
    const withoutChecksum = { ...baseMetadataWithoutChecksum(), provenance, assetKind: assetKind as ToothAssetMetadata['assetKind'] };
    return { ...withoutChecksum, metadataChecksum: computeToothAssetMetadataChecksum(withoutChecksum) };
  }

  it('accepts generator / scanned / licensed and carries it through the checksum', () => {
    expect(loadToothAssetMetadata(withKind('generator')).assetKind).toBe('generator');
    expect(loadToothAssetMetadata(withKind('scanned', 'Technician-scanned typodont, lab X')).assetKind).toBe('scanned');
    expect(loadToothAssetMetadata(withKind('licensed', 'Licensed atlas Y, tooth 11')).assetKind).toBe('licensed');
  });

  it('rejects an unknown kind', () => {
    expect(() => validateToothAssetMetadataShape(withKind('sculpted'))).toThrow(ToothAssetMetadataValidationError);
  });

  it('a placeholder provenance can only be a generator asset (no placeholder may claim scanned/licensed)', () => {
    expect(() => validateToothAssetMetadataShape(withKind('scanned'))).toThrow(/placeholder/i);
    expect(() => validateToothAssetMetadataShape(withKind('licensed'))).toThrow(/placeholder/i);
  });

  it('is optional for assets written before it existed; resolveToothAssetKind derives it honestly', () => {
    const legacy = loadToothAssetMetadata(validRawMetadata());
    expect('assetKind' in legacy).toBe(false);
    expect(resolveToothAssetKind(legacy)).toBe('generator'); // PLACEHOLDER-ANATOMY prefix
    const thirdParty = { ...baseMetadataWithoutChecksum(), provenance: 'Atlas Z' };
    const raw = { ...thirdParty, metadataChecksum: computeToothAssetMetadataChecksum(thirdParty) };
    expect(resolveToothAssetKind(loadToothAssetMetadata(raw))).toBe('unspecified');
    expect(resolveToothAssetKind(loadToothAssetMetadata(withKind('licensed', 'Atlas Z')))).toBe('licensed');
  });
});

// Phase 10 Task 4 (ADR-023 Decision 2): the optional cervical ring.
describe('cervicalRing', () => {
  function withRing(ring: unknown): Record<string, unknown> {
    const withoutChecksum = { ...baseMetadataWithoutChecksum(), cervicalRing: ring } as Omit<ToothAssetMetadata, 'metadataChecksum'>;
    return { ...withoutChecksum, metadataChecksum: computeToothAssetMetadataChecksum(withoutChecksum) };
  }

  it('is optional, and accepted when well-formed (covered by the checksum)', () => {
    expect(loadToothAssetMetadata(validRawMetadata()).cervicalRing).toBeUndefined();
    const loaded = loadToothAssetMetadata(withRing([0, 1, 2, 3]));
    expect(loaded.cervicalRing).toEqual([0, 1, 2, 3]);
    const tampered = { ...withRing([0, 1, 2, 3]), cervicalRing: [0, 1, 3, 2] };
    expect(() => loadToothAssetMetadata(tampered)).toThrow(ToothAssetMetadataChecksumError);
  });

  it.each([
    ['not an array', 'ring'],
    ['too short', [0, 1]],
    ['a non-integer', [0, 1, 2.5]],
    ['a negative index', [0, -1, 2]],
    ['a repeated index', [0, 1, 1, 2]],
  ])('rejects a ring that is %s', (_label, ring) => {
    expect(() => validateToothAssetMetadataShape(withRing(ring))).toThrow(ToothAssetMetadataValidationError);
  });

  it('rejects a ring index beyond the mesh', () => {
    // baseMetadata's morph target describes a 2-vertex mesh.
    expect(() => validateToothAssetMetadataShape(withRing([0, 1, 2]), 2)).toThrow(/cervicalRing/);
  });
});
