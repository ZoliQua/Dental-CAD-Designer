// scripts/generate-curvature-golden.ts
//
// Regenerates
// test-fixtures/curvature/arch-case-01-upperjaw.curvature.golden.json — the
// golden snapshot pinned by test/golden/curvature.test.ts. Run with
// `npx tsx scripts/generate-curvature-golden.ts`. Mirrors
// scripts/generate-intake-golden.ts's structure/policy exactly (this task's
// brief: "extend the golden pattern") — same intake pipeline over the SAME
// real-scan fixture, with `computeCurvature` run on intake's output mesh.
//
// Golden-file policy (CLAUDE.md "Testing expectations"): this snapshot's
// values change ONLY with a deliberate kernel version bump + changelog
// entry explaining the numerical difference. Re-running this script must
// otherwise produce byte-identical output (kernel determinism invariant) —
// if it doesn't, that's a determinism bug to investigate, not a file to
// regenerate.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseStl } from '@dqcad/io';
import { computeCurvature, intake, type CurvatureResult } from '@dqcad/kernel';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const upperjawStlPath = join(repoRoot, 'test-fixtures', 'real-scans', 'arch-case-01', 'arch-case-01-upperjaw.stl');
const goldenPath = join(repoRoot, 'test-fixtures', 'curvature', 'arch-case-01-upperjaw.curvature.golden.json');

/** Must match test/golden/curvature.test.ts's `hashCurvatureResult` exactly. */
function hashCurvatureResult(result: CurvatureResult): string {
  const hash = createHash('sha256');
  for (const arr of [result.H, result.K, result.k1, result.k2, result.mixedArea]) {
    hash.update(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
  }
  hash.update(Buffer.from(result.isBoundary.buffer, result.isBoundary.byteOffset, result.isBoundary.byteLength));
  return hash.digest('hex');
}

/** Must match test/golden/curvature.test.ts's `summarize` exactly. */
function summarize(result: CurvatureResult) {
  let boundaryCount = 0;
  let interiorCount = 0;
  let minH = Infinity;
  let maxH = -Infinity;
  let sumH = 0;
  let minK = Infinity;
  let maxK = -Infinity;
  let sumK = 0;
  for (let v = 0; v < result.H.length; v++) {
    if (result.isBoundary[v]) {
      boundaryCount++;
      continue;
    }
    interiorCount++;
    const h = result.H[v]!;
    const k = result.K[v]!;
    minH = Math.min(minH, h);
    maxH = Math.max(maxH, h);
    sumH += h;
    minK = Math.min(minK, k);
    maxK = Math.max(maxK, k);
    sumK += k;
  }
  return {
    vertexCount: result.H.length,
    boundaryCount,
    interiorCount,
    minH,
    maxH,
    meanH: sumH / interiorCount,
    minK,
    maxK,
    meanK: sumK / interiorCount,
  };
}

const buffer = readFileSync(upperjawStlPath);
const { soup } = parseStl(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
const intakeResult = intake({ kind: 'soup', soup });
const curvature = computeCurvature(intakeResult.mesh);

const snapshot = {
  summary: summarize(curvature),
  resultSha256: hashCurvatureResult(curvature),
};

mkdirSync(dirname(goldenPath), { recursive: true });
writeFileSync(goldenPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
console.log(`wrote ${goldenPath}`);
