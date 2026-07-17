// test/golden/curvature.test.ts
//
// Vitest project `golden` (see vitest.config.ts / `npm run test:golden`) —
// golden snapshot for @dqcad/kernel's `computeCurvature` over a REAL scan
// fixture (arch-case-01 upperjaw). Extends the exact pattern
// test/golden/intake.test.ts established (same reason for living here, not
// in packages/kernel: this file parses STL fixture bytes with @dqcad/io,
// and the layer rule forbids packages/kernel from depending on
// packages/io — see that file's module doc) — this task's brief:
// "golden on arch-case-01 upperjaw curvature hash (extend the golden
// pattern)".
//
// Coverage:
//  1. Runs the SAME intake pipeline intake.test.ts's real-fixture case uses,
//     then `computeCurvature` on its output mesh.
//  2. Plausibility: every interior vertex's H/K/k1/k2 is finite (no
//     NaN/Infinity — this task's brief's NaN-free boundary-policy
//     invariant, checked on real, noisy scan data, not just synthetic
//     fixtures); boundary vertices are all flagged and zeroed.
//  3. Matches a committed golden snapshot (summary stats + a sha256 over
//     H/K/k1/k2/mixedArea/isBoundary) — hash-stable across runs and
//     machines (kernel determinism invariant).
//  4. Determinism: a second full run is hash-identical.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseStl } from '@dqcad/io';
import { computeCurvature, intake, type CurvatureResult } from '@dqcad/kernel';
import { assertNotLfsPointer } from './stl-reader.ts';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const curvatureGoldenDir = join(repoRoot, 'test-fixtures', 'curvature');
const upperjawStlPath = join(repoRoot, 'test-fixtures', 'real-scans', 'arch-case-01', 'arch-case-01-upperjaw.stl');

function readFixtureBytes(path: string): Uint8Array {
  const buffer = readFileSync(path);
  assertNotLfsPointer(buffer, path);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function computeCurvatureOnUpperjaw(): CurvatureResult {
  const { soup } = parseStl(readFixtureBytes(upperjawStlPath));
  const intakeResult = intake({ kind: 'soup', soup });
  return computeCurvature(intakeResult.mesh);
}

/** sha256 over every typed-array field — the "hash-stable" claim of the
 * golden snapshot test. Must match scripts/generate-curvature-golden.ts's
 * `hashCurvatureResult` exactly. */
function hashCurvatureResult(result: CurvatureResult): string {
  const hash = createHash('sha256');
  for (const arr of [result.H, result.K, result.k1, result.k2, result.mixedArea]) {
    hash.update(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
  }
  hash.update(Buffer.from(result.isBoundary.buffer, result.isBoundary.byteOffset, result.isBoundary.byteLength));
  return hash.digest('hex');
}

interface CurvatureSummary {
  vertexCount: number;
  boundaryCount: number;
  interiorCount: number;
  minH: number;
  maxH: number;
  meanH: number;
  minK: number;
  maxK: number;
  meanK: number;
}

/** Must match scripts/generate-curvature-golden.ts's `summarize` exactly. */
function summarize(result: CurvatureResult): CurvatureSummary {
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

interface CurvatureGoldenSnapshot {
  summary: CurvatureSummary;
  resultSha256: string;
}

describe('curvature — real fixture (arch-case-01 upperjaw STL)', () => {
  const result = computeCurvatureOnUpperjaw();
  const resultHash = hashCurvatureResult(result);

  it('every H/K/k1/k2 value is finite (no NaN/Infinity), on real (noisy) scan data', () => {
    for (let v = 0; v < result.H.length; v++) {
      expect(Number.isFinite(result.H[v]!)).toBe(true);
      expect(Number.isFinite(result.K[v]!)).toBe(true);
      expect(Number.isFinite(result.k1[v]!)).toBe(true);
      expect(Number.isFinite(result.k2[v]!)).toBe(true);
    }
  });

  it('every boundary-flagged vertex is exactly zeroed (H, K, k1, k2)', () => {
    for (let v = 0; v < result.H.length; v++) {
      if (!result.isBoundary[v]) continue;
      expect(result.H[v]).toBe(0);
      expect(result.K[v]).toBe(0);
      expect(result.k1[v]).toBe(0);
      expect(result.k2[v]).toBe(0);
    }
    // The scan is a single open arch surface — it must have SOME boundary
    // (its own rim) and SOME interior (the vast majority of the surface).
    const boundaryCount = result.isBoundary.reduce((sum, flag) => sum + flag, 0);
    expect(boundaryCount).toBeGreaterThan(0);
    expect(boundaryCount).toBeLessThan(result.H.length);
  });

  it('matches the committed golden snapshot (summary stats and result sha256)', () => {
    const goldenPath = join(curvatureGoldenDir, 'arch-case-01-upperjaw.curvature.golden.json');
    const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as CurvatureGoldenSnapshot;

    expect(summarize(result)).toEqual(golden.summary);
    expect(resultHash).toBe(golden.resultSha256);
  });

  it('is deterministic: a second full run is hash-identical (double-run determinism)', () => {
    const second = computeCurvatureOnUpperjaw();
    expect(hashCurvatureResult(second)).toBe(resultHash);
  });
});
