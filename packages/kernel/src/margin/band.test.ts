// packages/kernel/src/margin/band.test.ts
//
// Tests for the margin-band primitive (band.ts) — per this task's brief:
// "margin-band analytic (a circular margin → band frame correct)", plus the
// CHORD-CAP guard and the ribbon mesh's topology.
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../bvh/geometry.ts';
import { buildHalfedge } from '../halfedge/build.ts';
import { findBoundaryLoops } from '../halfedge/iterate.ts';
import { assertValidTopology } from '../halfedge/validate.ts';
import {
  MARGIN_BAND_MIN_POINT_COUNT,
  MarginBandChordCapError,
  DegenerateMarginBandError,
  computeMarginLoopFrame,
  marginLoopMesh,
  marginLoopPolyline,
  type MarginBandInput,
} from './band.ts';

/** A closed circle of `n` points in the XY plane, centered at `center`,
 * radius `r`, ordered CCW (increasing angle) when viewed from +Z — the
 * standard orientation Newell's method gives a +Z normal for. */
function circlePoints(center: Vec3, r: number, n: number): Vec3[] {
  const points: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const theta = (2 * Math.PI * i) / n;
    points.push([center[0] + r * Math.cos(theta), center[1] + r * Math.sin(theta), center[2]]);
  }
  return points;
}

/** Rotates every point by a fixed orthonormal rotation matrix (rows u, v,
 * w) — used to build a TILTED circle whose known normal is `w`. */
function rotatePoints(points: readonly Vec3[], u: Vec3, v: Vec3, w: Vec3): Vec3[] {
  return points.map((p): Vec3 => {
    // p is expressed in the local (u,v,w) basis as (p[0], p[1], p[2]) since
    // circlePoints builds points with z = center[2] (constant); interpret
    // the circle's own local x/y/z as coefficients of u/v/w.
    return [
      p[0] * u[0] + p[1] * v[0] + p[2] * w[0],
      p[0] * u[1] + p[1] * v[1] + p[2] * w[1],
      p[0] * u[2] + p[1] * v[2] + p[2] * w[2],
    ];
  });
}

/** Simulates `resampledPoints` as REAL production code builds it
 * (`flattenResampledPoints`, per validate.ts's module doc): concatenated
 * per-segment arrays sharing an anchor at every boundary — i.e. every
 * point appears TWICE except it wraps once around the whole loop. */
function withDuplicateSegmentBoundaries(loop: readonly Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    out.push(loop[i]!, loop[(i + 1) % n]!);
  }
  return out;
}

describe('marginLoopPolyline — CHORD-CAP guard + dedup', () => {
  it('throws MarginBandChordCapError when resampledPoints is missing/empty', () => {
    const noPoints: MarginBandInput = { closed: true, resampledPoints: [] };
    expect(() => marginLoopPolyline(noPoints)).toThrow(MarginBandChordCapError);
  });

  it('throws DegenerateMarginBandError when closed is false', () => {
    const open: MarginBandInput = { closed: false, resampledPoints: circlePoints([0, 0, 0], 2, 8) };
    expect(() => marginLoopPolyline(open)).toThrow(DegenerateMarginBandError);
  });

  it('dedups duplicate segment-boundary points down to the true loop point count', () => {
    const loop = circlePoints([0, 0, 0], 2, 12);
    const withDupes = withDuplicateSegmentBoundaries(loop);
    expect(withDupes.length).toBe(loop.length * 2); // sanity: really has dupes
    const margin: MarginBandInput = { closed: true, resampledPoints: withDupes };
    const polyline = marginLoopPolyline(margin);
    expect(polyline.length).toBe(loop.length);
  });

  it('throws DegenerateMarginBandError for too few distinct points', () => {
    const margin: MarginBandInput = {
      closed: true,
      resampledPoints: [[0, 0, 0], [0, 0, 0], [1e-9, 0, 0]],
    };
    expect(() => marginLoopPolyline(margin)).toThrow(DegenerateMarginBandError);
  });
});

describe('computeMarginLoopFrame — circular margin, analytic', () => {
  it('a CCW circle in the XY plane: centroid = center, normal = +Z, orthonormal tangent basis', () => {
    const center: Vec3 = [3, -2, 5];
    const radius = 4;
    const loop = circlePoints(center, radius, 128);
    const frame = computeMarginLoopFrame(loop);

    expect(frame.centroidMm[0]).toBeCloseTo(center[0], 9);
    expect(frame.centroidMm[1]).toBeCloseTo(center[1], 9);
    expect(frame.centroidMm[2]).toBeCloseTo(center[2], 9);

    expect(frame.normal[0]).toBeCloseTo(0, 9);
    expect(frame.normal[1]).toBeCloseTo(0, 9);
    expect(frame.normal[2]).toBeCloseTo(1, 6);

    // Orthonormal frame: unit vectors, mutually perpendicular.
    const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
    expect(len(frame.tangentU)).toBeCloseTo(1, 9);
    expect(len(frame.tangentV)).toBeCloseTo(1, 9);
    expect(dot(frame.tangentU, frame.tangentV)).toBeCloseTo(0, 9);
    expect(dot(frame.tangentU, frame.normal)).toBeCloseTo(0, 9);
    expect(dot(frame.tangentV, frame.normal)).toBeCloseTo(0, 9);
  });

  it('a tilted circle: normal matches the known tilt direction', () => {
    const w: Vec3 = (() => {
      const raw: Vec3 = [1, 1, 1];
      const len = Math.hypot(raw[0], raw[1], raw[2]);
      return [raw[0] / len, raw[1] / len, raw[2] / len];
    })();
    // Build an orthonormal basis (u, v, w) with w as computed above.
    const reference: Vec3 = Math.abs(w[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const cross = (a: Vec3, b: Vec3): Vec3 => [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
    const normalize = (a: Vec3): Vec3 => {
      const len = Math.hypot(a[0], a[1], a[2]);
      return [a[0] / len, a[1] / len, a[2] / len];
    };
    const u = normalize(cross(reference, w));
    const v = cross(w, u);

    const localLoop = circlePoints([0, 0, 0], 3, 96); // local xy circle, local z=0
    const tiltedLoop = rotatePoints(localLoop, u, v, w).map(
      (p): Vec3 => [p[0] + 10, p[1] - 4, p[2] + 1], // + a translation
    );
    const frame = computeMarginLoopFrame(tiltedLoop);

    // Normal should match +/- w (Newell's sign depends on point order under
    // this specific rotation — assert the axis, not a fixed sign).
    const dot = frame.normal[0] * w[0] + frame.normal[1] * w[1] + frame.normal[2] * w[2];
    expect(Math.abs(dot)).toBeCloseTo(1, 5);

    expect(frame.centroidMm[0]).toBeCloseTo(10, 6);
    expect(frame.centroidMm[1]).toBeCloseTo(-4, 6);
    expect(frame.centroidMm[2]).toBeCloseTo(1, 6);
  });

  it('throws DegenerateMarginBandError for fewer than MARGIN_BAND_MIN_POINT_COUNT points', () => {
    expect(() => computeMarginLoopFrame([[0, 0, 0], [1, 0, 0]])).toThrow(DegenerateMarginBandError);
    expect(MARGIN_BAND_MIN_POINT_COUNT).toBe(3);
  });
});

describe('marginLoopMesh — thin ribbon, analytic + topology', () => {
  it('a circular margin: top/bottom rims at the exact analytic radius and offset height', () => {
    const center: Vec3 = [0, 0, 2];
    const radius = 4;
    const n = 64;
    const loop = circlePoints(center, radius, n);
    const halfThicknessMm = 0.002;

    const { mesh, directionUnit, halfThicknessMm: h } = marginLoopMesh(loop, { halfThicknessMm });
    expect(h).toBe(halfThicknessMm);
    expect(directionUnit[2]).toBeCloseTo(1, 6); // default direction = frame normal = +Z here

    expect(mesh.positions.length).toBe(n * 2 * 3);
    expect(mesh.indices.length).toBe(n * 2 * 3);

    for (let i = 0; i < n; i++) {
      const topX = mesh.positions[i * 3]!;
      const topY = mesh.positions[i * 3 + 1]!;
      const topZ = mesh.positions[i * 3 + 2]!;
      expect(Math.hypot(topX, topY)).toBeCloseTo(radius, 9);
      expect(topZ).toBeCloseTo(center[2] + halfThicknessMm, 9);

      const botIdx = n + i;
      const botX = mesh.positions[botIdx * 3]!;
      const botY = mesh.positions[botIdx * 3 + 1]!;
      const botZ = mesh.positions[botIdx * 3 + 2]!;
      expect(Math.hypot(botX, botY)).toBeCloseTo(radius, 9);
      expect(botZ).toBeCloseTo(center[2] - halfThicknessMm, 9);
    }
  });

  it('is a valid, consistently-oriented open 2-manifold (halfedge build succeeds; exactly 2 boundary loops)', () => {
    const loop = circlePoints([1, -1, 0], 3, 40);
    const { mesh } = marginLoopMesh(loop);
    const hm = buildHalfedge(mesh); // throws NonManifoldEdgeError if winding/topology is wrong
    assertValidTopology(hm);

    // Every interior (side-wall) edge is shared by exactly 2 triangles;
    // every rim edge (top-top or bottom-bottom) is a boundary edge shared
    // by exactly 1 — count boundary halfedges via findBoundaryLoops. The
    // ribbon has no top/bottom caps, so the top rim and the bottom rim
    // each form their own closed boundary loop: exactly 2 total.
    expect(findBoundaryLoops(hm).length).toBe(2);
  });

  it('throws for a degenerate (too-short) loop or non-positive halfThicknessMm', () => {
    expect(() => marginLoopMesh([[0, 0, 0], [1, 0, 0]])).toThrow(DegenerateMarginBandError);
    const loop = circlePoints([0, 0, 0], 2, 8);
    expect(() => marginLoopMesh(loop, { halfThicknessMm: 0 })).toThrow(TypeError);
    expect(() => marginLoopMesh(loop, { halfThicknessMm: -0.001 })).toThrow(TypeError);
    expect(() => marginLoopMesh(loop, { direction: [0, 0, 0] })).toThrow(TypeError);
  });

  it('determinism: same input twice -> byte-identical output', () => {
    const loop = circlePoints([0, 0, 0], 2.5, 32);
    const a = marginLoopMesh(loop);
    const b = marginLoopMesh(loop);
    expect(Array.from(a.mesh.positions)).toEqual(Array.from(b.mesh.positions));
    expect(Array.from(a.mesh.indices)).toEqual(Array.from(b.mesh.indices));
  });
});
