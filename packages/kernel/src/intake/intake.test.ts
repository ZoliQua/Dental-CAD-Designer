// packages/kernel/src/intake/intake.test.ts
//
// Tests for the composed intake() pipeline: both IntakeInput shapes, the
// journal-ready IntakeReport, progress callbacks, and determinism
// (double-run hash-identical — see this task's brief).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { IndexedMesh } from '../mesh/types.ts';
import { icosphereMesh } from '../boolean/manifold.test-fixtures.ts';
import { indexedToSoup } from './soup.ts';
import { intake } from './intake.ts';
import type { IntakeResult } from './types.ts';

const SPHERE_RADIUS = 4;
const SPHERE_SUBDIVISIONS = 2;

function hashIntakeResult(result: IntakeResult): string {
  const hash = createHash('sha256');
  hash.update(Buffer.from(result.mesh.positions.buffer, result.mesh.positions.byteOffset, result.mesh.positions.byteLength));
  hash.update(Buffer.from(result.mesh.indices.buffer, result.mesh.indices.byteOffset, result.mesh.indices.byteLength));
  hash.update(JSON.stringify(result.stats));
  hash.update(JSON.stringify(result.report));
  return hash.digest('hex');
}

describe('intake — soup input (weld runs)', () => {
  it('welds, drops degenerates, orients, and analyzes a duplicated-vertex soup built from an indexed sphere', () => {
    const sphere = icosphereMesh(SPHERE_RADIUS, SPHERE_SUBDIVISIONS);
    const soup = indexedToSoup(sphere);
    // Sanity: the soup really is unwelded (many more raw vertices than the
    // sphere's actual unique vertex count).
    expect(soup.positions.length / 3).toBeGreaterThan(sphere.positions.length / 3);

    const result = intake({ kind: 'soup', soup });

    expect(result.mesh.positions.length / 3).toBe(sphere.positions.length / 3);
    expect(result.stats.watertight).toBe(true);
    expect(result.stats.signedVolumeMm3).toBeGreaterThan(0);
    expect(result.report.weldEpsilonMm).toBe(1e-6);
    expect(result.report.steps.map((s) => s.step)).toEqual([
      'weld',
      'dropDegenerateTriangles',
      'orientNormalsConsistently',
    ]);

    const weldStep = result.report.steps[0]!;
    expect(weldStep.before.vertexCount).toBe(soup.triangleCount * 3);
    expect(weldStep.after.vertexCount).toBe(sphere.positions.length / 3);
  });
});

describe('intake — already-indexed input (weld is skipped)', () => {
  it('does not run a weld step for kind: "indexed" input', () => {
    const sphere = icosphereMesh(SPHERE_RADIUS, SPHERE_SUBDIVISIONS);
    const result = intake({ kind: 'indexed', mesh: sphere });

    expect(result.report.steps.map((s) => s.step)).toEqual(['dropDegenerateTriangles', 'orientNormalsConsistently']);
    expect(result.stats.watertight).toBe(true);
    expect(result.mesh.positions.length).toBe(sphere.positions.length);
  });
});

describe('intake — progress callbacks', () => {
  it('reports monotonically increasing progress ending at exactly 1', () => {
    const sphere = icosphereMesh(SPHERE_RADIUS, SPHERE_SUBDIVISIONS);
    const soup = indexedToSoup(sphere);
    const fractions: number[] = [];

    intake({ kind: 'soup', soup }, { onProgress: (f) => fractions.push(f) });

    expect(fractions).toEqual([0.25, 0.5, 0.75, 1]);
  });

  it('reports 3 stages (no weld) for already-indexed input', () => {
    const sphere = icosphereMesh(SPHERE_RADIUS, SPHERE_SUBDIVISIONS);
    const fractions: number[] = [];

    intake({ kind: 'indexed', mesh: sphere }, { onProgress: (f) => fractions.push(f) });

    expect(fractions.length).toBe(3);
    expect(fractions[fractions.length - 1]).toBe(1);
  });
});

describe('intake — determinism (double-run hash-identical)', () => {
  it('produces byte- and report-identical output across two runs on the same soup input', () => {
    const sphere = icosphereMesh(SPHERE_RADIUS, SPHERE_SUBDIVISIONS);
    const soup = indexedToSoup(sphere);

    const first = intake({ kind: 'soup', soup: { ...soup, positions: Float64Array.from(soup.positions) } });
    const second = intake({ kind: 'soup', soup: { ...soup, positions: Float64Array.from(soup.positions) } });

    expect(hashIntakeResult(first)).toBe(hashIntakeResult(second));
  });

  it('produces identical output across two runs on the same already-indexed input', () => {
    const sphere = icosphereMesh(SPHERE_RADIUS, SPHERE_SUBDIVISIONS);

    const first = intake({ kind: 'indexed', mesh: { positions: Float64Array.from(sphere.positions), indices: Uint32Array.from(sphere.indices) } });
    const second = intake({ kind: 'indexed', mesh: { positions: Float64Array.from(sphere.positions), indices: Uint32Array.from(sphere.indices) } });

    expect(hashIntakeResult(first)).toBe(hashIntakeResult(second));
  });
});

describe('intake — end-to-end with degenerate + duplicate input', () => {
  it('removes degenerate triangles introduced into a soup before welding', () => {
    // A soup with one real triangle and one duplicate-index (degenerate)
    // triangle appended.
    const soup = {
      positions: new Float64Array([
        0, 0, 0, 1, 0, 0, 0, 1, 0, // real triangle
        0, 0, 0, 1, 0, 0, 1, 0, 0, // duplicate-index triangle (last two corners identical)
      ]),
      normals: null,
      triangleCount: 2,
    };
    const mesh: IndexedMesh = intake({ kind: 'soup', soup }).mesh;
    expect(mesh.indices).toHaveLength(3);
  });
});
