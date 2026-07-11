import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { IoStreamCancelledError, TruncatedFileError } from '../types.ts';
import type { RawTriangleSoup } from '../types.ts';
import { iterateInFixedChunks } from '../stream/chunk-iterables.ts';
import { writeStlBinary } from './binary.ts';
import { parseStl } from './parse.ts';
import { parseStlStream } from './stream.ts';

function soupOf(triangleCount: number): RawTriangleSoup {
  const positions = new Float64Array(triangleCount * 9);
  const normals = new Float64Array(triangleCount * 3);
  for (let i = 0; i < triangleCount; i++) {
    const base9 = i * 9;
    const base3 = i * 3;
    // Deterministic, varied (non-degenerate) float32-representable values —
    // no Math.random (determinism invariant).
    positions[base9] = i;
    positions[base9 + 1] = i * 0.5;
    positions[base9 + 2] = -i * 0.25;
    positions[base9 + 3] = i + 1;
    positions[base9 + 4] = i * 0.5 + 2;
    positions[base9 + 5] = -i * 0.25 + 1;
    positions[base9 + 6] = i + 2;
    positions[base9 + 7] = i * 0.5;
    positions[base9 + 8] = -i * 0.25 + 2;
    normals[base3] = 0;
    normals[base3 + 1] = 0;
    normals[base3 + 2] = i % 2 === 0 ? 1 : -1;
  }
  return { positions, normals, triangleCount };
}

function hashFloat64(view: Float64Array): string {
  return createHash('sha256').update(Buffer.from(view.buffer, view.byteOffset, view.byteLength)).digest('hex');
}

const ADVERSARIAL_CHUNK_SIZES = [1, 7, 4096, 1_000_000];

describe('parseStlStream: chunk-boundary invariance (binary)', () => {
  it.each(ADVERSARIAL_CHUNK_SIZES)('matches parseStl for a multi-triangle binary STL at chunk size %i', async (chunkSize) => {
    const bytes = writeStlBinary(soupOf(37));
    const expected = parseStl(bytes);

    const streamed = await parseStlStream(iterateInFixedChunks(bytes, chunkSize), bytes.byteLength);

    expect(streamed.diagnostics).toEqual(expected.diagnostics);
    expect(streamed.soup.triangleCount).toBe(expected.soup.triangleCount);
    expect(hashFloat64(streamed.soup.positions)).toBe(hashFloat64(expected.soup.positions));
    expect(hashFloat64(streamed.soup.normals!)).toBe(hashFloat64(expected.soup.normals!));
  });

  it('matches parseStl for a zero-triangle binary STL', async () => {
    const bytes = writeStlBinary(soupOf(0));
    const expected = parseStl(bytes);
    const streamed = await parseStlStream(iterateInFixedChunks(bytes, 16), bytes.byteLength);
    expect(streamed.soup.triangleCount).toBe(0);
    expect(streamed.diagnostics).toEqual(expected.diagnostics);
  });

  it('reports the same trailing-junk warning as parseStl', async () => {
    const clean = writeStlBinary(soupOf(5));
    const withJunk = new Uint8Array(clean.byteLength + 5);
    withJunk.set(clean, 0);
    withJunk.set([1, 2, 3, 4, 5], clean.byteLength);
    const expected = parseStl(withJunk);

    const streamed = await parseStlStream(iterateInFixedChunks(withJunk, 13), withJunk.byteLength);
    expect(streamed.diagnostics).toEqual(expected.diagnostics);
    expect(hashFloat64(streamed.soup.positions)).toBe(hashFloat64(expected.soup.positions));
  });
});

describe('parseStlStream: chunk-boundary invariance (ASCII)', () => {
  const asciiText = [
    'solid streamed',
    'facet normal 0 0 1',
    'outer loop',
    'vertex 0 0 0',
    'vertex 1 0 0',
    'vertex 0 1 0',
    'endloop',
    'endfacet',
    'facet normal 0 0 -1',
    'outer loop',
    'vertex 0 0 1',
    'vertex 1 0 1',
    'vertex 0 1 1',
    'endloop',
    'endfacet',
    'endsolid streamed',
  ].join('\n');

  it.each(ADVERSARIAL_CHUNK_SIZES)('matches parseStl for an ASCII STL at chunk size %i', async (chunkSize) => {
    const bytes = new TextEncoder().encode(asciiText);
    const expected = parseStl(bytes);
    const streamed = await parseStlStream(iterateInFixedChunks(bytes, chunkSize), bytes.byteLength);

    expect(streamed.diagnostics).toEqual(expected.diagnostics);
    expect(Array.from(streamed.soup.positions)).toEqual(Array.from(expected.soup.positions));
    expect(Array.from(streamed.soup.normals!)).toEqual(Array.from(expected.soup.normals!));
  });
});

describe('parseStlStream: the ambiguous "solid"-header binary-with-trailing-junk case', () => {
  it('matches parseStl (binary-with-junk-warning, tie broken the same way) when streamed', async () => {
    const clean = writeStlBinary(soupOf(3), { headerText: 'solid this-is-actually-binary' });
    const withJunk = new Uint8Array(clean.byteLength + 5);
    withJunk.set(clean, 0);
    withJunk.set([1, 2, 3, 4, 5], clean.byteLength);
    const expected = parseStl(withJunk);
    expect(expected.diagnostics.format).toBe('stl-binary');

    const streamed = await parseStlStream(iterateInFixedChunks(withJunk, 17), withJunk.byteLength);
    expect(streamed.diagnostics).toEqual(expected.diagnostics);
    expect(hashFloat64(streamed.soup.positions)).toBe(hashFloat64(expected.soup.positions));
  });
});

describe('parseStlStream: error cases', () => {
  it('throws TruncatedFileError for an empty source', async () => {
    await expect(parseStlStream(iterateInFixedChunks(new Uint8Array(0), 1), 0)).rejects.toBeInstanceOf(
      TruncatedFileError,
    );
  });

  it('throws TruncatedFileError when the binary source ends mid-triangle-record', async () => {
    const full = writeStlBinary(soupOf(4));
    const truncated = full.subarray(0, full.byteLength - 10);
    // totalBytes must describe the DECLARED (not actual) length for the
    // format-detection math to still see this as "binary, not enough
    // bytes" rather than accidentally reclassifying it as a smaller,
    // internally-consistent file.
    await expect(
      parseStlStream(iterateInFixedChunks(truncated, 9), full.byteLength),
    ).rejects.toBeInstanceOf(TruncatedFileError);
  });

  it('throws TruncatedFileError when totalBytes overstates what the chunk source actually produces', async () => {
    const bytes = writeStlBinary(soupOf(1)); // 134 bytes
    await expect(
      parseStlStream(iterateInFixedChunks(bytes.subarray(0, 40), 5), 200),
    ).rejects.toBeInstanceOf(TruncatedFileError);
  });

  it('rejects a negative or non-integer totalBytes', async () => {
    await expect(parseStlStream(iterateInFixedChunks(new Uint8Array(4), 1), -1)).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(parseStlStream(iterateInFixedChunks(new Uint8Array(4), 1), 1.5)).rejects.toBeInstanceOf(
      TypeError,
    );
  });
});

describe('parseStlStream: progress reporting', () => {
  it('reports monotonically non-decreasing progress in [0, 1], ending at exactly 1 (binary)', async () => {
    // Large enough (>1 MiB of triangle data) to span several of the binary
    // streaming loop's internal batches, so this actually exercises
    // multiple distinct progress samples rather than one batch that
    // happens to consume the whole file at once.
    const bytes = writeStlBinary(soupOf(100_000));
    const samples: number[] = [];
    await parseStlStream(iterateInFixedChunks(bytes, 65536), bytes.byteLength, {
      onProgress: (f) => samples.push(f),
    });
    expect(samples.length).toBeGreaterThan(2);
    expect(samples[samples.length - 1]).toBe(1);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!).toBeGreaterThanOrEqual(samples[i - 1]!);
    }
    for (const f of samples) {
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });
});

describe('parseStlStream: cancellation', () => {
  it('rejects with IoStreamCancelledError when aborted before the first chunk', async () => {
    const bytes = writeStlBinary(soupOf(10));
    const controller = new AbortController();
    controller.abort();
    await expect(
      parseStlStream(iterateInFixedChunks(bytes, 32), bytes.byteLength, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(IoStreamCancelledError);
  });

  it('rejects with IoStreamCancelledError when aborted partway through a large binary stream', async () => {
    const bytes = writeStlBinary(soupOf(50_000)); // several batches at the 1 MiB batch size
    const controller = new AbortController();
    let progressCalls = 0;
    await expect(
      parseStlStream(iterateInFixedChunks(bytes, 4096), bytes.byteLength, {
        signal: controller.signal,
        onProgress: () => {
          progressCalls++;
          if (progressCalls === 2) {
            controller.abort();
          }
        },
      }),
    ).rejects.toBeInstanceOf(IoStreamCancelledError);
  });
});
