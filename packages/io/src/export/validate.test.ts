// packages/io/src/export/validate.test.ts
//
// Unit tests for `assertExportableSolid` — the export layer's
// topology-derived watertight/outward-orientation guarantee (Phase 7
// Task 2 deliverable 2). Every case here is a closed-form analytic solid
// (cube / tetrahedron) with a hand-verifiable expected outcome, per the
// tests-first + analytic-golden-before-fixture-meshes discipline.
import { describe, expect, it } from 'vitest';
import { ExportMeshInvalidError, type ExportableMesh } from './types.ts';
import {
  MAX_EXPORT_VERTEX_COUNT,
  assertExportVertexCountWithinEdgeKeyRange,
  assertExportableSolid,
} from './validate.ts';
import {
  CORNER_TETRAHEDRON_VOLUME_MM3,
  UNIT_CUBE2_VOLUME_MM3,
  cornerTetrahedron,
  unitCube2,
  windingReversed,
  withTrianglesDropped,
} from './export.test-fixtures.ts';

function expectReason(mesh: ExportableMesh, reason: ExportMeshInvalidError['reason']): void {
  let caught: unknown;
  try {
    assertExportableSolid(mesh);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ExportMeshInvalidError);
  expect((caught as ExportMeshInvalidError).reason).toBe(reason);
}

describe('assertExportableSolid: accepts analytic watertight outward solids', () => {
  it('accepts the cube and reports its closed-form volume (8 mm³)', () => {
    const check = assertExportableSolid(unitCube2());
    expect(check.vertexCount).toBe(8);
    expect(check.triangleCount).toBe(12);
    expect(check.signedVolumeMm3).toBeCloseTo(UNIT_CUBE2_VOLUME_MM3, 12);
    expect(check.signedVolumeMm3).toBeGreaterThan(0);
  });

  it('accepts the corner tetrahedron and reports its closed-form volume (1/6 mm³)', () => {
    const check = assertExportableSolid(cornerTetrahedron());
    expect(check.vertexCount).toBe(4);
    expect(check.triangleCount).toBe(4);
    expect(check.signedVolumeMm3).toBeCloseTo(CORNER_TETRAHEDRON_VOLUME_MM3, 15);
  });
});

describe('assertExportableSolid: inward orientation is DETECTED and REJECTED (falsifiable)', () => {
  it('rejects the fully winding-reversed cube as inward-oriented', () => {
    // Still watertight, still consistently wound — but every facet points
    // INTO the solid (signed volume -8). The export layer must refuse it,
    // never silently flip it (no-silent-mutation invariant).
    expectReason(windingReversed(unitCube2()), 'inward-orientation');
  });

  it('rejects the winding-reversed tetrahedron as inward-oriented', () => {
    expectReason(windingReversed(cornerTetrahedron()), 'inward-orientation');
  });
});

describe('assertExportableSolid: non-watertight / inconsistent topology is rejected', () => {
  it('rejects an open cube (one face removed) with boundary-edge', () => {
    expectReason(withTrianglesDropped(unitCube2(), 2), 'boundary-edge');
  });

  it('rejects a cube with a fin triangle (an edge shared by 3 triangles) with non-manifold-edge', () => {
    const cube = unitCube2();
    // Add a fin hanging off the bottom-front edge 0-1: edge 0-1 is now
    // incident to 3 triangles. (The fin's other two edges are boundary
    // edges too — non-manifold-edge must win the report, it is the more
    // fundamental defect.)
    const indices = new Uint32Array(cube.indices.length + 3);
    indices.set(cube.indices, 0);
    indices.set([0, 1, 4], cube.indices.length);
    expectReason({ positions: cube.positions, indices }, 'non-manifold-edge');
  });

  it('rejects a cube whose top face winding is flipped with inconsistent-winding', () => {
    const cube = unitCube2();
    const indices = cube.indices.slice();
    // Triangles 2 and 3 are the top face (4,5,6) / (4,6,7) — reverse both.
    indices.set([4, 6, 5], 6);
    indices.set([4, 7, 6], 9);
    expectReason({ positions: cube.positions, indices }, 'inconsistent-winding');
  });

  it('rejects a zero-volume "sandwich" (two coincident triangles, opposite winding)', () => {
    // Watertight by the edge criterion (every edge is shared by exactly 2
    // triangles, opposite directions) but encloses nothing.
    const mesh: ExportableMesh = {
      positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 1]),
    };
    expectReason(mesh, 'zero-volume');
  });
});

// ---------------------------------------------------------------------------
// Multi-component blindness regressions (Phase 7 Task 2 review, finding 1):
// "positive TOTAL signed volume ⇒ outward" only holds for a CONNECTED closed
// surface. Each probe below PASSED the pre-fix validator (demonstrated in the
// review); the fix requires exactly one edge-connected component and rejects
// exactly-zero-area triangles.
// ---------------------------------------------------------------------------

/** `mesh` uniformly scaled by `scale` and shifted by `dx` along x. */
function transformed(mesh: ExportableMesh, dx: number, scale: number): ExportableMesh {
  const positions = new Float64Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    positions[i] = mesh.positions[i]! * scale + dx;
    positions[i + 1] = mesh.positions[i + 1]! * scale;
    positions[i + 2] = mesh.positions[i + 2]! * scale;
  }
  return { positions, indices: mesh.indices.slice() };
}

/** Disjoint union of two meshes (b's indices offset past a's vertices). */
function merged(a: ExportableMesh, b: ExportableMesh): ExportableMesh {
  const positions = new Float64Array(a.positions.length + b.positions.length);
  positions.set(a.positions, 0);
  positions.set(b.positions, a.positions.length);
  const offset = a.positions.length / 3;
  const indices = new Uint32Array(a.indices.length + b.indices.length);
  indices.set(a.indices, 0);
  for (let i = 0; i < b.indices.length; i++) {
    indices[a.indices.length + i] = b.indices[i]! + offset;
  }
  return { positions, indices };
}

describe('assertExportableSolid: multi-component meshes are rejected (review finding 1 regressions)', () => {
  it('probe A: outward cube + free-floating INWARD cube (net volume +7) is rejected', () => {
    // Pre-fix: PASSED with signedVolumeMm3 = 7 — the inward component hid
    // inside the net-positive total.
    expectReason(merged(unitCube2(), transformed(windingReversed(unitCube2()), 10, 0.5)), 'multi-component');
  });

  it('probe A2: outward cube + NESTED inward shell (a void, net volume +7) is rejected', () => {
    expectReason(merged(unitCube2(), transformed(windingReversed(unitCube2()), 0, 0.5)), 'multi-component');
  });

  it('probe B: cube + detached zero-area flap is rejected (degenerate triangle wins the report)', () => {
    // Pre-fix: PASSED, and exportStlBinary then wrote two facets with the
    // writer's degenerate (0,0,0)-normal fallback.
    const flap: ExportableMesh = {
      positions: new Float64Array([20, 0, 0, 21, 0, 0, 22, 0, 0]), // collinear
      indices: new Uint32Array([0, 1, 2, 0, 2, 1]),
    };
    expectReason(merged(unitCube2(), flap), 'degenerate-triangle');
  });

  it('probe B2: cube + detached positive-area zero-volume sandwich is rejected', () => {
    const sandwich: ExportableMesh = {
      positions: new Float64Array([20, 0, 0, 21, 0, 0, 20, 1, 0]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 1]),
    };
    expectReason(merged(unitCube2(), sandwich), 'multi-component');
  });

  it('two disjoint OUTWARD cubes are also rejected — one export is one fused solid (documented policy)', () => {
    expectReason(merged(unitCube2(), transformed(unitCube2(), 10, 1)), 'multi-component');
  });

  it('a standalone exactly-zero-area triangle pair is rejected as degenerate, not zero-volume', () => {
    const flap: ExportableMesh = {
      positions: new Float64Array([0, 0, 0, 1, 0, 0, 2, 0, 0]), // collinear
      indices: new Uint32Array([0, 1, 2, 0, 2, 1]),
    };
    expectReason(flap, 'degenerate-triangle');
  });
});

describe('assertExportableSolid: malformed input is rejected with typed errors, never silently', () => {
  it('rejects an empty mesh', () => {
    expectReason({ positions: new Float64Array(0), indices: new Uint32Array(0) }, 'empty');
  });

  it('rejects a triangle with a repeated vertex index', () => {
    const cube = unitCube2();
    const indices = cube.indices.slice();
    indices[1] = indices[0]!; // triangle 0 becomes (0, 0, 2)
    expectReason({ positions: cube.positions, indices }, 'degenerate-triangle');
  });

  it('rejects non-Float64 positions (kernel Float64 rule)', () => {
    const cube = unitCube2();
    expectReason(
      { positions: new Float32Array(cube.positions) as unknown as Float64Array, indices: cube.indices },
      'structural',
    );
  });

  it('rejects non-Uint32 indices', () => {
    const cube = unitCube2();
    expectReason(
      { positions: cube.positions, indices: new Int32Array(cube.indices) as unknown as Uint32Array },
      'structural',
    );
  });

  it('rejects positions whose length is not a multiple of 3', () => {
    const cube = unitCube2();
    expectReason({ positions: cube.positions.slice(0, 23), indices: cube.indices }, 'structural');
  });

  it('rejects indices whose length is not a multiple of 3', () => {
    const cube = unitCube2();
    expectReason({ positions: cube.positions, indices: cube.indices.slice(0, 35) }, 'structural');
  });

  it('rejects an out-of-range vertex index', () => {
    const cube = unitCube2();
    const indices = cube.indices.slice();
    indices[5] = 8; // vertexCount is 8 — valid indices are 0..7
    expectReason({ positions: cube.positions, indices }, 'structural');
  });

  it('rejects a vertex count past the exact-edge-key ceiling (tested via the split-out guard)', () => {
    expect(() => assertExportVertexCountWithinEdgeKeyRange(MAX_EXPORT_VERTEX_COUNT)).not.toThrow();
    let caught: unknown;
    try {
      assertExportVertexCountWithinEdgeKeyRange(MAX_EXPORT_VERTEX_COUNT + 1);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExportMeshInvalidError);
    expect((caught as ExportMeshInvalidError).reason).toBe('structural');
  });

  it('rejects a non-finite coordinate', () => {
    const cube = unitCube2();
    const positions = cube.positions.slice();
    positions[4] = Number.NaN;
    expectReason({ positions, indices: cube.indices }, 'structural');
  });
});

describe('assertExportableSolid: determinism', () => {
  it('returns an identical check result on repeated calls over the same mesh', () => {
    const a = assertExportableSolid(unitCube2());
    const b = assertExportableSolid(unitCube2());
    expect(a).toEqual(b);
  });
});
