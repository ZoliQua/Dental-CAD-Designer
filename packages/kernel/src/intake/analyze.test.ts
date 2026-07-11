// packages/kernel/src/intake/analyze.test.ts
//
// Analytic tests for analyzeMesh, using the icosphere test fixture already
// established (and verified against manifold-3d) by
// packages/kernel/src/boolean/manifold.test.ts / manifold.test-fixtures.ts.
import { describe, expect, it } from 'vitest';
import type { IndexedMesh } from '../mesh/types.ts';
import { icosphereMesh } from '../boolean/manifold.test-fixtures.ts';
import { analyzeMesh } from './analyze.ts';

const SPHERE_RADIUS = 5;
const SPHERE_SUBDIVISIONS = 3; // ~0.86% volume error vs analytic — see manifold.test-fixtures.ts's doc.
const ANALYTIC_VOLUME = (4 / 3) * Math.PI * SPHERE_RADIUS ** 3;
const ANALYTIC_AREA = 4 * Math.PI * SPHERE_RADIUS ** 2;
const RELATIVE_TOLERANCE = 0.02;

describe('analyzeMesh — closed sphere (analytic)', () => {
  const sphere = icosphereMesh(SPHERE_RADIUS, SPHERE_SUBDIVISIONS);
  const stats = analyzeMesh(sphere);

  it('reports watertight and manifoldEdges true, zero boundary edges', () => {
    expect(stats.watertight).toBe(true);
    expect(stats.manifoldEdges).toBe(true);
    expect(stats.boundaryEdgeCount).toBe(0);
  });

  it('reports a single connected component', () => {
    expect(stats.componentCount).toBe(1);
  });

  it('reports zero degenerate triangles', () => {
    expect(stats.degenerateCount).toBe(0);
  });

  it('reports surfaceAreaMm2 within tolerance of the analytic sphere area', () => {
    const relativeError = Math.abs(stats.surfaceAreaMm2 - ANALYTIC_AREA) / ANALYTIC_AREA;
    expect(relativeError).toBeLessThan(RELATIVE_TOLERANCE);
  });

  it('reports signedVolumeMm3 (closed-only) within tolerance of the analytic sphere volume', () => {
    expect(stats.signedVolumeMm3).not.toBeNull();
    const relativeError = Math.abs(stats.signedVolumeMm3! - ANALYTIC_VOLUME) / ANALYTIC_VOLUME;
    expect(relativeError).toBeLessThan(RELATIVE_TOLERANCE);
  });

  it('reports a bbox consistent with a radius-5 sphere', () => {
    for (let axis = 0; axis < 3; axis++) {
      expect(stats.bbox.min[axis]).toBeLessThan(0);
      expect(stats.bbox.max[axis]).toBeGreaterThan(0);
      expect(Math.abs(stats.bbox.min[axis]!)).toBeLessThanOrEqual(SPHERE_RADIUS + 1e-9);
      expect(stats.bbox.max[axis]).toBeLessThanOrEqual(SPHERE_RADIUS + 1e-9);
      // Icosphere vertices sit exactly on the analytic sphere, so with
      // enough subdivisions the extreme coordinate approaches the radius.
      expect(Math.abs(stats.bbox.min[axis]!)).toBeGreaterThan(SPHERE_RADIUS * 0.8);
    }
  });
});

describe('analyzeMesh — open mesh (one triangle removed from the sphere)', () => {
  const closed = icosphereMesh(SPHERE_RADIUS, 1);
  const open: IndexedMesh = { positions: closed.positions, indices: closed.indices.slice(3) };
  const stats = analyzeMesh(open);

  it('is not watertight, has a boundary loop, and reports null signedVolumeMm3', () => {
    expect(stats.watertight).toBe(false);
    expect(stats.manifoldEdges).toBe(true); // still 2-manifold, just open
    expect(stats.boundaryEdgeCount).toBe(3); // the 3 edges of the removed triangle
    expect(stats.signedVolumeMm3).toBeNull();
  });
});

describe('analyzeMesh — component count', () => {
  it('counts two disjoint spheres as 2 components', () => {
    const a = icosphereMesh(1, 1, [-5, 0, 0]);
    const b = icosphereMesh(1, 1, [5, 0, 0]);
    const merged: IndexedMesh = {
      positions: Float64Array.from([...a.positions, ...b.positions]),
      indices: Uint32Array.from([...a.indices, ...b.indices.map((i) => i + a.positions.length / 3)]),
    };
    const stats = analyzeMesh(merged);
    expect(stats.componentCount).toBe(2);
    expect(stats.watertight).toBe(true); // both components individually closed
  });
});

describe('analyzeMesh — degenerateCount is diagnostic-only (does not remove anything)', () => {
  it('counts a duplicate-index triangle appended to an otherwise valid mesh, without dropping it', () => {
    const mesh: IndexedMesh = {
      positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: Uint32Array.from([0, 1, 2, 0, 1, 1]),
    };
    const stats = analyzeMesh(mesh);
    expect(stats.degenerateCount).toBe(1);
  });
});

describe('analyzeMesh — empty mesh', () => {
  it('handles zero triangles without throwing, reporting a zero bbox and not watertight', () => {
    const mesh: IndexedMesh = { positions: new Float64Array(0), indices: new Uint32Array(0) };
    const stats = analyzeMesh(mesh);
    expect(stats.watertight).toBe(false);
    expect(stats.componentCount).toBe(0);
    expect(stats.bbox).toEqual({ min: [0, 0, 0], max: [0, 0, 0] });
    expect(stats.signedVolumeMm3).toBeNull();
  });
});
