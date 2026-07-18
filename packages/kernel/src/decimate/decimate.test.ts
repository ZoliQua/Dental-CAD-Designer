// packages/kernel/src/decimate/decimate.test.ts
//
// Unit tests for `decimateMesh`: option validation, the link-condition
// pinch fixture (this task's central topology-safety guardrail), boundary
// preservation, the QEM-solve fallback chain, and basic reduction behavior.
// Analytic (sphere volume/deviation) and property-based (fast-check)
// coverage live in decimate.analytic.test.ts / decimate.property.test.ts.
import { describe, expect, it } from 'vitest';
import { buildHalfedge } from '../halfedge/build.ts';
import { assertValidTopology, findBoundaryLoops } from '../halfedge/index.ts';
import { openGridPatchMesh, icosphereMesh } from '../halfedge/halfedge.test-fixtures.ts';
import { analyzeMesh } from '../intake/analyze.ts';
import { beginDecimation, decimateMesh } from './decimate.ts';
import { pinchFixtureMesh } from './decimate.test-fixtures.ts';
import { edgeCollapseIsManifoldSafe } from './linkCondition.ts';
import { addQuadric, quadricError, solveOptimalPosition, triangleQuadric } from './quadric.ts';

describe('decimateMesh — option validation', () => {
  const mesh = icosphereMesh(5, 1);

  it('throws if neither targetTriangleCount nor errorBoundMm is given', () => {
    expect(() => decimateMesh(mesh, {})).toThrow(TypeError);
  });

  it('throws for a negative/non-integer targetTriangleCount', () => {
    expect(() => decimateMesh(mesh, { targetTriangleCount: -1 })).toThrow(TypeError);
    expect(() => decimateMesh(mesh, { targetTriangleCount: 1.5 })).toThrow(TypeError);
  });

  it('throws for a non-finite/non-positive errorBoundMm', () => {
    expect(() => decimateMesh(mesh, { errorBoundMm: 0 })).toThrow(TypeError);
    expect(() => decimateMesh(mesh, { errorBoundMm: -1 })).toThrow(TypeError);
    expect(() => decimateMesh(mesh, { errorBoundMm: Number.NaN })).toThrow(TypeError);
  });

  it('never mutates the input mesh (HARD INVARIANT: kernel data of record is never decimated implicitly)', () => {
    const positionsBefore = mesh.positions.slice();
    const indicesBefore = mesh.indices.slice();
    decimateMesh(mesh, { targetTriangleCount: 10 });
    expect(mesh.positions).toEqual(positionsBefore);
    expect(mesh.indices).toEqual(indicesBefore);
  });
});

describe('decimateMesh — basic reduction', () => {
  it('reduces triangle count toward targetTriangleCount on a closed mesh', () => {
    const mesh = icosphereMesh(5, 2); // 320 triangles
    const target = 80;
    const result = decimateMesh(mesh, { targetTriangleCount: target });
    expect(result.inputTriangleCount).toBe(mesh.indices.length / 3);
    expect(result.outputTriangleCount).toBeLessThanOrEqual(result.inputTriangleCount);
    expect(result.outputTriangleCount).toBeLessThanOrEqual(target);
    expect(result.collapseCount).toBeGreaterThan(0);
    // Output is still a valid, closed 2-manifold.
    const hm = buildHalfedge(result.mesh);
    expect(() => assertValidTopology(hm)).not.toThrow();
    const stats = analyzeMesh(result.mesh);
    expect(stats.watertight).toBe(true);
    expect(stats.manifoldEdges).toBe(true);
  });

  it('a target at/above the input triangle count performs no collapses', () => {
    const mesh = icosphereMesh(5, 1);
    const triangleCount = mesh.indices.length / 3;
    const result = decimateMesh(mesh, { targetTriangleCount: triangleCount });
    expect(result.collapseCount).toBe(0);
    expect(result.outputTriangleCount).toBe(triangleCount);
  });

  it('a target of 0 reduces as far as the topology allows without ever going non-manifold', () => {
    const mesh = icosphereMesh(5, 2);
    const result = decimateMesh(mesh, { targetTriangleCount: 0 });
    expect(result.outputTriangleCount).toBeGreaterThan(0); // can't collapse a closed manifold to nothing
    const hm = buildHalfedge(result.mesh);
    expect(() => assertValidTopology(hm)).not.toThrow();
  });

  it('a tight errorBoundMm limits the max realized error', () => {
    const mesh = icosphereMesh(5, 2);
    const bound = 0.05;
    const result = decimateMesh(mesh, { errorBoundMm: bound });
    expect(result.maxErrorMm).toBeLessThanOrEqual(bound);
    const hm = buildHalfedge(result.mesh);
    expect(() => assertValidTopology(hm)).not.toThrow();
  });
});

describe('decimateMesh — link condition (pinch fixture)', () => {
  it('buildHalfedge accepts the pinch fixture (every edge is locally manifold)', () => {
    const mesh = pinchFixtureMesh();
    expect(() => buildHalfedge(mesh)).not.toThrow();
  });

  it('edgeCollapseIsManifoldSafe directly rejects the pinch edge (B, C) but accepts an ordinary one', () => {
    const mesh = pinchFixtureMesh();
    const hm = buildHalfedge(mesh);
    const vertexTriangles: Set<number>[] = Array.from({ length: hm.vertexCount }, () => new Set<number>());
    const triDeleted = new Uint8Array(hm.faceCount);
    for (let t = 0; t < hm.faceCount; t++) {
      vertexTriangles[mesh.indices[t * 3]!]!.add(t);
      vertexTriangles[mesh.indices[t * 3 + 1]!]!.add(t);
      vertexTriangles[mesh.indices[t * 3 + 2]!]!.add(t);
    }
    // B=1, C=2 (see pinchFixtureMesh's doc) — the pinch edge.
    expect(edgeCollapseIsManifoldSafe(1, 2, vertexTriangles, mesh.indices, triDeleted)).toBe(false);
    // A=0, B=1 — an ordinary edge (apexes {C, D} only, no extra common
    // neighbor) — link condition holds.
    expect(edgeCollapseIsManifoldSafe(0, 1, vertexTriangles, mesh.indices, triDeleted)).toBe(true);
  });

  it('decimateMesh never produces a non-manifold result on the pinch fixture, even under maximum reduction pressure', () => {
    const mesh = pinchFixtureMesh();
    const result = decimateMesh(mesh, { targetTriangleCount: 0 });
    const hm = buildHalfedge(result.mesh); // throws NonManifoldEdgeError if the link condition ever let a bad collapse through
    expect(() => assertValidTopology(hm)).not.toThrow();
  });
});

describe('decimateMesh — boundary preservation', () => {
  it('never moves or removes an original boundary vertex', () => {
    const mesh = openGridPatchMesh(8, 8, 1);
    const beforeHm = buildHalfedge(mesh);
    const boundaryVerticesBefore = new Set<number>();
    for (const loop of findBoundaryLoops(beforeHm)) {
      for (const he of loop) boundaryVerticesBefore.add(beforeHm.vertex[he]!);
    }
    const boundaryPositionsBefore = new Map<number, readonly [number, number, number]>();
    for (const v of boundaryVerticesBefore) {
      boundaryPositionsBefore.set(v, [
        mesh.positions[v * 3]!,
        mesh.positions[v * 3 + 1]!,
        mesh.positions[v * 3 + 2]!,
      ]);
    }

    const result = decimateMesh(mesh, { targetTriangleCount: 0 });
    expect(result.outputTriangleCount).toBeLessThan(result.inputTriangleCount); // interior did shrink

    // Every original boundary vertex is still present in the output, at
    // the EXACT same position (never touched by any collapse — see
    // decimate.ts's "Boundary policy" doc).
    const outPositionsAsKeys = new Set<string>();
    for (let v = 0; v < result.mesh.positions.length / 3; v++) {
      outPositionsAsKeys.add(
        `${result.mesh.positions[v * 3]},${result.mesh.positions[v * 3 + 1]},${result.mesh.positions[v * 3 + 2]}`,
      );
    }
    for (const [, pos] of boundaryPositionsBefore) {
      expect(outPositionsAsKeys.has(`${pos[0]},${pos[1]},${pos[2]}`)).toBe(true);
    }

    // The boundary LOOP itself (vertex count, i.e. its length) is unchanged.
    const afterHm = buildHalfedge(result.mesh);
    const afterLoops = findBoundaryLoops(afterHm);
    expect(afterLoops).toHaveLength(1);
    expect(afterLoops[0]!.length).toBe(findBoundaryLoops(beforeHm)[0]!.length);
  });
});

describe('beginDecimation — chunked session', () => {
  it('driving the session in small step() chunks is byte-identical to one blocking decimateMesh call', () => {
    const mesh = icosphereMesh(5, 2);
    const target = 80;

    const blocking = decimateMesh(mesh, { targetTriangleCount: target });

    const session = beginDecimation(mesh, { targetTriangleCount: target });
    expect(session.inputTriangleCount).toBe(mesh.indices.length / 3);
    let lastProgress = 0;
    while (!session.isDone()) {
      const performed = session.step(7); // deliberately odd, small chunk size
      expect(performed).toBeGreaterThan(0); // isDone() was false, so progress must be possible
      const progress = session.progressFraction();
      expect(progress).toBeGreaterThanOrEqual(lastProgress); // monotone for a target-based run
      lastProgress = progress;
    }
    const chunked = session.finish();

    expect(chunked.mesh.positions).toEqual(blocking.mesh.positions);
    expect(chunked.mesh.indices).toEqual(blocking.mesh.indices);
    expect(chunked.collapseCount).toBe(blocking.collapseCount);
    expect(chunked.maxErrorMm).toBe(blocking.maxErrorMm);
    expect(session.liveTriangleCount()).toBe(chunked.outputTriangleCount);
  });

  it('finish() is idempotent and step() after isDone() is a no-op', () => {
    const mesh = icosphereMesh(5, 1);
    const session = beginDecimation(mesh, { targetTriangleCount: 20 });
    session.step(Number.POSITIVE_INFINITY);
    expect(session.isDone()).toBe(true);
    const first = session.finish();
    expect(session.step(10)).toBe(0);
    expect(session.finish()).toBe(first); // cached object identity
  });

  it('finish() before completion yields a valid, less-reduced intermediate mesh', () => {
    const mesh = icosphereMesh(5, 2);
    const session = beginDecimation(mesh, { targetTriangleCount: 40 });
    session.step(5);
    const intermediate = session.finish();
    expect(intermediate.outputTriangleCount).toBeGreaterThan(40);
    expect(intermediate.collapseCount).toBe(5);
    const hm = buildHalfedge(intermediate.mesh);
    expect(() => assertValidTopology(hm)).not.toThrow();
    // The session keeps working after an early snapshot.
    session.step(Number.POSITIVE_INFINITY);
    const final = session.finish();
    expect(final.outputTriangleCount).toBeLessThanOrEqual(40);
    expect(analyzeMesh(final.mesh).manifoldEdges).toBe(true);
  });
});

describe('quadric.ts — QEM solve fallback chain', () => {
  it('solveOptimalPosition returns null for a degenerate (all-zero) quadric', () => {
    const zero = new Float64Array(10);
    expect(solveOptimalPosition(zero)).toBeNull();
  });

  it('solveOptimalPosition finds the exact minimizer for two non-parallel planes plus a third pinning point', () => {
    // Three non-coplanar, non-degenerate triangles all passing through the
    // origin — their combined quadric is well-conditioned and its unique
    // minimizer must be the origin itself (zero error there).
    const q1 = triangleQuadric(0, 0, 0, 1, 0, 0, 0, 1, 0);
    const q2 = triangleQuadric(0, 0, 0, 0, 1, 0, 0, 0, 1);
    const q3 = triangleQuadric(0, 0, 0, 1, 0, 0, 0, 0, 1);
    const q = addQuadric(addQuadric(q1, q2), q3);
    const solved = solveOptimalPosition(q);
    expect(solved).not.toBeNull();
    const [x, y, z] = solved!;
    expect(x).toBeCloseTo(0, 9);
    expect(y).toBeCloseTo(0, 9);
    expect(z).toBeCloseTo(0, 9);
    expect(quadricError(q, x, y, z)).toBeCloseTo(0, 9);
  });

  it('a degenerate (zero-area) triangle contributes a zero quadric, never NaN/Infinity', () => {
    const q = triangleQuadric(0, 0, 0, 0, 0, 0, 1, 1, 1); // repeated vertex -> zero cross product
    expect(Array.from(q).every((v) => v === 0)).toBe(true);
  });
});
