// decimateMesh job tests (Phase 2 Task 10) — exercised via a real Node
// worker_threads WorkerPool, same rationale as offsetJob.test.ts: the
// decimation algorithm itself (link condition, boundary policy, QEM bounds,
// determinism, analytic sphere acceptance) is exhaustively covered at the
// kernel level (packages/kernel/src/decimate/*.test.ts) — these tests prove
// the job wires @dqcad/kernel's decimate/ module through a real worker
// correctly: chunked progress, genuine mid-run cancellation, typed-error
// propagation across the Comlink boundary, and byte-identity with a direct
// kernel `decimateMesh` call (the job drives the same `DecimationSession`
// the blocking call wraps — see jobs/decimate.ts's module doc).
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { decimateMesh } from '@dqcad/kernel';
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

// ---------------------------------------------------------------------------
// Fixture: a deterministic UV sphere, large enough (~20k triangles) that the
// job's chunked collapse loop reports several real intermediate progress
// values (jobs/decimate.ts's COLLAPSES_PER_CHUNK = 4096) and a mid-run abort
// lands genuinely mid-decimation. Closed, watertight, CCW-from-outside.
// ---------------------------------------------------------------------------
function uvSphereBuffers(
  radius: number,
  rings: number,
  segments: number,
): { positions: Float64Array; indices: Uint32Array } {
  const positions: number[] = [0, 0, radius];
  for (let r = 1; r < rings; r++) {
    const phi = (Math.PI * r) / rings;
    for (let s = 0; s < segments; s++) {
      const theta = (2 * Math.PI * s) / segments;
      positions.push(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.sin(phi) * Math.sin(theta),
        radius * Math.cos(phi),
      );
    }
  }
  positions.push(0, 0, -radius);
  const southIndex = positions.length / 3 - 1;
  const ringStart = (r: number): number => 1 + (r - 1) * segments;

  const indices: number[] = [];
  for (let s = 0; s < segments; s++) {
    indices.push(0, ringStart(1) + s, ringStart(1) + ((s + 1) % segments));
  }
  for (let r = 1; r < rings - 1; r++) {
    for (let s = 0; s < segments; s++) {
      const a = ringStart(r) + s;
      const b = ringStart(r) + ((s + 1) % segments);
      const c = ringStart(r + 1) + ((s + 1) % segments);
      const d = ringStart(r + 1) + s;
      indices.push(a, c, b, a, d, c);
    }
  }
  for (let s = 0; s < segments; s++) {
    indices.push(southIndex, ringStart(rings - 1) + ((s + 1) % segments), ringStart(rings - 1) + s);
  }
  return { positions: new Float64Array(positions), indices: Uint32Array.from(indices) };
}

function hashBuffers(positions: Float64Array, indices: Uint32Array): string {
  const hash = createHash('sha256');
  hash.update(Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength));
  hash.update(Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength));
  return hash.digest('hex');
}

describe('decimateMesh job', () => {
  it(
    'produces a result BYTE-IDENTICAL to a direct kernel decimateMesh call, with chunked progress ending at 1',
    { timeout: 120_000 },
    async () => {
      const pool = createPool({ size: 1 });
      const { positions, indices } = uvSphereBuffers(10, 100, 100); // 19,800 triangles
      const inputTriangleCount = indices.length / 3;
      const target = Math.round(inputTriangleCount * 0.2);

      const progressValues: number[] = [];
      const jobResult = await pool.run(
        'decimateMesh',
        // Fresh copies: run() transfers the buffers into the worker.
        { positions: positions.slice(), indices: indices.slice(), targetTriangleCount: target },
        { onProgress: (fraction) => progressValues.push(fraction) },
      );

      expect(jobResult.inputTriangleCount).toBe(inputTriangleCount);
      expect(jobResult.outputTriangleCount).toBeLessThanOrEqual(target);
      expect(jobResult.collapseCount).toBeGreaterThan(0);
      expect(jobResult.maxErrorMm).toBeGreaterThan(0);

      // Chunked progress: starts at 0, monotone, ends exactly at 1, with
      // real intermediate values from the collapse-chunk loop.
      expect(progressValues[0]).toBe(0);
      expect(progressValues[progressValues.length - 1]).toBe(1);
      expect(progressValues.length).toBeGreaterThan(3);
      for (let i = 1; i < progressValues.length; i++) {
        expect(progressValues[i]!).toBeGreaterThanOrEqual(progressValues[i - 1]!);
      }

      // Byte-identity with the kernel path (the job drives the same
      // DecimationSession — jobs/decimate.ts's module doc).
      const direct = decimateMesh({ positions, indices }, { targetTriangleCount: target });
      expect(hashBuffers(jobResult.positions, jobResult.indices)).toBe(
        hashBuffers(direct.mesh.renderMesh.positions, direct.mesh.renderMesh.indices),
      );
      expect(jobResult.outputTriangleCount).toBe(direct.outputTriangleCount);
      expect(jobResult.collapseCount).toBe(direct.collapseCount);
      expect(jobResult.maxErrorMm).toBe(direct.maxErrorMm);
    },
  );

  it('is cancellable BEFORE it starts (pre-flight: signal already aborted)', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = uvSphereBuffers(10, 20, 20);
    const controller = new AbortController();
    controller.abort();
    await expect(
      pool.run(
        'decimateMesh',
        { positions, indices, targetTriangleCount: 10 },
        { signal: controller.signal },
      ),
    ).rejects.toThrow(JobCancelledError);
  });

  it(
    'is cancellable GENUINELY MID-DECIMATION (abort from the onProgress hook during the collapse loop) — the job must not run to completion',
    { timeout: 120_000 },
    async () => {
      const pool = createPool({ size: 1 });
      const { positions, indices } = uvSphereBuffers(10, 120, 120); // 28,560 triangles -> several chunks

      const controller = new AbortController();
      const progressValues: number[] = [];
      let abortedMidRun = false;
      await expect(
        pool.run(
          'decimateMesh',
          { positions, indices, targetTriangleCount: 100 },
          {
            signal: controller.signal,
            onProgress: (fraction) => {
              progressValues.push(fraction);
              // Abort during the collapse-chunk band (0.05 -> 0.98) — after
              // at least one real chunk, well before the run completes.
              if (!abortedMidRun && fraction > 0.05 && fraction < 0.6) {
                abortedMidRun = true;
                controller.abort();
              }
            },
          },
        ),
      ).rejects.toThrow(JobCancelledError);

      expect(abortedMidRun).toBe(true);
      expect(progressValues).not.toContain(1);
    },
  );

  it('propagates NonManifoldEdgeError for a non-manifold input', async () => {
    const pool = createPool({ size: 1 });
    // Three triangles sharing one edge — degree 3, the classic non-manifold
    // edge buildHalfedge rejects.
    const positions = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, -1, 0]);
    const indices = Uint32Array.from([0, 1, 2, 0, 1, 3, 0, 1, 4]);
    await expect(
      pool.run('decimateMesh', { positions, indices, targetTriangleCount: 1 }),
    ).rejects.toMatchObject({ name: 'NonManifoldEdgeError' });
  });

  it('rejects missing options with a TypeError before any heavy work', async () => {
    const pool = createPool({ size: 1 });
    const { positions, indices } = uvSphereBuffers(10, 8, 8);
    await expect(pool.run('decimateMesh', { positions, indices })).rejects.toMatchObject({
      name: 'TypeError',
    });
  });
});
