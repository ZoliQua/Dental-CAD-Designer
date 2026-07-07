// packages/kernel/src/repair/splitNonManifoldEdges.test.ts
import { describe, expect, it } from 'vitest';
import { analyzeMesh } from '../intake/analyze.ts';
import type { IndexedMesh } from '../mesh/types.ts';
import { unitCubeMesh } from './repair.test-fixtures.ts';
import { splitNonManifoldEdges } from './splitNonManifoldEdges.ts';

/** A watertight cube with ONE of its 12 triangles duplicated verbatim
 * (appended, same 3 vertex indices) — "a cube with a doubled face edge"
 * (this task's brief): each of the duplicated triangle's 3 edges goes from
 * degree 2 (ordinary manifold-interior) to degree 3 (non-manifold). */
function cubeWithDoubledTriangle(): IndexedMesh {
  const cube = unitCubeMesh();
  const indices = new Uint32Array(cube.indices.length + 3);
  indices.set(cube.indices, 0);
  indices.set(cube.indices.subarray(0, 3), cube.indices.length); // duplicate triangle 0
  return { positions: cube.positions, indices };
}

describe('splitNonManifoldEdges — cube with a doubled face edge', () => {
  it('resolves every non-manifold edge (manifoldEdges becomes true)', () => {
    const mesh = cubeWithDoubledTriangle();
    const before = analyzeMesh(mesh);
    expect(before.manifoldEdges).toBe(false); // sanity: fixture really is non-manifold

    const { mesh: result, report } = splitNonManifoldEdges(mesh);
    const after = analyzeMesh(result);

    expect(after.manifoldEdges).toBe(true);
    expect(report.nonManifoldEdgeCountBefore).toBe(3); // the duplicated triangle's 3 edges
    expect(report.nonManifoldEdgeCountAfter).toBe(0);
    // The duplicate triangle's 3 corners are all disconnected (its 3 edges
    // are ALL non-manifold — none of them get to keep the original vertex).
    expect(report.duplicatedVertexCount).toBe(3);

    // The original 12 triangles are completely untouched.
    for (let i = 0; i < 36; i++) {
      expect(result.indices[i]).toBe(mesh.indices[i]);
    }
    // The 13th (duplicate) triangle now references 3 brand-new vertex ids.
    const dupCorners = [result.indices[36]!, result.indices[37]!, result.indices[38]!];
    for (const c of dupCorners) {
      expect(c).toBeGreaterThanOrEqual(8); // original cube only has 8 vertices (0..7)
    }
  });

  it('is idempotent: a second pass on the resolved mesh is a no-op', () => {
    const mesh = cubeWithDoubledTriangle();
    const first = splitNonManifoldEdges(mesh);
    const second = splitNonManifoldEdges(first.mesh);

    expect(Array.from(second.mesh.positions)).toEqual(Array.from(first.mesh.positions));
    expect(Array.from(second.mesh.indices)).toEqual(Array.from(first.mesh.indices));
    expect(second.report.nonManifoldEdgeCountBefore).toBe(0);
    expect(second.report.duplicatedVertexCount).toBe(0);
  });

  it('is deterministic: two independent calls on the same input produce byte-identical output', () => {
    const mesh = cubeWithDoubledTriangle();
    const a = splitNonManifoldEdges(mesh);
    const b = splitNonManifoldEdges(mesh);

    expect(Array.from(a.mesh.positions)).toEqual(Array.from(b.mesh.positions));
    expect(Array.from(a.mesh.indices)).toEqual(Array.from(b.mesh.indices));
    expect(a.report).toEqual(b.report);
  });
});

describe('splitNonManifoldEdges — already-manifold mesh', () => {
  it('leaves a clean cube untouched', () => {
    const mesh = unitCubeMesh();
    const { mesh: result, report } = splitNonManifoldEdges(mesh);
    expect(Array.from(result.positions)).toEqual(Array.from(mesh.positions));
    expect(Array.from(result.indices)).toEqual(Array.from(mesh.indices));
    expect(report.nonManifoldEdgeCountBefore).toBe(0);
    expect(report.duplicatedVertexCount).toBe(0);
  });
});
