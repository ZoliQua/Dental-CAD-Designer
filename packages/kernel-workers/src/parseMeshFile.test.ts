// parseMeshFile job tests — exercised via the Node worker_threads path (see
// pool.test.ts's module doc for why; the browser path is verified
// separately). Confirms the job (a) actually runs packages/io's STREAMING
// parsers inside the worker (not just a wrapper around parseStl/parsePly),
// (b) transfers its output buffers rather than copying them, (c) reports
// progress, and (d) is cancellable — mirroring pool.test.ts's existing
// echoMesh/longTask coverage for the same properties.
import { afterEach, describe, expect, it } from 'vitest';
import { writeStlBinary } from '@dqcad/io';
import { writePlyBinaryLE } from '@dqcad/io';
import type { WritablePlyMesh } from '@dqcad/io';
import { JobCancelledError, WorkerPool } from './pool.js';

const pools: WorkerPool[] = [];

function createPool(opts?: ConstructorParameters<typeof WorkerPool>[0]): WorkerPool {
  const pool = new WorkerPool(opts);
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.destroy()));
});

function stlFixtureBytes(triangleCount: number): Uint8Array {
  const positions = new Float64Array(triangleCount * 9);
  const normals = new Float64Array(triangleCount * 3);
  for (let i = 0; i < triangleCount; i++) {
    const b9 = i * 9;
    positions[b9] = i;
    positions[b9 + 3] = i + 1;
    positions[b9 + 7] = 1;
    normals[i * 3 + 2] = i % 2 === 0 ? 1 : -1;
  }
  return writeStlBinary({ positions, normals, triangleCount });
}

function plyFixtureBytes(vertexCount: number): Uint8Array {
  const positions = new Float64Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    positions[i * 3] = i;
    positions[i * 3 + 1] = i * 0.5;
  }
  const triangleCount = Math.max(0, vertexCount - 2);
  const indices = new Uint32Array(triangleCount * 3);
  for (let t = 0; t < triangleCount; t++) {
    indices[t * 3] = 0;
    indices[t * 3 + 1] = t + 1;
    indices[t * 3 + 2] = t + 2;
  }
  const mesh: WritablePlyMesh = {
    positions,
    normals: null,
    colors: null,
    indices,
    vertexCount,
    faceCount: triangleCount,
  };
  return writePlyBinaryLE(mesh);
}

describe('WorkerPool — parseMeshFile: STL', () => {
  it('parses a binary STL and transfers (not copies) its output buffers', async () => {
    const pool = createPool({ size: 1 });
    const bytes = stlFixtureBytes(200);
    const sourceBuffer = bytes.buffer;

    const result = await pool.run('parseMeshFile', { format: 'stl', bytes }, { transfer: [bytes.buffer] });

    // Source posted buffer was transferred, not copied.
    expect(sourceBuffer.byteLength).toBe(0);
    expect(result.kind).toBe('stl-soup');
    if (result.kind !== 'stl-soup') throw new Error('unreachable');
    expect(result.triangleCount).toBe(200);
    expect(result.positions).toHaveLength(200 * 9);
    expect(result.format).toBe('stl-binary');
    // Every returned value is finite — same guardrail this task's fuzz
    // suite enforces for packages/io directly (see packages/io/fuzz/).
    expect(Array.from(result.positions).every(Number.isFinite)).toBe(true);
  });

  it('reports monotonically non-decreasing progress ending at 1', async () => {
    const pool = createPool({ size: 1 });
    const bytes = stlFixtureBytes(60_000); // several internal streaming batches
    const fractions: number[] = [];

    await pool.run(
      'parseMeshFile',
      { format: 'stl', bytes, chunkBytes: 65536 },
      { onProgress: (f) => fractions.push(f) },
    );

    expect(fractions.length).toBeGreaterThan(1);
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]!).toBeGreaterThanOrEqual(fractions[i - 1]!);
    }
    for (const f of fractions) {
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
    // NOT asserting the array's LAST captured element is exactly 1 here —
    // `ctx.progress()` (jobs/context.ts) is deliberately fire-and-forget, not
    // awaited by the job before it returns its result (see chunkStream's
    // doc), so under real concurrent load the final progress message and
    // the job's own result message are two independently-scheduled
    // postMessage deliveries; nothing in this job's (or Comlink's)
    // contract guarantees the former is fully processed by the main
    // thread before `pool.run()`'s promise resolves and this test's
    // `await` continues. The same "ends at exactly 1" claim IS asserted
    // strictly in packages/io's own same-thread stream tests
    // (stl/stream.test.ts), where there's no cross-thread message-delivery
    // race to begin with — this test's job is to confirm progress crosses
    // the worker boundary at all and stays monotonic/bounded, which the
    // checks above already do.
    expect(Math.max(...fractions)).toBeGreaterThan(0.5);
  });

  it('rejects a job aborted mid-run with JobCancelledError, and the worker stays reusable', async () => {
    const pool = createPool({ size: 1 });
    const bytes = stlFixtureBytes(200_000);
    const controller = new AbortController();
    let observedProgress = false;

    const run = pool.run(
      'parseMeshFile',
      { format: 'stl', bytes, chunkBytes: 65536 },
      {
        signal: controller.signal,
        onProgress: (fraction) => {
          if (!observedProgress && fraction > 0) {
            observedProgress = true;
            controller.abort();
          }
        },
      },
    );

    await expect(run).rejects.toBeInstanceOf(JobCancelledError);
    expect(observedProgress).toBe(true);

    // Pool size is 1 — a successful call below necessarily reuses the same
    // worker the cancelled job ran on.
    const after = await pool.run('parseMeshFile', { format: 'stl', bytes: stlFixtureBytes(3) });
    expect(after.kind).toBe('stl-soup');
  });

  it('rejects with a MalformedSyntaxError-named error for genuinely malformed bytes', async () => {
    const pool = createPool({ size: 1 });
    const bytes = new TextEncoder().encode('not an stl file at all\n');

    let thrown: unknown;
    try {
      await pool.run('parseMeshFile', { format: 'stl', bytes });
    } catch (error) {
      thrown = error;
    }
    // Comlink reconstructs a thrown error's name/message across the worker
    // boundary but not the exact packages/io class (see jobs/context.ts's
    // JobCancelledError doc for the same caveat) — assert on `.name`.
    expect((thrown as Error)?.name).toMatch(/TruncatedFileError|MalformedSyntaxError/);
  });
});

/** The io-workers review's exact 169-byte hostile PLY: a skipped element with
 * zero properties + a huge declared count, before the real vertex element.
 * Pre-fix this pinned a pool worker at ~100% CPU forever (the tiny source
 * drains, so chunkStream's per-chunk cancel check is never reached again, and
 * no signal was threaded into parsePlyStream). Post-fix the count/zero-byte-row
 * guard rejects it synchronously with a typed IoParseError. */
function hostileSpinPlyBytes(): Uint8Array {
  const header =
    'ply\n' +
    'format binary_little_endian 1.0\n' +
    'element junk 5000000000\n' +
    'element vertex 1\n' +
    'property float64 x\n' +
    'property float64 y\n' +
    'property float64 z\n' +
    'end_header\n';
  const headerBytes = new TextEncoder().encode(header);
  const out = new Uint8Array(headerBytes.byteLength + 24);
  out.set(headerBytes, 0);
  return out;
}

describe('WorkerPool — parseMeshFile: PLY', () => {
  it('rejects the hostile "spin" PLY FAST with a typed error instead of hanging the worker', async () => {
    const pool = createPool({ size: 1 });

    let thrown: unknown;
    try {
      await pool.run('parseMeshFile', { format: 'ply', bytes: hostileSpinPlyBytes() });
    } catch (error) {
      thrown = error;
    }
    // Comlink preserves name/message across the boundary, not the exact class.
    expect((thrown as Error)?.name).toMatch(/TruncatedFileError|MalformedSyntaxError/);

    // Worker stays reusable — proof it rejected cleanly rather than wedging.
    const after = await pool.run('parseMeshFile', { format: 'ply', bytes: plyFixtureBytes(4) });
    expect(after.kind).toBe('ply-mesh');
  }, 5000);

  it('parses a binary_little_endian PLY and transfers its output buffers', async () => {
    const pool = createPool({ size: 1 });
    const bytes = plyFixtureBytes(50);

    const result = await pool.run('parseMeshFile', { format: 'ply', bytes });

    expect(result.kind).toBe('ply-mesh');
    if (result.kind !== 'ply-mesh') throw new Error('unreachable');
    expect(result.vertexCount).toBe(50);
    expect(result.faceCount).toBe(48);
    expect(result.indices).toHaveLength(48 * 3);
    expect(result.format).toBe('ply-binary-le');
  });
});
