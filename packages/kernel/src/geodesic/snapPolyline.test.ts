// packages/kernel/src/geodesic/snapPolyline.test.ts
//
// `snapPolylineGeodesic`/`resnapPolylineAnchor` — deliverable 2 of this
// task's brief. The locality test (below) is the acceptance-relevant one:
// "API shaped for INCREMENTAL re-snap of one moved anchor — document + test
// locality" (this task's brief).
import { describe, expect, it } from 'vitest';
import { buildBvh } from '../bvh/build.ts';
import { buildHalfedge } from '../halfedge/build.ts';
import { icosphereMesh, openGridPatchMesh } from '../halfedge/halfedge.test-fixtures.ts';
import { evaluateSurfacePoint } from './surfacePoint.ts';
import { resnapPolylineAnchor, snapPolylineGeodesic } from './snapPolyline.ts';

describe('snapPolylineGeodesic', () => {
  it('projects every input point onto the surface and joins consecutive anchors with a geodesic segment', () => {
    const mesh = icosphereMesh(5, 3);
    const hm = buildHalfedge(mesh);
    const bvh = buildBvh(mesh);
    // Points slightly OFF the sphere (radius 6, not 5) — snapping should
    // pull them onto the r=5 surface.
    const points: [number, number, number][] = [
      [6, 0, 0],
      [0, 6, 0],
      [0, 0, 6],
      [-6, 0, 0],
    ];

    const polyline = snapPolylineGeodesic(mesh, hm, bvh, points);

    expect(polyline.anchors.length).toBe(4);
    expect(polyline.segments.length).toBe(3);
    for (const anchor of polyline.anchors) {
      const p = evaluateSurfacePoint(mesh, anchor);
      expect(Math.hypot(p[0], p[1], p[2])).toBeCloseTo(5, 6); // pulled onto the r=5 sphere
    }
    for (let i = 0; i < polyline.segments.length; i++) {
      const segment = polyline.segments[i]!;
      expect(segment.length).toBeGreaterThan(0);
      expect(segment.points[0]).toEqual(polyline.anchors[i]);
      expect(segment.points[segment.points.length - 1]).toEqual(polyline.anchors[i + 1]);
    }
  });

  it('a single point yields an anchor with zero segments', () => {
    const mesh = openGridPatchMesh(3, 3);
    const hm = buildHalfedge(mesh);
    const bvh = buildBvh(mesh);
    const polyline = snapPolylineGeodesic(mesh, hm, bvh, [[1, 1, 0]]);
    expect(polyline.anchors.length).toBe(1);
    expect(polyline.segments.length).toBe(0);
  });

  it('throws on an empty points array', () => {
    const mesh = openGridPatchMesh(3, 3);
    const hm = buildHalfedge(mesh);
    const bvh = buildBvh(mesh);
    expect(() => snapPolylineGeodesic(mesh, hm, bvh, [])).toThrow(RangeError);
  });
});

describe('resnapPolylineAnchor — locality (this task\'s brief: "incremental re-snap")', () => {
  it('moving an interior anchor recomputes ONLY its two touching segments — every other segment is the SAME object reference', () => {
    const mesh = icosphereMesh(5, 3);
    const hm = buildHalfedge(mesh);
    const bvh = buildBvh(mesh);
    const points: [number, number, number][] = [
      [5, 0, 0],
      [0, 5, 0],
      [0, 0, 5],
      [-5, 0, 0],
      [0, -5, 0],
    ];
    const original = snapPolylineGeodesic(mesh, hm, bvh, points);

    // Move anchor index 2 (interior) to a different point on the sphere.
    const moved = resnapPolylineAnchor(mesh, hm, bvh, original, 2, [0, 0, -5]);

    expect(moved.anchors.length).toBe(original.anchors.length);
    expect(moved.segments.length).toBe(original.segments.length);

    // Anchor 2 changed; every other anchor is untouched (same reference).
    expect(moved.anchors[2]).not.toBe(original.anchors[2]);
    expect(moved.anchors[0]).toBe(original.anchors[0]);
    expect(moved.anchors[1]).toBe(original.anchors[1]);
    expect(moved.anchors[3]).toBe(original.anchors[3]);
    expect(moved.anchors[4]).toBe(original.anchors[4]);

    // Segments 1 (anchor1-anchor2) and 2 (anchor2-anchor3) touch the moved
    // anchor and MUST be recomputed (new object). Segments 0 and 3 do not
    // touch it and must be the exact SAME object reference — the locality
    // guarantee this task's brief asks for.
    expect(moved.segments[1]).not.toBe(original.segments[1]);
    expect(moved.segments[2]).not.toBe(original.segments[2]);
    expect(moved.segments[0]).toBe(original.segments[0]);
    expect(moved.segments[3]).toBe(original.segments[3]);
  });

  it('moving an ENDPOINT anchor recomputes only its single touching segment', () => {
    const mesh = icosphereMesh(5, 3);
    const hm = buildHalfedge(mesh);
    const bvh = buildBvh(mesh);
    const points: [number, number, number][] = [
      [5, 0, 0],
      [0, 5, 0],
      [0, 0, 5],
    ];
    const original = snapPolylineGeodesic(mesh, hm, bvh, points);

    const movedFirst = resnapPolylineAnchor(mesh, hm, bvh, original, 0, [0, -5, 0]);
    expect(movedFirst.segments[0]).not.toBe(original.segments[0]);
    expect(movedFirst.segments[1]).toBe(original.segments[1]);

    const movedLast = resnapPolylineAnchor(mesh, hm, bvh, original, 2, [-5, 0, 0]);
    expect(movedLast.segments[0]).toBe(original.segments[0]);
    expect(movedLast.segments[1]).not.toBe(original.segments[1]);
  });

  it('does not mutate the input polyline', () => {
    const mesh = openGridPatchMesh(4, 4);
    const hm = buildHalfedge(mesh);
    const bvh = buildBvh(mesh);
    const points: [number, number, number][] = [
      [0.5, 0.5, 0],
      [2, 2, 0],
      [3.5, 3.5, 0],
    ];
    const original = snapPolylineGeodesic(mesh, hm, bvh, points);
    const originalAnchorsSnapshot = [...original.anchors];
    const originalSegmentsSnapshot = [...original.segments];

    resnapPolylineAnchor(mesh, hm, bvh, original, 1, [1, 3, 0]);

    expect(original.anchors).toEqual(originalAnchorsSnapshot);
    expect(original.segments).toEqual(originalSegmentsSnapshot);
  });

  it('throws RangeError for an out-of-range index', () => {
    const mesh = openGridPatchMesh(3, 3);
    const hm = buildHalfedge(mesh);
    const bvh = buildBvh(mesh);
    const polyline = snapPolylineGeodesic(mesh, hm, bvh, [
      [0.5, 0.5, 0],
      [2, 2, 0],
    ]);
    expect(() => resnapPolylineAnchor(mesh, hm, bvh, polyline, -1, [1, 1, 0])).toThrow(RangeError);
    expect(() => resnapPolylineAnchor(mesh, hm, bvh, polyline, 2, [1, 1, 0])).toThrow(RangeError);
    expect(() => resnapPolylineAnchor(mesh, hm, bvh, polyline, 1.5, [1, 1, 0])).toThrow(RangeError);
  });
});
