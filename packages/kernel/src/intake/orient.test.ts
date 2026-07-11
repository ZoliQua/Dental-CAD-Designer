// packages/kernel/src/intake/orient.test.ts
import { describe, expect, it } from 'vitest';
import type { IndexedMesh } from '../mesh/types.ts';
import { icosphereMesh } from '../boolean/manifold.test-fixtures.ts';
import { analyzeMesh } from './analyze.ts';
import { orientNormalsConsistently } from './orient.ts';

function flipAll(mesh: IndexedMesh): IndexedMesh {
  const indices = new Uint32Array(mesh.indices.length);
  for (let t = 0; t < mesh.indices.length / 3; t++) {
    const base = t * 3;
    indices[base] = mesh.indices[base]!;
    indices[base + 1] = mesh.indices[base + 2]!;
    indices[base + 2] = mesh.indices[base + 1]!;
  }
  return { positions: mesh.positions, indices };
}

/** Flips every Nth triangle only — used to prove flood-fill actually
 * RESOLVES a mix of consistent and inconsistent windings, not just a
 * uniform whole-mesh flip. */
function flipEveryNth(mesh: IndexedMesh, n: number): IndexedMesh {
  const indices = new Uint32Array(mesh.indices.length);
  for (let t = 0; t < mesh.indices.length / 3; t++) {
    const base = t * 3;
    if (t % n === 0) {
      indices[base] = mesh.indices[base]!;
      indices[base + 1] = mesh.indices[base + 2]!;
      indices[base + 2] = mesh.indices[base + 1]!;
    } else {
      indices[base] = mesh.indices[base]!;
      indices[base + 1] = mesh.indices[base + 1]!;
      indices[base + 2] = mesh.indices[base + 2]!;
    }
  }
  return { positions: mesh.positions, indices };
}

const SPHERE_RADIUS = 5;
const SPHERE_SUBDIVISIONS = 2;

describe('orientNormalsConsistently — flipped closed sphere reorients to positive volume', () => {
  it('a fully-flipped icosphere is reoriented so signedVolumeMm3 is positive', () => {
    const original = icosphereMesh(SPHERE_RADIUS, SPHERE_SUBDIVISIONS);
    // Sanity: the original fixture is already correctly (outward) wound.
    expect(analyzeMesh(original).signedVolumeMm3).toBeGreaterThan(0);

    const flipped = flipAll(original);
    expect(analyzeMesh(flipped).signedVolumeMm3).toBeLessThan(0);

    const result = orientNormalsConsistently(flipped);
    const stats = analyzeMesh(result.mesh);

    expect(stats.watertight).toBe(true);
    expect(stats.signedVolumeMm3).toBeGreaterThan(0);
    expect(result.componentCount).toBe(1);
    expect(result.components[0]!.closed).toBe(true);
    expect(result.components[0]!.orientationAmbiguous).toBe(false);
    // Every triangle needed flipping back.
    expect(result.flippedCount).toBe(result.triangleCount);
  });

  it('a partially-flipped icosphere (every 3rd triangle) still resolves to one consistent, positive-volume component', () => {
    const original = icosphereMesh(SPHERE_RADIUS, SPHERE_SUBDIVISIONS);
    const partiallyFlipped = flipEveryNth(original, 3);

    const result = orientNormalsConsistently(partiallyFlipped);
    const stats = analyzeMesh(result.mesh);

    expect(stats.watertight).toBe(true);
    expect(stats.signedVolumeMm3).toBeGreaterThan(0);
    expect(result.components[0]!.orientationAmbiguous).toBe(false);
  });
});

describe('orientNormalsConsistently — open component', () => {
  it('flags a single open triangle as orientationAmbiguous (no meaningful volume sign)', () => {
    const mesh: IndexedMesh = {
      positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: Uint32Array.from([0, 1, 2]),
    };
    const result = orientNormalsConsistently(mesh);
    expect(result.componentCount).toBe(1);
    expect(result.components[0]!.closed).toBe(false);
    expect(result.components[0]!.orientationAmbiguous).toBe(true);
    expect(result.flippedCount).toBe(0);
  });
});

describe('orientNormalsConsistently — non-manifold edge (the "subtle" real-scan case)', () => {
  /** Three triangles ("pages") sharing one common "spine" edge {A, B} — a
   * classic non-manifold edge (degree 3, not 2). Flood-fill propagation
   * deliberately never crosses this edge (see orient.ts's module doc); this
   * test proves that produces a graceful, flagged result instead of a
   * crash or a silently-wrong orientation. */
  function bookOfPagesMesh(): IndexedMesh {
    const positions = new Float64Array([
      0, 0, 0, // A (0)
      0, 0, 1, // B (1)
      1, 0, 0.5, // apex 1 (2)
      0, 1, 0.5, // apex 2 (3)
      -1, 0, 0.5, // apex 3 (4)
    ]);
    const indices = Uint32Array.from([0, 1, 2, 0, 1, 3, 0, 1, 4]);
    return { positions, indices };
  }

  it('does not throw, reports the non-manifold component as ambiguous, and preserves triangle vertex sets', () => {
    const mesh = bookOfPagesMesh();
    const result = orientNormalsConsistently(mesh);

    expect(result.triangleCount).toBe(3);
    expect(result.componentCount).toBe(1);
    expect(result.components[0]!.orientationAmbiguous).toBe(true);
    expect(result.components[0]!.closed).toBe(false);

    // Winding may change (each triangle's a/b/c order), but the SET of
    // vertex indices per triangle must be preserved exactly.
    for (let t = 0; t < 3; t++) {
      const originalSet = new Set([mesh.indices[t * 3]!, mesh.indices[t * 3 + 1]!, mesh.indices[t * 3 + 2]!]);
      const resultSet = new Set([
        result.mesh.indices[t * 3]!,
        result.mesh.indices[t * 3 + 1]!,
        result.mesh.indices[t * 3 + 2]!,
      ]);
      expect(resultSet).toEqual(originalSet);
    }
  });
});

describe('orientNormalsConsistently — determinism', () => {
  it('produces index-identical output across repeated runs on the same input', () => {
    const original = icosphereMesh(SPHERE_RADIUS, SPHERE_SUBDIVISIONS);
    const flipped = flipEveryNth(original, 4);

    const first = orientNormalsConsistently(flipped);
    const second = orientNormalsConsistently(flipped);

    expect(Array.from(second.mesh.indices)).toEqual(Array.from(first.mesh.indices));
  });
});
