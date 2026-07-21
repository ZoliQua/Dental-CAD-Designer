// packages/kernel-workers/src/sectionMeshRoiPerf.test.ts
//
// Measures `sectionMesh`'s cost on the real ~250k-triangle arch-case-01
// upperjaw, full-mesh vs. ROI-restricted (`roiRadiusMm`) — the evidence
// behind Phase 3 editor-enhancement task 3's magnifier cross-section
// preview design (see jobs/section.ts's `SectionMeshPayload.roiRadiusMm`
// doc and engine/marginEditor.ts's `MARGIN_SECTION_PREVIEW_ROI_RADIUS_MM`).
// Not a golden/acceptance test (no pinned hash/threshold) — a MEASUREMENT,
// logged for this task's report, run on every `npm test` like this repo's
// other real-fixture perf-observation tests (e.g. validateMarginJobs.test.ts's
// own "completes fast, in-worker" test).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseStl } from '@dqcad/io';
import { intake, type IndexedMesh } from '@dqcad/kernel';
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

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const upperjawStlPath = join(repoRoot, 'test-fixtures', 'real-scans', 'arch-case-01', 'arch-case-01-upperjaw.stl');
function loadUpperjawMesh(): IndexedMesh {
  const bytes = readFileSync(upperjawStlPath);
  const { soup } = parseStl(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return intake({ kind: 'soup', soup }).mesh;
}

// Same fixed margin-adjacent point every other margin golden test in this
// repo uses (test/golden/margin-validate.test.ts's `MARGIN_SEED_AMBIENT`) —
// a real spot on the mesh where a magnifier cross-section would plausibly
// be requested during margin tracing.
const MARGIN_POINT: readonly [number, number, number] = [6.675659656524658, -17.737689971923828, 10.945829391479492];

describe('sectionMesh perf — real 250k-tri upperjaw, full-mesh vs. ROI-restricted (task 3 evidence)', () => {
  it('measures full-mesh vs. roiRadiusMm=4 cost at the same real margin-adjacent point', async () => {
    const mesh = loadUpperjawMesh();
    const pool = createPool({ size: 1 });
    const positions = mesh.positions.slice();
    const indices = mesh.indices.slice();
    await pool.run('buildBvh', { contentHash: 'section-roi-perf', positions, indices }, { transfer: [positions.buffer, indices.buffer] });

    const normal: readonly [number, number, number] = [0, 0, 1];

    // Warm up (JIT) with one throwaway call of each kind before timing —
    // matches this repo's other in-worker perf tests' own convention
    // (avoids attributing first-call JIT/worker-startup cost to the
    // measurement).
    await pool.run('sectionMesh', { contentHash: 'section-roi-perf', point: MARGIN_POINT, normal, computeCap: false });
    await pool.run('sectionMesh', {
      contentHash: 'section-roi-perf',
      point: MARGIN_POINT,
      normal,
      computeCap: false,
      roiRadiusMm: 4,
    });

    const RUNS = 5;
    const fullMs: number[] = [];
    const roiMs: number[] = [];
    let fullResult;
    let roiResult;
    for (let i = 0; i < RUNS; i++) {
      const t0 = performance.now();
      fullResult = await pool.run('sectionMesh', { contentHash: 'section-roi-perf', point: MARGIN_POINT, normal, computeCap: false });
      fullMs.push(performance.now() - t0);

      const t1 = performance.now();
      roiResult = await pool.run('sectionMesh', {
        contentHash: 'section-roi-perf',
        point: MARGIN_POINT,
        normal,
        computeCap: false,
        roiRadiusMm: 4,
      });
      roiMs.push(performance.now() - t1);
    }

    const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const fullMedianMs = median(fullMs);
    const roiMedianMs = median(roiMs);
    console.log(
      `[sectionMesh ROI perf] full-mesh median ${fullMedianMs.toFixed(2)}ms (runs: ${fullMs.map((x) => x.toFixed(1)).join(', ')}), ` +
        `roiRadiusMm=4 median ${roiMedianMs.toFixed(2)}ms (runs: ${roiMs.map((x) => x.toFixed(1)).join(', ')}), ` +
        `roi/full ratio ${(roiMedianMs / fullMedianMs).toFixed(3)}`,
    );

    expect(fullResult).toBeTruthy();
    expect(roiResult).toBeTruthy();
    // The ROI query must never be SLOWER than the full-mesh one (sanity —
    // the whole point of the restriction).
    expect(roiMedianMs).toBeLessThanOrEqual(fullMedianMs + 5); // +5ms slack for measurement noise
  }, 30_000);
});
