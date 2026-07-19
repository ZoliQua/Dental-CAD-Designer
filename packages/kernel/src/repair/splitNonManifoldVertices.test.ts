// packages/kernel/src/repair/splitNonManifoldVertices.test.ts
import { describe, expect, it } from 'vitest';
import { buildHalfedge, findNonManifoldVertices } from '../halfedge/build.ts';
import { assertValidTopology } from '../halfedge/validate.ts';
import { unitCubeMesh, singleBowtieMesh, doubleBowtieMesh, openFanBowtieMesh } from './repair.test-fixtures.ts';
import { splitNonManifoldVertices } from './splitNonManifoldVertices.ts';

describe('splitNonManifoldVertices — single bowtie', () => {
  it('detects the bowtie up front (sanity: the fixture is actually a bowtie)', () => {
    const bowties = findNonManifoldVertices(singleBowtieMesh());
    expect(bowties).toEqual([{ vertex: 0, fanCount: 2 }]);
  });

  it('duplicates exactly 1 vertex (the second fan) and resolves the bowtie', () => {
    const mesh = singleBowtieMesh();
    const { mesh: result, report } = splitNonManifoldVertices(mesh);

    expect(report.nonManifoldVertexCountBefore).toBe(1);
    expect(report.duplicatedVertexCount).toBe(1);
    expect(report.nonManifoldVertexCountAfter).toBe(0);
    expect(report.before.vertexCount).toBe(7); // apex + 2*3 base
    expect(report.after.vertexCount).toBe(8);
    expect(report.before.triangleCount).toBe(report.after.triangleCount); // triangle count never changes

    expect(findNonManifoldVertices(result)).toHaveLength(0);
  });

  it('the split mesh builds valid halfedge topology (buildHalfedge + assertValidTopology)', () => {
    const { mesh: result } = splitNonManifoldVertices(singleBowtieMesh());
    const hm = buildHalfedge(result);
    expect(() => assertValidTopology(hm)).not.toThrow();
  });

  it('keeps the first fan (lowest triangle index) at the ORIGINAL vertex id 0', () => {
    const mesh = singleBowtieMesh();
    const { mesh: result } = splitNonManifoldVertices(mesh);
    // Triangle 0 is the first fan's first side triangle (apex, b0, b1) — its
    // apex corner must stay vertex 0 (see module doc's "first-fan-keeps-
    // original" convention).
    expect(result.indices[0]).toBe(0);
    // Triangle 4 (index 4*3=12) is the SECOND fan's first side triangle —
    // its apex corner must be the new duplicate (vertex 7, appended last).
    expect(result.indices[4 * 3]).toBe(7);
  });

  it('the duplicate vertex has the SAME position as the original apex', () => {
    const mesh = singleBowtieMesh();
    const { mesh: result } = splitNonManifoldVertices(mesh);
    expect([result.positions[21], result.positions[22], result.positions[23]]).toEqual([
      result.positions[0],
      result.positions[1],
      result.positions[2],
    ]);
  });

  it('is deterministic: two independent calls produce byte-identical output', () => {
    const mesh = singleBowtieMesh();
    const a = splitNonManifoldVertices(mesh);
    const b = splitNonManifoldVertices(mesh);
    expect(Array.from(a.mesh.positions)).toEqual(Array.from(b.mesh.positions));
    expect(Array.from(a.mesh.indices)).toEqual(Array.from(b.mesh.indices));
    expect(a.report).toEqual(b.report);
  });
});

describe('splitNonManifoldVertices — double bowtie (3 fans)', () => {
  it('detects fanCount 3 up front', () => {
    const bowties = findNonManifoldVertices(doubleBowtieMesh());
    expect(bowties).toEqual([{ vertex: 0, fanCount: 3 }]);
  });

  it('duplicates exactly 2 vertices (the 2nd and 3rd fans)', () => {
    const mesh = doubleBowtieMesh();
    const { mesh: result, report } = splitNonManifoldVertices(mesh);

    expect(report.nonManifoldVertexCountBefore).toBe(1);
    expect(report.duplicatedVertexCount).toBe(2);
    expect(report.nonManifoldVertexCountAfter).toBe(0);
    expect(report.after.vertexCount).toBe(report.before.vertexCount + 2);

    expect(findNonManifoldVertices(result)).toHaveLength(0);
  });

  it('the split mesh builds valid halfedge topology', () => {
    const { mesh: result } = splitNonManifoldVertices(doubleBowtieMesh());
    const hm = buildHalfedge(result);
    expect(() => assertValidTopology(hm)).not.toThrow();
  });

  it('is deterministic', () => {
    const mesh = doubleBowtieMesh();
    const a = splitNonManifoldVertices(mesh);
    const b = splitNonManifoldVertices(mesh);
    expect(Array.from(a.mesh.positions)).toEqual(Array.from(b.mesh.positions));
    expect(Array.from(a.mesh.indices)).toEqual(Array.from(b.mesh.indices));
  });
});

describe('splitNonManifoldVertices — open-fan bowtie (boundary vertex, two OPEN fans)', () => {
  it('detects the bowtie up front (fanCount 2), the apex itself being a boundary vertex in both fans', () => {
    const bowties = findNonManifoldVertices(openFanBowtieMesh());
    expect(bowties).toEqual([{ vertex: 0, fanCount: 2 }]);
  });

  it('splits correctly (1 duplicate) and resolves the bowtie', () => {
    const mesh = openFanBowtieMesh();
    const { mesh: result, report } = splitNonManifoldVertices(mesh);
    expect(report.nonManifoldVertexCountBefore).toBe(1);
    expect(report.duplicatedVertexCount).toBe(1);
    expect(report.nonManifoldVertexCountAfter).toBe(0);
    expect(findNonManifoldVertices(result)).toHaveLength(0);
  });

  it('the split mesh builds valid halfedge topology (buildHalfedge + assertValidTopology)', () => {
    const { mesh: result } = splitNonManifoldVertices(openFanBowtieMesh());
    const hm = buildHalfedge(result);
    expect(() => assertValidTopology(hm)).not.toThrow();
  });
});

describe('splitNonManifoldVertices — idempotence / no-op on a clean mesh', () => {
  it('a bowtie-free mesh is a no-op, by REFERENCE (same mesh object back)', () => {
    const mesh = unitCubeMesh();
    const { mesh: result, report } = splitNonManifoldVertices(mesh);
    expect(result).toBe(mesh);
    expect(report.nonManifoldVertexCountBefore).toBe(0);
    expect(report.duplicatedVertexCount).toBe(0);
  });

  it('running it twice on a bowtie mesh: the second pass is a no-op', () => {
    const mesh = singleBowtieMesh();
    const first = splitNonManifoldVertices(mesh);
    const second = splitNonManifoldVertices(first.mesh);
    expect(second.report.nonManifoldVertexCountBefore).toBe(0);
    expect(second.report.duplicatedVertexCount).toBe(0);
    expect(second.mesh).toBe(first.mesh);
  });
});
