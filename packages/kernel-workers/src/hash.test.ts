// hash.ts direct unit tests — a regression guard for the byte-for-byte
// hashing contract this module's own doc comment calls out: persisted
// hashes (MeshAsset.contentHash/fileHash) key existing dev-DB rows, so a
// value produced here changing for the SAME input bytes is a silent data
// hazard, not just a test failure. These tests call the exported functions
// directly (no WorkerPool/job pipeline) for (a)/(b)/(d); (c) additionally
// drives the real job pipeline (parseMeshFile via WorkerPool) and checks its
// result against an independently-computed node:crypto hash, so the pinned
// literals below are cross-checked against a second, from-scratch
// computation rather than only against themselves.
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { writeStlBinary } from '@dqcad/io';
import { hashMeshContent, sha256Hex, sha256HexSubtle } from './hash.js';
import { WorkerPool } from './pool.js';

const pools: WorkerPool[] = [];

function createPool(opts?: ConstructorParameters<typeof WorkerPool>[0]): WorkerPool {
  const pool = new WorkerPool(opts);
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.destroy()));
});

describe('sha256Hex', () => {
  it('matches the pinned SHA-256 hex of a small known byte sequence', async () => {
    // bytes: [0, 1, 2, ..., 9]. Pinned literal computed independently via:
    //   node -e "console.log(require('node:crypto').createHash('sha256')
    //     .update(Uint8Array.from([0,1,2,3,4,5,6,7,8,9])).digest('hex'))"
    const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const hex = await sha256Hex(bytes);
    expect(hex).toBe('1f825aa2f0020ef7cf91dfa30da4668d791c5d4824fc8e41354b89ec05795ab3');
  });
});

describe('hashMeshContent', () => {
  // This PINS the byte layout contract documented at hash.ts's module doc
  // and hashMeshContent's own doc: SHA-256 over `positions` (Float64) bytes
  // followed by `indices` (Uint32) bytes, concatenated in that order. ANY
  // change to this layout (different dtype, different order, added
  // padding/separator, etc.) changes the hash for these exact fixture
  // values and breaks this test loudly — that's the point: a silent layout
  // change would otherwise only surface as a mismatched persisted hash long
  // after the fact.
  it('matches the pinned hex hash of a tiny fixed 2-triangle IndexedMesh', async () => {
    // A unit quad (z=0) split into 2 triangles — 4 vertices, 2 triangles.
    const positions = new Float64Array([
      0, 0, 0, // vertex 0
      1, 0, 0, // vertex 1
      1, 1, 0, // vertex 2
      0, 1, 0, // vertex 3
    ]);
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);

    const hex = await hashMeshContent(positions, indices);

    // Pinned literal computed independently via:
    //   node -e "
    //     const crypto = require('node:crypto');
    //     const positions = new Float64Array([0,0,0, 1,0,0, 1,1,0, 0,1,0]);
    //     const indices = new Uint32Array([0,1,2, 0,2,3]);
    //     const p = new Uint8Array(positions.buffer);
    //     const i = new Uint8Array(indices.buffer);
    //     const combined = new Uint8Array(p.length + i.length);
    //     combined.set(p, 0);
    //     combined.set(i, p.length);
    //     console.log(crypto.createHash('sha256').update(combined).digest('hex'));
    //   "
    expect(hex).toBe('8ed2d504d6b8d45d9d6ae1cdfef3f3e09e2a941f6a4cc7df5d923570386f533e');
  });
});

describe('crypto.subtle branch (sha256HexSubtle) vs. node:crypto branch (sha256Hex)', () => {
  // `isNodeRuntime()` (hash.ts) always routes `sha256Hex` to the node:crypto
  // branch under vitest (a real Node process), so that branch alone never
  // exercises the SubtleCrypto path a browser Web Worker actually takes.
  // `sha256HexSubtle` (hash.ts's exported test seam) is the browser branch
  // pulled out standalone — Node >=19 exposes `crypto.subtle` as a real
  // Web Crypto implementation via `globalThis.crypto.subtle`, so this runs
  // for real under vitest, no mocking of `process`/`isNodeRuntime()` needed.
  it('produces identical hex to sha256Hex for the same input bytes', async () => {
    const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 255, 254, 128, 0]);

    const nodeHex = await sha256Hex(bytes);
    const subtleHex = await sha256HexSubtle(bytes);

    expect(subtleHex).toBe(nodeHex);
    // Also cross-check against a third, independent computation so this
    // isn't just "the two branches agree with each other while both being
    // wrong".
    expect(subtleHex).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('produces identical hex for empty input', async () => {
    const bytes = new Uint8Array(0);

    const nodeHex = await sha256Hex(bytes);
    const subtleHex = await sha256HexSubtle(bytes);

    expect(subtleHex).toBe(nodeHex);
  });
});

describe('job pipeline hashes match an independently-computed node:crypto hash', () => {
  it('rescaleMesh: beforeHash/afterHash equal independent hashes of the pre/post-rescale Float64 bytes', async () => {
    const pool = createPool({ size: 1 });
    const original = new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const expectedBeforeHash = createHash('sha256')
      .update(new Uint8Array(original.buffer, original.byteOffset, original.byteLength))
      .digest('hex');

    // rescaleMesh mutates `positions` in place, so compute the expected
    // "after" bytes independently BEFORE calling the job (which will
    // detach/transfer the original buffer).
    const factor = 2.5;
    const expectedAfter = new Float64Array(original.length);
    for (let i = 0; i < original.length; i++) expectedAfter[i] = original[i]! * factor;
    const expectedAfterHash = createHash('sha256')
      .update(new Uint8Array(expectedAfter.buffer))
      .digest('hex');

    const positions = original.slice();
    const result = await pool.run(
      'rescaleMesh',
      { positions, factor },
      { transfer: [positions.buffer] },
    );

    expect(result.beforeHash).toBe(expectedBeforeHash);
    expect(result.afterHash).toBe(expectedAfterHash);
  });

  it('serializeMeshStl: fileHash equals an independent node:crypto hash of the returned STL bytes', async () => {
    const pool = createPool({ size: 1 });
    // Same unit-quad-as-2-triangles fixture as the hashMeshContent test.
    const positions = new Float64Array([
      0, 0, 0,
      1, 0, 0,
      1, 1, 0,
      0, 1, 0,
    ]);
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);

    const result = await pool.run('serializeMeshStl', {
      positions: positions.slice(),
      indices: indices.slice(),
    });

    const expectedFileHash = createHash('sha256').update(result.bytes).digest('hex');
    expect(result.fileHash).toBe(expectedFileHash);
  });

  it('parseMeshFile: fileHash equals an independent node:crypto hash of the raw input bytes', async () => {
    const pool = createPool({ size: 1 });
    // Arbitrary bytes stand in for a "file" here — parseMeshFile hashes
    // `payload.bytes` BEFORE any parsing (see jobs/io.ts's "fileHash"
    // module doc section), so the hash doesn't depend on the bytes being a
    // valid STL/PLY file; using a real minimal binary STL keeps the parse
    // itself from throwing so the job returns normally.
    const trianglePositions = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const normals = new Float64Array([0, 0, 1]);
    const bytes = writeStlBinary({ positions: trianglePositions, normals, triangleCount: 1 });

    const expectedFileHash = createHash('sha256').update(bytes).digest('hex');

    const result = await pool.run('parseMeshFile', { format: 'stl', bytes: bytes.slice() });

    expect(result.fileHash).toBe(expectedFileHash);
  });
});
