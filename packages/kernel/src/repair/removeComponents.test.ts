// packages/kernel/src/repair/removeComponents.test.ts
import { describe, expect, it } from 'vitest';
import { analyzeMesh } from '../intake/analyze.ts';
import { concatMeshes, unitCubeMesh } from './repair.test-fixtures.ts';
import { removeComponents } from './removeComponents.ts';

describe('removeComponents — two-component fixture', () => {
  it('minTriangles selector keeps only the bigger component', () => {
    const big = unitCubeMesh([0, 0, 0]); // 12 triangles
    // A single free-floating triangle far away — the "small stray component"
    // to be dropped.
    const speck: import('../mesh/types.ts').IndexedMesh = {
      positions: new Float64Array([100, 100, 100, 101, 100, 100, 100, 101, 100]),
      indices: Uint32Array.from([0, 1, 2]),
    };
    const mesh = concatMeshes(big, speck);
    expect(analyzeMesh(mesh).componentCount).toBe(2);

    const { mesh: result, report } = removeComponents(mesh, { mode: 'minTriangles', minTriangles: 2 });

    expect(report.components).toHaveLength(2);
    expect(report.keptComponentIds).toEqual([0]);
    expect(report.removedComponentIds).toEqual([1]);
    expect(report.before).toEqual({ vertexCount: 11, triangleCount: 13 });
    expect(report.after).toEqual({ vertexCount: 8, triangleCount: 12 });

    const stats = analyzeMesh(result);
    expect(stats.componentCount).toBe(1);
    expect(stats.watertight).toBe(true);
    // Vertex buffer is fully compacted — no stray speck vertices left behind.
    expect(result.positions).toHaveLength(8 * 3);
  });

  it('keep selector keeps only the explicitly named component id(s)', () => {
    const a = unitCubeMesh([0, 0, 0]);
    const b = unitCubeMesh([10, 0, 0]);
    const mesh = concatMeshes(a, b);

    const { mesh: result, report } = removeComponents(mesh, { mode: 'keep', keepIds: [1] });

    expect(report.keptComponentIds).toEqual([1]);
    expect(report.removedComponentIds).toEqual([0]);
    const stats = analyzeMesh(result);
    expect(stats.componentCount).toBe(1);
    expect(stats.watertight).toBe(true);
    expect(stats.bbox.min[0]).toBeCloseTo(10, 10);
  });

  it('is idempotent: a second minTriangles pass on the already-cleaned mesh is a no-op', () => {
    const big = unitCubeMesh([0, 0, 0]);
    const speck: import('../mesh/types.ts').IndexedMesh = {
      positions: new Float64Array([100, 100, 100, 101, 100, 100, 100, 101, 100]),
      indices: Uint32Array.from([0, 1, 2]),
    };
    const mesh = concatMeshes(big, speck);
    const first = removeComponents(mesh, { mode: 'minTriangles', minTriangles: 2 });
    const second = removeComponents(first.mesh, { mode: 'minTriangles', minTriangles: 2 });

    expect(Array.from(second.mesh.positions)).toEqual(Array.from(first.mesh.positions));
    expect(Array.from(second.mesh.indices)).toEqual(Array.from(first.mesh.indices));
    expect(second.report.removedComponentIds).toEqual([]);
  });

  it('keeping every component returns an unchanged mesh (by value)', () => {
    const mesh = unitCubeMesh();
    const { mesh: result } = removeComponents(mesh, { mode: 'minTriangles', minTriangles: 0 });
    expect(Array.from(result.positions)).toEqual(Array.from(mesh.positions));
    expect(Array.from(result.indices)).toEqual(Array.from(mesh.indices));
  });

  it('is deterministic: two independent calls on the same input produce byte-identical output', () => {
    const big = unitCubeMesh([0, 0, 0]);
    const speck: import('../mesh/types.ts').IndexedMesh = {
      positions: new Float64Array([100, 100, 100, 101, 100, 100, 100, 101, 100]),
      indices: Uint32Array.from([0, 1, 2]),
    };
    const mesh = concatMeshes(big, speck);
    const a = removeComponents(mesh, { mode: 'minTriangles', minTriangles: 2 });
    const b = removeComponents(mesh, { mode: 'minTriangles', minTriangles: 2 });

    expect(Array.from(a.mesh.positions)).toEqual(Array.from(b.mesh.positions));
    expect(Array.from(a.mesh.indices)).toEqual(Array.from(b.mesh.indices));
    expect(a.report).toEqual(b.report);
  });
});
