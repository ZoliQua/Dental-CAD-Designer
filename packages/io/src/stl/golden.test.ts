// packages/io/src/stl/golden.test.ts
//
// Golden-file regression for `parseStl` against the checked-in Phase 0
// fixtures (test-fixtures/synthetic/*.stl + *.expected.json sidecars,
// test-fixtures/real-scans/*/*.stl + manifest.json). Requires the fixtures
// to be materialized via `git lfs pull` (see test-fixtures/README /
// CLAUDE.md) — `assertNotLfsPointer` below fails fast with an actionable
// message instead of a confusing parse error if that hasn't happened.
//
// Deliberately does NOT import test/golden/stl-reader.ts (see this
// package's task brief: packages/io tests must stay independent of
// root-level test tooling) — the tiny bit of header-reading logic needed
// to get an independent expected triangle count for the synthetic
// fixtures (whose sidecars don't carry a triangleCount field) is
// reimplemented locally below.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseStl } from './parse.ts';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const syntheticDir = join(repoRoot, 'test-fixtures', 'synthetic');
const realScansDir = join(repoRoot, 'test-fixtures', 'real-scans');

const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1';

function assertNotLfsPointer(bytes: Uint8Array, label: string): void {
  const probe = new TextDecoder('utf8').decode(bytes.subarray(0, LFS_POINTER_PREFIX.length));
  if (probe === LFS_POINTER_PREFIX) {
    throw new Error(
      `${label} is a Git LFS pointer file, not the real binary content — run \`git lfs pull\` before ` +
        're-running this test.',
    );
  }
}

function readFixtureBytes(path: string): Uint8Array {
  const bytes = new Uint8Array(readFileSync(path));
  assertNotLfsPointer(bytes, path);
  return bytes;
}

/** Independent (not `parseStl`-derived) read of the declared binary
 * triangle count directly from the header — just enough logic to give the
 * synthetic-fixture assertions below a triangle count to check against,
 * since those sidecars don't carry one (see the module doc). */
function readDeclaredTriangleCount(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
}

function computeBbox(positions: Float64Array): {
  min: [number, number, number];
  max: [number, number, number];
} {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/** Component-wise `toBeCloseTo` for two bboxes. Written as explicit x/y/z
 * comparisons rather than a loop over `[0, 1, 2]` because
 * `noUncheckedIndexedAccess` (repo-wide) widens any variable-indexed tuple
 * access to `number | undefined`, same rationale as
 * test/golden/golden.test.ts's own bbox comparison. */
function expectBboxCloseTo(
  actual: { min: readonly [number, number, number]; max: readonly [number, number, number] },
  expected: { min: readonly [number, number, number]; max: readonly [number, number, number] },
  numDigits: number,
): void {
  const [actualMinX, actualMinY, actualMinZ] = actual.min;
  const [actualMaxX, actualMaxY, actualMaxZ] = actual.max;
  const [expectedMinX, expectedMinY, expectedMinZ] = expected.min;
  const [expectedMaxX, expectedMaxY, expectedMaxZ] = expected.max;
  expect(actualMinX).toBeCloseTo(expectedMinX, numDigits);
  expect(actualMinY).toBeCloseTo(expectedMinY, numDigits);
  expect(actualMinZ).toBeCloseTo(expectedMinZ, numDigits);
  expect(actualMaxX).toBeCloseTo(expectedMaxX, numDigits);
  expect(actualMaxY).toBeCloseTo(expectedMaxY, numDigits);
  expect(actualMaxZ).toBeCloseTo(expectedMaxZ, numDigits);
}

const SYNTHETIC_FIXTURE_NAMES = [
  'sphere-r5',
  'cylinder-r3-h8',
  'torus-R5-r2',
  'boolean-pair-a',
  'boolean-pair-b',
] as const;

describe('golden: synthetic fixtures (test-fixtures/synthetic)', () => {
  for (const name of SYNTHETIC_FIXTURE_NAMES) {
    it(`${name}.stl: parses as binary with the declared triangle count and sidecar-matching bbox`, () => {
      const stlPath = join(syntheticDir, `${name}.stl`);
      const bytes = readFixtureBytes(stlPath);
      const declaredTriangleCount = readDeclaredTriangleCount(bytes);

      const sidecar = JSON.parse(
        readFileSync(join(syntheticDir, `${name}.expected.json`), 'utf8'),
      ) as {
        bbox: { min: [number, number, number]; max: [number, number, number] };
      };

      const { soup, diagnostics } = parseStl(bytes);

      expect(diagnostics.format).toBe('stl-binary');
      expect(diagnostics.warnings).toHaveLength(0);
      expect(soup.triangleCount).toBe(declaredTriangleCount);
      expect(soup.positions).toHaveLength(soup.triangleCount * 9);
      expect(soup.normals).not.toBeNull();
      expect(soup.normals).toHaveLength(soup.triangleCount * 3);

      // Binary STL stores float32 coordinates — compare against the
      // sidecar's float64 bbox with a tolerance that allows for that
      // rounding (mirrors test/golden/golden.test.ts's own tolerance).
      const bbox = computeBbox(soup.positions);
      expectBboxCloseTo(bbox, sidecar.bbox, 4);
    });
  }
});

const REAL_SCAN_CASES = ['arch-case-01', 'arch-case-02'] as const;
const REAL_SCAN_ROLES = ['upperjaw', 'lowerjaw', 'bite0', 'bite1'] as const;

interface RealScanManifest {
  meshes: Record<
    string,
    {
      stl: {
        triangleCount: number;
        bbox: { min: [number, number, number]; max: [number, number, number] };
      };
    }
  >;
}

describe('golden: real-scan fixtures (test-fixtures/real-scans)', () => {
  for (const caseId of REAL_SCAN_CASES) {
    const manifest = JSON.parse(
      readFileSync(join(realScansDir, caseId, 'manifest.json'), 'utf8'),
    ) as RealScanManifest;

    for (const role of REAL_SCAN_ROLES) {
      it(`${caseId}/${role}.stl: triangleCount and bbox match manifest.json`, () => {
        const stlPath = join(realScansDir, caseId, `${caseId}-${role}.stl`);
        const bytes = readFixtureBytes(stlPath);
        const entry = manifest.meshes[role]!.stl;

        const { soup, diagnostics } = parseStl(bytes);

        expect(diagnostics.format).toBe('stl-binary');
        // These fixtures are known-clean (verified via a direct binary scan
        // while implementing this parser: every triangle's attribute byte
        // count is 0 across all 8 files) — a warning here would mean a
        // real, previously-unnoticed quirk in the anonymized fixtures.
        expect(diagnostics.warnings).toHaveLength(0);
        expect(soup.triangleCount).toBe(entry.triangleCount);

        const bbox = computeBbox(soup.positions);
        expectBboxCloseTo(bbox, entry.bbox, 3);
      });
    }
  }
});
