import { describe, expect, it } from 'vitest';
import { IoStreamCancelledError, TruncatedFileError } from '../types.ts';
import { iterateInFixedChunks } from '../stream/chunk-iterables.ts';
import { parsePly } from './parse.ts';
import { parsePlyStream } from './stream.ts';
import type { WritablePlyMesh } from './binary.ts';
import { writePlyBinaryLE } from './binary.ts';

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function gridMesh(n: number): WritablePlyMesh {
  const vertexCount = n;
  const positions = new Float64Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    positions[i * 3] = i;
    positions[i * 3 + 1] = i * 0.5;
    positions[i * 3 + 2] = -i * 0.25;
  }
  const triangleCount = vertexCount - 2;
  const indices = new Uint32Array(triangleCount * 3);
  for (let t = 0; t < triangleCount; t++) {
    indices[t * 3] = 0;
    indices[t * 3 + 1] = t + 1;
    indices[t * 3 + 2] = t + 2;
  }
  return { positions, normals: null, colors: null, indices, vertexCount, faceCount: triangleCount };
}

const ADVERSARIAL_CHUNK_SIZES = [1, 7, 4096, 1_000_000];

describe('parsePlyStream: chunk-boundary invariance (binary_little_endian)', () => {
  it.each(ADVERSARIAL_CHUNK_SIZES)('matches parsePly for a multi-vertex/face mesh at chunk size %i', async (chunkSize) => {
    const bytes = writePlyBinaryLE(gridMesh(53));
    const expected = parsePly(bytes);

    const streamed = await parsePlyStream(iterateInFixedChunks(bytes, chunkSize));

    expect(streamed.diagnostics).toEqual(expected.diagnostics);
    expect(streamed.vertexCount).toBe(expected.vertexCount);
    expect(streamed.faceCount).toBe(expected.faceCount);
    expect(Array.from(streamed.positions)).toEqual(Array.from(expected.positions));
    expect(Array.from(streamed.indices)).toEqual(Array.from(expected.indices));
  });

  it('matches parsePly for a point-cloud PLY (no face element)', async () => {
    const mesh = gridMesh(10);
    const bytes = writePlyBinaryLE({ ...mesh, indices: new Uint32Array(0), faceCount: 0 });
    const expected = parsePly(bytes);
    const streamed = await parsePlyStream(iterateInFixedChunks(bytes, 11));
    expect(streamed.faceCount).toBe(0);
    expect(streamed.indices).toHaveLength(0);
    expect(Array.from(streamed.positions)).toEqual(Array.from(expected.positions));
  });
});

describe('parsePlyStream: variable-per-row width (list property length varies by row)', () => {
  // Hand-built: a "texcoord" list property whose per-face length varies (6
  // floats, then 4 floats) — this is exactly the shape that forces
  // readRowWithRetry's window-growth loop to actually grow across more than
  // one row size, since a fixed initial guess can't fit every row.
  function texcoordVaryingBytes(): Uint8Array {
    const header =
      'ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\nproperty float y\n' +
      'property float z\nelement face 2\nproperty list uchar int vertex_indices\n' +
      'property list uchar float texcoord\nend_header\n';
    const headerBytes = encode(header);
    const body: number[] = [];
    const pushF32 = (v: number) => {
      const buf = new ArrayBuffer(4);
      new DataView(buf).setFloat32(0, v, true);
      body.push(...new Uint8Array(buf));
    };
    const pushI32 = (v: number) => {
      const buf = new ArrayBuffer(4);
      new DataView(buf).setInt32(0, v, true);
      body.push(...new Uint8Array(buf));
    };
    // 3 vertices
    pushF32(0); pushF32(0); pushF32(0);
    pushF32(1); pushF32(0); pushF32(0);
    pushF32(0); pushF32(1); pushF32(0);
    // face 0: 3 indices, 6-float texcoord list
    body.push(3); pushI32(0); pushI32(1); pushI32(2);
    body.push(6); pushF32(0); pushF32(0); pushF32(1); pushF32(0); pushF32(0); pushF32(1);
    // face 1: 3 indices (reordered), 4-float texcoord list
    body.push(3); pushI32(2); pushI32(1); pushI32(0);
    body.push(4); pushF32(1); pushF32(1); pushF32(0); pushF32(1);
    const bytes = new Uint8Array(headerBytes.byteLength + body.length);
    bytes.set(headerBytes, 0);
    bytes.set(body, headerBytes.byteLength);
    return bytes;
  }

  it.each(ADVERSARIAL_CHUNK_SIZES)('matches parsePly at chunk size %i', async (chunkSize) => {
    const bytes = texcoordVaryingBytes();
    const expected = parsePly(bytes);
    const streamed = await parsePlyStream(iterateInFixedChunks(bytes, chunkSize));
    expect(streamed.diagnostics).toEqual(expected.diagnostics);
    expect(Array.from(streamed.indices)).toEqual(Array.from(expected.indices));
    expect(streamed.diagnostics.warnings.some((w) => w.includes('texcoord'))).toBe(true);
  });
});

describe('parsePlyStream: chunk-boundary invariance (ASCII)', () => {
  const asciiText =
    'ply\nformat ascii 1.0\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\n' +
    'element face 2\nproperty list uchar int vertex_indices\nend_header\n' +
    '0 0 0\n1 0 0\n1 1 0\n0 1 0\n3 0 1 2\n3 0 2 3\n';

  it.each(ADVERSARIAL_CHUNK_SIZES)('matches parsePly at chunk size %i', async (chunkSize) => {
    const bytes = encode(asciiText);
    const expected = parsePly(bytes);
    const streamed = await parsePlyStream(iterateInFixedChunks(bytes, chunkSize));
    expect(streamed.diagnostics).toEqual(expected.diagnostics);
    expect(Array.from(streamed.positions)).toEqual(Array.from(expected.positions));
    expect(Array.from(streamed.indices)).toEqual(Array.from(expected.indices));
  });
});

describe('parsePlyStream: header spanning multiple probe doublings', () => {
  it('parses a header with enough comment lines to force the probe to grow past its initial size', async () => {
    const comments = Array.from({ length: 400 }, (_, i) => `comment padding line number ${i} to grow the header`).join(
      '\n',
    );
    const text =
      `ply\nformat ascii 1.0\n${comments}\nelement vertex 1\nproperty float x\nproperty float y\n` +
      'property float z\nend_header\n1 2 3\n';
    const bytes = encode(text);
    const expected = parsePly(bytes);
    const streamed = await parsePlyStream(iterateInFixedChunks(bytes, 97));
    expect(streamed.diagnostics.format).toBe(expected.diagnostics.format);
    expect(Array.from(streamed.positions)).toEqual([1, 2, 3]);
  });
});

describe('parsePlyStream: duplicate property names (carry-over review item C, streamed)', () => {
  it('still warns and applies last-write-wins when streamed', async () => {
    const text =
      'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float x\nproperty float y\n' +
      'property float z\nend_header\n1 2 3 4\n';
    const bytes = encode(text);
    const streamed = await parsePlyStream(iterateInFixedChunks(bytes, 5));
    expect(Array.from(streamed.positions)).toEqual([2, 3, 4]);
    expect(streamed.diagnostics.warnings.some((w) => w.includes('declared more than once'))).toBe(true);
  });
});

describe('parsePlyStream: error cases', () => {
  it('throws TruncatedFileError for an empty source', async () => {
    await expect(parsePlyStream(iterateInFixedChunks(new Uint8Array(0), 1))).rejects.toBeInstanceOf(
      TruncatedFileError,
    );
  });

  it('throws TruncatedFileError when the source ends before "end_header"', async () => {
    const bytes = encode('ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\n');
    await expect(parsePlyStream(iterateInFixedChunks(bytes, 3))).rejects.toBeInstanceOf(TruncatedFileError);
  });

  it('throws TruncatedFileError when a binary body ends mid-row', async () => {
    const full = writePlyBinaryLE(gridMesh(10));
    const truncated = full.subarray(0, full.byteLength - 5);
    await expect(parsePlyStream(iterateInFixedChunks(truncated, 8))).rejects.toBeInstanceOf(
      TruncatedFileError,
    );
  });

  it('throws TruncatedFileError when an ASCII body ends before all vertex rows are present', async () => {
    const bytes = encode(
      'ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\n' +
        'end_header\n0 0 0\n',
    );
    await expect(parsePlyStream(iterateInFixedChunks(bytes, 6))).rejects.toBeInstanceOf(TruncatedFileError);
  });
});

describe('parsePlyStream: progress reporting', () => {
  it('reports monotonically non-decreasing progress in [0, 1], ending at exactly 1', async () => {
    const bytes = writePlyBinaryLE(gridMesh(2000));
    const samples: number[] = [];
    await parsePlyStream(iterateInFixedChunks(bytes, 8192), {
      totalBytes: bytes.byteLength,
      onProgress: (f) => samples.push(f),
    });
    expect(samples.length).toBeGreaterThan(1);
    expect(samples[samples.length - 1]).toBe(1);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!).toBeGreaterThanOrEqual(samples[i - 1]!);
    }
  });
});

describe('parsePlyStream: cancellation', () => {
  it('rejects with IoStreamCancelledError when aborted before the first chunk', async () => {
    const bytes = writePlyBinaryLE(gridMesh(10));
    const controller = new AbortController();
    controller.abort();
    await expect(
      parsePlyStream(iterateInFixedChunks(bytes, 16), { signal: controller.signal }),
    ).rejects.toBeInstanceOf(IoStreamCancelledError);
  });

  it('rejects with IoStreamCancelledError when aborted partway through a large binary stream', async () => {
    const bytes = writePlyBinaryLE(gridMesh(20_000));
    const controller = new AbortController();
    let rowCalls = 0;
    await expect(
      parsePlyStream(iterateInFixedChunks(bytes, 4096), {
        signal: controller.signal,
        totalBytes: bytes.byteLength,
        onProgress: () => {
          rowCalls++;
          if (rowCalls === 5) {
            controller.abort();
          }
        },
      }),
    ).rejects.toBeInstanceOf(IoStreamCancelledError);
  });
});
