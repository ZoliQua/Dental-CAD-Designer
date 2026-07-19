// test/manual/section-real-scan-replicate.ts
//
// Manual (not CI — see this directory's README) replication of Task 10's
// real-scan pipeline verification: the REAL client pipeline —
// `parseMeshFile` -> `intakeMesh` -> `sectionMesh` (a Z-through-bbox-center
// cut, matching ui/SectionPanel.tsx's `section-axis-z` preset — see
// engine/section.ts's `AXIS_NORMALS`/`recompute` for the exact "anchor +
// axis normal" plane construction this mirrors) — run through the real
// (Node worker_threads) `WorkerPool`, against real, checked-in
// `arch-case-01` scans (non-watertight, so no cap) and, for the cap path
// specifically, the synthetic watertight `sphere-r5.stl` fixture.
//
// Run: npx tsx test/manual/section-real-scan-replicate.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerPool, type IntakeMeshResult } from '@dqcad/kernel-workers';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const realScanDir = join(repoRoot, 'test-fixtures', 'real-scans', 'arch-case-01');
const syntheticDir = join(repoRoot, 'test-fixtures', 'synthetic');

async function loadMesh(pool: WorkerPool, path: string): Promise<IntakeMeshResult> {
  const bytes = new Uint8Array(readFileSync(path));
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

/** Z-through-bbox-center section, exactly matching ui/SectionPanel.tsx's
 * "Z" axis preset with the default 0 mm offset (engine/section.ts's
 * `AXIS_NORMALS.z = [0, 0, 1]`, anchor = the sectioned mesh's own bbox
 * center here since there is only ever one mesh in these single-mesh
 * replications). */
async function sectionThroughZ(
  pool: WorkerPool,
  label: string,
  mesh: IntakeMeshResult,
  computeCap: boolean,
): Promise<void> {
  const { min, max } = mesh.stats.bbox;
  const center: readonly [number, number, number] = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ];
  // sectionMesh now takes a contentHash, not raw buffers (Phase 3 Task 1
  // housekeeping: "jobs/section.ts stops re-sending buffers") — the mesh
  // must be cached via buildBvh first, same precondition as
  // measurePointToSurface/raycastMesh (jobs/bvh.ts's `requireCachedBvh`).
  await pool.run(
    'buildBvh',
    { contentHash: mesh.contentHash, positions: mesh.positions.slice(), indices: mesh.indices.slice() },
    { transfer: [] },
  );
  const t = performance.now();
  const result = await pool.run(
    'sectionMesh',
    {
      contentHash: mesh.contentHash,
      point: center,
      normal: [0, 0, 1],
      computeCap,
    },
    { transfer: [] },
  );
  const elapsed = performance.now() - t;

  const polylineCount = result.polylineCounts.length;
  const openCount = Array.from(result.polylineClosed).filter((closed) => closed === 0).length;
  const closedCount = polylineCount - openCount;
  const totalPoints = result.pointsFlat.length / 3;

  console.log(
    `${label}: watertight=${mesh.stats.watertight}, ${mesh.positions.length / 3} vertices, ` +
      `${mesh.indices.length / 3} triangles -> section in ${fmtMs(elapsed)}: ` +
      `${polylineCount} polylines (${openCount} open / ${closedCount} closed), ${totalPoints} total points`,
  );
  if (computeCap) {
    if (result.capPositions && result.capIndices) {
      console.log(
        `  cap: ${result.capPositions.length / 3} vertices, ${result.capIndices.length / 3} triangles`,
      );
    } else {
      console.log(
        '  cap: null (mesh not watertight, or plane missed the mesh — expected for an open scan)',
      );
    }
  }
}

async function main(): Promise<void> {
  const pool = new WorkerPool();
  try {
    console.log('Loading bite1 (real scan, non-watertight)...');
    const bite1 = await loadMesh(pool, join(realScanDir, 'arch-case-01-bite1.stl'));
    await sectionThroughZ(pool, 'bite1', bite1, false);

    console.log('\nLoading upperjaw (real scan, non-watertight)...');
    const upperjaw = await loadMesh(pool, join(realScanDir, 'arch-case-01-upperjaw.stl'));
    await sectionThroughZ(pool, 'upperjaw', upperjaw, false);

    console.log('\nLoading sphere-r5 (synthetic, watertight — cap path check)...');
    const sphere = await loadMesh(pool, join(syntheticDir, 'sphere-r5.stl'));
    await sectionThroughZ(pool, 'sphere-r5', sphere, true);

    console.log('\nAll real-scan section replications completed successfully.');
  } finally {
    await pool.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
