// extractPrepDie job tests (Phase 10 Task 2) — via a real Node worker_threads
// WorkerPool. The region, closure, certificate and `@errorBound` are covered
// at the kernel level (die/extractPrepDie.test.ts); these tests prove the JOB:
// it extracts from the scan's PERSISTED FORM (what the server rebuilds from
// the stored STL — byte-identical to a direct kernel call on that form, and
// equal to the real save + reload jobs' mesh), propagates typed errors, and
// checks its inputs before any work.
import { afterEach, describe, expect, it } from 'vitest';
import { extractPrepDie, persistedMeshForm, type IndexedMesh, type Vec3 } from '@dqcad/kernel';
import { closedFrustumDie, openArchPrepCase } from '@dqcad/kernel/die-fixtures';
import { WorkerPool } from './pool.js';

const pools: WorkerPool[] = [];
function createPool(): WorkerPool {
  const pool = new WorkerPool({ size: 1 });
  pools.push(pool);
  return pool;
}
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.destroy()));
});

/** The open-arch fixture moved off the float32 grid (a rescaled or PLY scan),
 * so the persisted form genuinely differs from the in-session mesh. */
function offGridCase(): { scan: IndexedMesh; marginLoop: Vec3[]; insertionAxis: Vec3 } {
  const c = openArchPrepCase();
  const shift = 1e-7 / 3;
  const positions = c.scan.positions.map((x) => x + shift);
  return {
    scan: { positions, indices: c.scan.indices.slice() },
    marginLoop: c.marginLoop.map((p): Vec3 => [p[0] + shift, p[1] + shift, p[2] + shift]),
    insertionAxis: c.insertionAxis,
  };
}

async function cache(pool: WorkerPool, contentHash: string, scan: IndexedMesh): Promise<void> {
  await pool.run('buildBvh', { contentHash, positions: scan.positions.slice(), indices: scan.indices.slice() });
}

describe('extractPrepDie job', () => {
  it('extracts from the persisted form, byte-identical to the direct kernel call on it', async () => {
    const pool = createPool();
    const c = offGridCase();
    await cache(pool, 'scan', c.scan);
    const progress: number[] = [];
    const result = await pool.run(
      'extractPrepDie',
      { contentHash: 'scan', marginLoop: new Float64Array(c.marginLoop.flat()), insertionAxis: c.insertionAxis },
      { onProgress: (f) => progress.push(f) },
    );
    const direct = extractPrepDie(persistedMeshForm(c.scan), c.marginLoop, c.insertionAxis);
    expect(Array.from(result.positions)).toEqual(Array.from(direct.mesh.positions));
    expect(Array.from(result.indices)).toEqual(Array.from(direct.mesh.indices));
    expect(Array.from(result.sourceTriangleIndices)).toEqual(Array.from(direct.sourceTriangleIndices));
    expect(result.keptTriangleCount).toBe(direct.keptTriangleCount);
    expect(result.syntheticTriangleCount).toBe(direct.syntheticTriangleCount);
    expect(result.clearanceMm).toBe(direct.clearanceMm);
    expect(result.volumeMm3).toBe(direct.volumeMm3);
    expect(result.floorHeightMm).toBe(direct.floorHeightMm);
    expect(result.radialSkirtMm).toBe(direct.radialSkirtMm);
    expect(result.requiredClearanceMm).toBe(direct.requiredClearanceMm);
    // The in-session (off-grid) mesh would give a different die.
    const raw = extractPrepDie(c.scan, c.marginLoop, c.insertionAxis);
    expect(Array.from(raw.mesh.positions)).not.toEqual(Array.from(result.positions));
    expect(progress.at(-1)).toBe(1);
  });

  it('passes a closed die through with an unbounded certificate across the worker boundary', async () => {
    const pool = createPool();
    const frustum = closedFrustumDie();
    await cache(pool, 'die', frustum.die);
    const result = await pool.run('extractPrepDie', {
      contentHash: 'die',
      marginLoop: new Float64Array(frustum.marginLoop.flat()),
      insertionAxis: [0, 0, 1],
    });
    expect(result.syntheticTriangleCount).toBe(0);
    expect(result.clearanceMm).toBe(Infinity);
    expect(result.floorHeightMm).toBeNull();
  });

  it('propagates the typed kernel error when the scan does not reach far enough around the margin', async () => {
    const pool = createPool();
    const short = openArchPrepCase({ outerMm: 3.4, neighbours: null });
    await cache(pool, 'short', short.scan);
    await expect(
      pool.run('extractPrepDie', {
        contentHash: 'short',
        marginLoop: new Float64Array(short.marginLoop.flat()),
        insertionAxis: short.insertionAxis,
      }),
    ).rejects.toMatchObject({ name: 'PrepDieClearanceError' });
  });

  it('rejects a malformed margin loop before any work', async () => {
    const pool = createPool();
    await expect(
      pool.run('extractPrepDie', { contentHash: 'none', marginLoop: new Float64Array([1, 2]), insertionAxis: [0, 0, 1] }),
    ).rejects.toThrow(/xyz triples/);
  });
});

describe('the persisted form is the mesh the stored STL reloads to', () => {
  it('equals serializeMeshStl → parseMeshFile → weldMeshSoup, the client reload path', async () => {
    const pool = createPool();
    const c = offGridCase();
    const { bytes } = await pool.run('serializeMeshStl', { positions: c.scan.positions.slice(), indices: c.scan.indices.slice() });
    const parsed = await pool.run('parseMeshFile', { format: 'stl', bytes });
    if (parsed.kind !== 'stl-soup') throw new Error('expected an STL soup');
    const reloaded = await pool.run('weldMeshSoup', { positions: parsed.positions });
    const form = persistedMeshForm(c.scan);
    expect(Array.from(reloaded.indices)).toEqual(Array.from(form.indices));
    expect(Array.from(reloaded.positions)).toEqual(Array.from(form.positions));
    // ... and a reloaded scan has the same persisted form (idempotence).
    const again = persistedMeshForm({ positions: reloaded.positions, indices: reloaded.indices });
    expect(Array.from(again.positions)).toEqual(Array.from(form.positions));
  });
});
