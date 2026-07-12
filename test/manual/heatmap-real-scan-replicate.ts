// test/manual/heatmap-real-scan-replicate.ts
//
// Manual (not CI — see this directory's README) replication of Task 9's
// real-scan pipeline verification: the REAL client pipeline —
// `parseMeshFile` (wraps @dqcad/io's `parseStl`) -> `intakeMesh` (wraps
// @dqcad/kernel's `intake`) -> `buildBvh` -> `distanceHeatmap` — run
// through the real (Node worker_threads) `WorkerPool`, exactly as
// apps/client/src/engine/importer.ts + engine/heatmap.ts drive them in the
// browser, against the real, checked-in `arch-case-01` scans (not a
// synthetic fixture).
//
// A `size: 1` pool is used deliberately: `distanceHeatmap`'s target BVH is
// cached PER WORKER (see packages/kernel-workers/src/jobs/bvh.ts's "Per-worker
// BVH cache" doc) — `WorkerPool.run()` has no per-job worker affinity, so
// only a pool that never has more than one worker guarantees a `buildBvh`
// call and a later `distanceHeatmap` call for the same contentHash land on
// the SAME worker. This is the exact reason
// apps/client/src/engine/workers.ts's `getMeasurementWorkerPool()` is a
// dedicated size:1 pool in the real app.
//
// Run: npx tsx test/manual/heatmap-real-scan-replicate.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerPool, type IntakeMeshResult } from '@dqcad/kernel-workers';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const caseDir = join(repoRoot, 'test-fixtures', 'real-scans', 'arch-case-01');

/** `parseMeshFile` -> `intakeMesh`, exactly as
 * apps/client/src/engine/importer.ts's `importMeshFile` does for an STL
 * file (soup positions in, welded+oriented+analyzed indexed mesh out). */
async function loadMesh(pool: WorkerPool, fileName: string): Promise<IntakeMeshResult> {
  const bytes = new Uint8Array(readFileSync(join(caseDir, fileName)));
  const parsed = await pool.run(
    'parseMeshFile',
    { format: 'stl', bytes },
    { transfer: [bytes.buffer] },
  );
  if (parsed.kind !== 'stl-soup') {
    throw new Error(`expected an STL soup result, got ${parsed.kind}`);
  }
  return pool.run(
    'intakeMesh',
    { kind: 'soup', positions: parsed.positions },
    { transfer: [parsed.positions.buffer] },
  );
}

function fmtMs(ms: number): string {
  return `${ms.toFixed(0)} ms`;
}

async function main(): Promise<void> {
  const pool = new WorkerPool({ size: 1 });
  try {
    console.log('Loading bite0 (query mesh)...');
    let t = performance.now();
    const bite0 = await loadMesh(pool, 'arch-case-01-bite0.stl');
    console.log(
      `  bite0: ${bite0.positions.length / 3} vertices, ${bite0.indices.length / 3} triangles ` +
        `(${fmtMs(performance.now() - t)})`,
    );

    console.log('Loading lowerjaw (target mesh)...');
    t = performance.now();
    const lowerjaw = await loadMesh(pool, 'arch-case-01-lowerjaw.stl');
    console.log(
      `  lowerjaw: ${lowerjaw.positions.length / 3} vertices, ${lowerjaw.indices.length / 3} triangles ` +
        `(${fmtMs(performance.now() - t)})`,
    );

    const lowerjawHash = 'manual-replicate:arch-case-01-lowerjaw';
    console.log(`buildBvh(lowerjaw)...`);
    t = performance.now();
    await pool.run(
      'buildBvh',
      {
        contentHash: lowerjawHash,
        positions: lowerjaw.positions.slice(),
        indices: lowerjaw.indices.slice(),
      },
      { transfer: [] },
    );
    console.log(`  done (${fmtMs(performance.now() - t)})`);

    console.log('distanceHeatmap(bite0 -> lowerjaw)...');
    t = performance.now();
    const heatmap = await pool.run(
      'distanceHeatmap',
      { contentHash: lowerjawHash, points: bite0.positions.slice(), signed: false },
      { transfer: [] },
    );
    const elapsed = performance.now() - t;
    console.log(`  done (${fmtMs(elapsed)}) for ${bite0.positions.length / 3} query points`);
    console.log(
      `  min=${heatmap.min.toFixed(4)} mm, max=${heatmap.max.toFixed(4)} mm, ` +
        `mean=${heatmap.mean.toFixed(4)} mm, rms=${heatmap.rms.toFixed(4)} mm`,
    );

    // Self-check on a REAL (non-synthetic) mesh: heatmap(bite0, bite0) must
    // be exactly 0 everywhere — every query point IS a vertex of the target
    // mesh, so the closest point on B's surface to each of A's points is
    // itself, distance 0, independent of tessellation (see
    // packages/kernel-workers/src/distanceHeatmap.test.ts's identical
    // synthetic-mesh assertion for the general proof; this just confirms it
    // holds on real clinical-scale data too).
    const bite0Hash = 'manual-replicate:arch-case-01-bite0';
    await pool.run(
      'buildBvh',
      {
        contentHash: bite0Hash,
        positions: bite0.positions.slice(),
        indices: bite0.indices.slice(),
      },
      { transfer: [] },
    );
    const selfCheck = await pool.run(
      'distanceHeatmap',
      { contentHash: bite0Hash, points: bite0.positions.slice(), signed: false },
      { transfer: [] },
    );
    console.log(`self-check heatmap(bite0, bite0): max=${selfCheck.max} (expected exactly 0)`);
    if (selfCheck.max !== 0) {
      throw new Error(`self-check FAILED: expected max===0, got ${selfCheck.max}`);
    }

    console.log('\nAll real-scan heatmap replications completed successfully.');
  } finally {
    await pool.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
