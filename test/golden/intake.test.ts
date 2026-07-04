// test/golden/intake.test.ts
//
// Vitest project `golden` (see vitest.config.ts / `npm run test:golden`) —
// fixture-driven tests for @dqcad/kernel's mesh intake pipeline (Phase 1
// Task 4). Lives here (not in packages/kernel) because these tests parse
// STL fixture bytes with @dqcad/io, and the layer rule (CLAUDE.md,
// eslint.config.js's boundaries policy) forbids packages/kernel itself from
// depending on packages/io — the root-level golden project is the
// established home for cross-package fixture tests (see golden.test.ts /
// real-scans.test.ts).
//
// Coverage, per the task brief:
//  1. Analytic: sphere-r5.stl and cylinder-r3-h8.stl intake to watertight
//     meshes whose volume/area match each sidecar's analytic values within
//     the sidecar's own documented tessellation tolerance.
//  2. Flipped-normals sphere: reversing every triangle's winding in the
//     sphere soup still intakes to a POSITIVE signed volume (orientation
//     recovery).
//  3. Real fixture: arch-case-01 upperjaw STL intake completes; its stats/
//     report counts are pinned as a golden snapshot
//     (test-fixtures/intake/arch-case-01-upperjaw.intake.golden.json) with a
//     sha256 over the output mesh buffers — hash-stable across runs and
//     machines (kernel determinism invariant, CLAUDE.md #2).
//  4. Determinism: double-run of the full real-scan intake produces
//     hash-identical output.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseStl } from '@dqcad/io';
import { intake, type IntakeResult } from '@dqcad/kernel';
import { assertNotLfsPointer } from './stl-reader.ts';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const syntheticDir = join(repoRoot, 'test-fixtures', 'synthetic');
const intakeGoldenDir = join(repoRoot, 'test-fixtures', 'intake');
const upperjawStlPath = join(repoRoot, 'test-fixtures', 'real-scans', 'arch-case-01', 'arch-case-01-upperjaw.stl');

interface SyntheticSidecar {
  analyticVolumeMm3: number;
  analyticAreaMm2: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
  meshVolumeToleranceFraction: number;
}

function readFixtureBytes(path: string): Uint8Array {
  const buffer = readFileSync(path);
  assertNotLfsPointer(buffer, path);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function readSidecar(name: string): SyntheticSidecar {
  return JSON.parse(readFileSync(join(syntheticDir, `${name}.expected.json`), 'utf8')) as SyntheticSidecar;
}

function intakeStlFixture(path: string): IntakeResult {
  const { soup } = parseStl(readFixtureBytes(path));
  return intake({ kind: 'soup', soup });
}

/** sha256 over the output mesh's raw buffers + the JSON-serialized stats
 * and report — the "hash-stable" claim of the golden snapshot test. */
function hashIntakeResult(result: IntakeResult): string {
  const hash = createHash('sha256');
  hash.update(
    Buffer.from(result.mesh.positions.buffer, result.mesh.positions.byteOffset, result.mesh.positions.byteLength),
  );
  hash.update(Buffer.from(result.mesh.indices.buffer, result.mesh.indices.byteOffset, result.mesh.indices.byteLength));
  hash.update(JSON.stringify(result.stats));
  hash.update(JSON.stringify(result.report));
  return hash.digest('hex');
}

describe('intake — analytic synthetic fixtures', () => {
  // Both fixtures are inscribed tessellations of their analytic solid: the
  // mesh volume AND area sit BELOW the analytic value by a deficit fraction
  // of the same order (for an inscribed tessellation with effective radial
  // deficit δ/r: volume deficit ≈ 3δ/r, area deficit ≈ 2δ/r — i.e. area
  // error is strictly smaller), so the volume tolerance bound is a valid
  // bound for both comparisons.
  for (const name of ['sphere-r5', 'cylinder-r3-h8'] as const) {
    describe(name, () => {
      const sidecar = readSidecar(name);
      const result = intakeStlFixture(join(syntheticDir, `${name}.stl`));

      it('intakes to a watertight, single-component, degenerate-free mesh', () => {
        expect(result.stats.watertight).toBe(true);
        expect(result.stats.manifoldEdges).toBe(true);
        expect(result.stats.boundaryEdgeCount).toBe(0);
        expect(result.stats.componentCount).toBe(1);
        expect(result.stats.degenerateCount).toBe(0);
      });

      // The `* 3` below is this repo's established assertion bound for these
      // sidecars, not an invention of this test: the sidecar's
      // meshVolumeToleranceFraction is a first-order NOMINAL deficit estimate
      // (see scripts/generate-fixtures.ts's icosphereToleranceFraction /
      // inscribedPolygonDeficitFraction docs), and both the generator's own
      // self-check (generate-fixtures.ts:594) and the existing golden test
      // (golden.test.ts:122) assert `relativeError < fraction * 3`.
      // Empirically sphere-r5's true volume deficit is ~1.2x the nominal
      // estimate — inside 3x, outside 1x.
      it('reports signedVolumeMm3 within the sidecar tolerance of the analytic volume', () => {
        expect(result.stats.signedVolumeMm3).not.toBeNull();
        const relativeError =
          Math.abs(result.stats.signedVolumeMm3! - sidecar.analyticVolumeMm3) / sidecar.analyticVolumeMm3;
        expect(relativeError).toBeLessThan(sidecar.meshVolumeToleranceFraction * 3);
      });

      it('reports surfaceAreaMm2 within the sidecar tolerance of the analytic area', () => {
        const relativeError = Math.abs(result.stats.surfaceAreaMm2 - sidecar.analyticAreaMm2) / sidecar.analyticAreaMm2;
        expect(relativeError).toBeLessThan(sidecar.meshVolumeToleranceFraction * 3);
      });

      it('reports a bbox matching the sidecar (within float32 STL storage rounding)', () => {
        for (let axis = 0; axis < 3; axis++) {
          expect(result.stats.bbox.min[axis]).toBeCloseTo(sidecar.bbox.min[axis]!, 6);
          expect(result.stats.bbox.max[axis]).toBeCloseTo(sidecar.bbox.max[axis]!, 6);
        }
      });
    });
  }

  it('a flipped-normals sphere soup reorients to positive signed volume', () => {
    const { soup } = parseStl(readFixtureBytes(join(syntheticDir, 'sphere-r5.stl')));
    // Reverse winding of every triangle (swap v1 <-> v2) in the soup.
    const flipped = new Float64Array(soup.positions.length);
    for (let t = 0; t < soup.triangleCount; t++) {
      const base = t * 9;
      flipped.set(soup.positions.subarray(base, base + 3), base); // v0
      flipped.set(soup.positions.subarray(base + 6, base + 9), base + 3); // v2 -> slot 1
      flipped.set(soup.positions.subarray(base + 3, base + 6), base + 6); // v1 -> slot 2
    }
    const result = intake({
      kind: 'soup',
      soup: { positions: flipped, normals: null, triangleCount: soup.triangleCount },
    });

    expect(result.stats.watertight).toBe(true);
    expect(result.stats.signedVolumeMm3).toBeGreaterThan(0);
    // Every triangle was flipped back by orientNormalsConsistently.
    const orientStep = result.report.steps.find((s) => s.step === 'orientNormalsConsistently')!;
    expect(orientStep.details['flippedCount']).toBe(soup.triangleCount);
  });
});

interface IntakeGoldenSnapshot {
  stats: unknown;
  report: unknown;
  resultSha256: string;
}

describe('intake — real fixture (arch-case-01 upperjaw STL)', () => {
  const result = intakeStlFixture(upperjawStlPath);
  const resultHash = hashIntakeResult(result);

  it('completes and produces a plausible arch-scan result', () => {
    // An intraoral arch scan is an OPEN surface (no watertight expectation),
    // typically one main shell — assert only facts that must hold for any
    // correct intake of this fixture, the exact values are pinned by the
    // golden snapshot below.
    expect(result.mesh.indices.length).toBeGreaterThan(0);
    expect(result.stats.watertight).toBe(false);
    expect(result.stats.boundaryEdgeCount).toBeGreaterThan(0);
    expect(result.stats.signedVolumeMm3).toBeNull();
    expect(result.stats.surfaceAreaMm2).toBeGreaterThan(0);
  });

  it('matches the committed golden snapshot (stats, report counts, and output-buffer sha256)', () => {
    const goldenPath = join(intakeGoldenDir, 'arch-case-01-upperjaw.intake.golden.json');
    const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as IntakeGoldenSnapshot;

    expect(result.stats).toEqual(golden.stats);
    expect(result.report).toEqual(golden.report);
    expect(resultHash).toBe(golden.resultSha256);
  });

  it('is deterministic: a second full run is hash-identical (double-run determinism)', () => {
    const second = intakeStlFixture(upperjawStlPath);
    expect(hashIntakeResult(second)).toBe(resultHash);
  });
});
