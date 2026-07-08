// test/golden/golden.test.ts
//
// Vitest project `golden` (see vitest.config.ts / `npm run test:golden`).
// Three concerns, per docs/plans/phase-0-foundation.md Task 6:
//
//  1. Determinism + integrity: re-running the generator into a fresh temp
//     directory must produce byte-identical output to what's checked in —
//     catches both generator non-determinism and hand-edited/stale
//     checked-in fixtures.
//  2. Structural integrity: an independent binary-STL reader (stl-reader.ts,
//     NOT the generator's writer) must agree with each sidecar's triangle
//     count, bbox, and (within the documented tessellation tolerance)
//     analytic volume.
//  3. LFS pointer-file detection: a missing `git lfs pull` must fail with a
//     clear, actionable message rather than a confusing parse/hash error.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { generateAll, HEATMAP_FIXTURE_PAIRS, SYNTHETIC_FIXTURES } from '../../scripts/generate-fixtures.ts';
import { assertNotLfsPointer, parseBinaryStl } from './stl-reader.ts';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const fixturesRoot = join(repoRoot, 'test-fixtures');
const syntheticDir = join(fixturesRoot, 'synthetic');
const standinDir = join(fixturesRoot, 'standin-scans');

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function readChecked(...segments: string[]): Buffer {
  const path = join(...segments);
  const buffer = readFileSync(path);
  if (path.endsWith('.stl')) {
    assertNotLfsPointer(buffer, path);
  }
  return buffer;
}

describe('golden fixtures: determinism (fresh regeneration matches checked-in bytes)', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dqcad-fixtures-'));
    generateAll(tempDir);
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it.each(SYNTHETIC_FIXTURES.map((fixture) => fixture.name))(
    '%s.stl and its sidecar are byte-identical to a fresh regeneration',
    (name) => {
      const checkedInStl = readChecked(syntheticDir, `${name}.stl`);
      const regeneratedStl = readFileSync(join(tempDir, 'synthetic', `${name}.stl`));
      expect(sha256(regeneratedStl)).toBe(sha256(checkedInStl));

      const checkedInJson = readFileSync(join(syntheticDir, `${name}.expected.json`), 'utf8');
      const regeneratedJson = readFileSync(join(tempDir, 'synthetic', `${name}.expected.json`), 'utf8');
      expect(regeneratedJson).toBe(checkedInJson);
    },
  );

  // Task 9 heatmap fixture pairs (offset-pair-*, plane-pair-*) — separate
  // from SYNTHETIC_FIXTURES's loop above since each entry here is a PAIR of
  // STL files sharing one combined sidecar (`${pairName}.expected.json`),
  // not one STL + one sidecar (see scripts/generate-fixtures.ts's
  // `HeatmapFixturePair` doc). Same determinism check either way: a fresh
  // regeneration into `tempDir` must be byte-identical to the checked-in
  // fixture.
  it.each(HEATMAP_FIXTURE_PAIRS.map((pair) => pair.pairName))(
    '%s: both STL files and the combined sidecar are byte-identical to a fresh regeneration',
    (pairName) => {
      const pair = HEATMAP_FIXTURE_PAIRS.find((p) => p.pairName === pairName);
      if (!pair) throw new Error(`unreachable: ${pairName} not in HEATMAP_FIXTURE_PAIRS`);

      for (const name of [pair.nameA, pair.nameB]) {
        const checkedInStl = readChecked(syntheticDir, `${name}.stl`);
        const regeneratedStl = readFileSync(join(tempDir, 'synthetic', `${name}.stl`));
        expect(sha256(regeneratedStl)).toBe(sha256(checkedInStl));
      }

      const checkedInJson = readFileSync(join(syntheticDir, `${pairName}.expected.json`), 'utf8');
      const regeneratedJson = readFileSync(join(tempDir, 'synthetic', `${pairName}.expected.json`), 'utf8');
      expect(regeneratedJson).toBe(checkedInJson);
    },
  );

  it('standin-prep-die.stl is byte-identical to a fresh regeneration', () => {
    const checkedIn = readChecked(standinDir, 'standin-prep-die.stl');
    const regenerated = readFileSync(join(tempDir, 'standin-scans', 'standin-prep-die.stl'));
    expect(sha256(regenerated)).toBe(sha256(checkedIn));
  });

  it('standin-scans/README.md is byte-identical to a fresh regeneration', () => {
    const checkedIn = readFileSync(join(standinDir, 'README.md'), 'utf8');
    const regenerated = readFileSync(join(tempDir, 'standin-scans', 'README.md'), 'utf8');
    expect(regenerated).toBe(checkedIn);
  });
});

describe('golden fixtures: structural integrity vs sidecar', () => {
  for (const fixture of SYNTHETIC_FIXTURES) {
    it(`${fixture.name}: triangle count, bbox, and volume agree with the sidecar`, () => {
      const stlPath = join(syntheticDir, `${fixture.name}.stl`);
      const stlBuffer = readChecked(syntheticDir, `${fixture.name}.stl`);
      const parsed = parseBinaryStl(stlBuffer, stlPath);

      const sidecar = JSON.parse(readFileSync(join(syntheticDir, `${fixture.name}.expected.json`), 'utf8')) as {
        analyticVolumeMm3: number;
        analyticAreaMm2: number;
        bbox: { min: [number, number, number]; max: [number, number, number] };
        sha256: string;
        meshVolumeToleranceFraction: number;
      };

      expect(sha256(stlBuffer)).toBe(sidecar.sha256);
      expect(parsed.triangleCount).toBe(fixture.mesh.faces.length);

      // Binary STL stores float32 — allow for that rounding when comparing
      // against the float64 bbox recorded in the sidecar. Compared
      // component-wise (rather than looped with a variable index) so
      // `noUncheckedIndexedAccess` doesn't widen each access to
      // `number | undefined`.
      const [parsedMinX, parsedMinY, parsedMinZ] = parsed.bbox.min;
      const [parsedMaxX, parsedMaxY, parsedMaxZ] = parsed.bbox.max;
      const [sidecarMinX, sidecarMinY, sidecarMinZ] = sidecar.bbox.min;
      const [sidecarMaxX, sidecarMaxY, sidecarMaxZ] = sidecar.bbox.max;
      expect(parsedMinX).toBeCloseTo(sidecarMinX, 4);
      expect(parsedMinY).toBeCloseTo(sidecarMinY, 4);
      expect(parsedMinZ).toBeCloseTo(sidecarMinZ, 4);
      expect(parsedMaxX).toBeCloseTo(sidecarMaxX, 4);
      expect(parsedMaxY).toBeCloseTo(sidecarMaxY, 4);
      expect(parsedMaxZ).toBeCloseTo(sidecarMaxZ, 4);

      const relativeVolumeError =
        Math.abs(parsed.volumeMm3 - sidecar.analyticVolumeMm3) / sidecar.analyticVolumeMm3;
      // Generous margin (3x the documented tessellation-tolerance
      // derivation in scripts/generate-fixtures.ts) — this exists to catch
      // gross regressions (flipped normals, wrong winding, wrong
      // parameters), not to pin down the tolerance formula's precision.
      expect(relativeVolumeError).toBeLessThan(sidecar.meshVolumeToleranceFraction * 3);
    });
  }
});

describe('golden fixtures: LFS pointer-file detection', () => {
  it('fails with a clear "git lfs pull" message when given a pointer file instead of real content', () => {
    const pointerContent = Buffer.from(
      'version https://git-lfs.github.com/spec/v1\noid sha256:deadbeef\nsize 12345\n',
      'utf8',
    );
    expect(() => assertNotLfsPointer(pointerContent, 'test-fixtures/synthetic/sphere-r5.stl')).toThrow(
      /git lfs pull/i,
    );
  });

  it('does not flag a real binary STL as a pointer file', () => {
    const stlBuffer = readFileSync(join(syntheticDir, 'sphere-r5.stl'));
    expect(() => assertNotLfsPointer(stlBuffer, 'sphere-r5.stl')).not.toThrow();
  });
});
