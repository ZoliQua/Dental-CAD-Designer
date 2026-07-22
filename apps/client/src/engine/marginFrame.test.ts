import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@dqcad/shared-types';
import {
  declutterScreenPoints,
  nearestScreenPointWithinRadius,
  toMarginOverlayRenderData,
  toMarginRenderPoints,
  toRenderPoint,
  toWorldRay,
  type IndexedScreenPoint,
} from './marginFrame';
import { MARGIN_WEAK_CONFIDENCE_THRESHOLD } from './marginEditor';
import type { LiveMarginSegment } from '../state/marginStore';

describe('toMarginRenderPoints', () => {
  it('subtracts the world offset from every point, preserving order', () => {
    const points: Vec3[] = [
      [10, 20, 30],
      [15, 25, 35],
    ];
    expect(toMarginRenderPoints(points, [10, 10, 10])).toEqual([
      [0, 10, 20],
      [5, 15, 25],
    ]);
  });

  it('is the identity when the world offset is zero', () => {
    expect(toMarginRenderPoints([[1, 2, 3]], [0, 0, 0])).toEqual([[1, 2, 3]]);
  });
});

describe('toRenderPoint', () => {
  it('subtracts the world offset', () => {
    expect(toRenderPoint([5, 5, 5], [1, 2, 3])).toEqual([4, 3, 2]);
  });
});

describe('toWorldRay (margin domain twin of measurementFrame.ts)', () => {
  it('adds the world offset to the ray origin and leaves direction unchanged', () => {
    const result = toWorldRay({ rayOrigin: [1, 2, 3], rayDirection: [0, 0, -1] }, [100, 200, 300]);
    expect(result.rayOrigin).toEqual([101, 202, 303]);
    expect(result.rayDirection).toEqual([0, 0, -1]);
  });
});

describe('toMarginOverlayRenderData', () => {
  const segments: LiveMarginSegment[] = [
    { points: [[0, 0, 0], [1, 0, 0]] },
    { points: [[1, 0, 0], [2, 0, 0]] },
    { points: [[2, 0, 0], [0, 0, 0]] },
  ];

  it('returns null for zero segments', () => {
    expect(toMarginOverlayRenderData([], null, true, [0, 0, 0])).toBeNull();
  });

  it('maps humanEdited to origin confirmed/proposed', () => {
    expect(toMarginOverlayRenderData(segments, null, true, [0, 0, 0])!.origin).toBe('confirmed');
    expect(toMarginOverlayRenderData(segments, null, false, [0, 0, 0])!.origin).toBe('proposed');
  });

  it('re-centers every segment point by the world offset', () => {
    const result = toMarginOverlayRenderData(segments, null, true, [1, 1, 1])!;
    expect(result.segments[0]!.points).toEqual([
      [-1, -1, -1],
      [0, -1, -1],
    ]);
  });

  it('flags a segment weak iff its confidence is below the threshold', () => {
    const confidence = [0.9, MARGIN_WEAK_CONFIDENCE_THRESHOLD - 0.01, MARGIN_WEAK_CONFIDENCE_THRESHOLD];
    const result = toMarginOverlayRenderData(segments, confidence, true, [0, 0, 0])!;
    expect(result.segments[0]!.weak).toBe(false);
    expect(result.segments[1]!.weak).toBe(true);
    // Exactly AT the threshold is NOT weak (strict '<', matching
    // marginEditor.ts's own MARGIN_WEAK_CONFIDENCE_THRESHOLD doc: 0.5 is
    // "ridge signal equals background", not yet below it).
    expect(result.segments[2]!.weak).toBe(false);
  });

  it('treats a null segmentConfidence (manual-mode curve) as never weak', () => {
    const result = toMarginOverlayRenderData(segments, null, true, [0, 0, 0])!;
    expect(result.segments.every((s) => !s.weak)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task 5 review item 3a/3b: declutterScreenPoints / nearestScreenPointWithinRadius
// ---------------------------------------------------------------------------

const HANDLE_SPACING = 20; // mirrors ui/MarginOverlay.tsx's HANDLE_DECLUTTER_MIN_SPACING_PX

describe('declutterScreenPoints (T5 review item 3a)', () => {
  it('keeps every point when they are all well beyond the spacing threshold', () => {
    const points: IndexedScreenPoint[] = [
      { index: 0, xPx: 0, yPx: 0 },
      { index: 1, xPx: 100, yPx: 0 },
      { index: 2, xPx: 200, yPx: 0 },
    ];
    expect(declutterScreenPoints(points, 20)).toEqual(points);
  });

  it('drops a later point that falls within the spacing threshold of an already-kept point', () => {
    const points: IndexedScreenPoint[] = [
      { index: 0, xPx: 0, yPx: 0 },
      { index: 1, xPx: 5, yPx: 0 }, // 5px from index 0 — inside a 20px threshold
      { index: 2, xPx: 100, yPx: 0 }, // far from everything kept so far
    ];
    expect(declutterScreenPoints(points, 20)).toEqual([
      { index: 0, xPx: 0, yPx: 0 },
      { index: 2, xPx: 100, yPx: 0 },
    ]);
  });

  it('processes points in ORDER — a point is only compared against ALREADY-KEPT points, not later ones', () => {
    // index 1 is close to index 0 (dropped); index 2 is close to index 1's
    // position but index 1 was never kept, so index 2 is compared only
    // against index 0 (far) and survives.
    const points: IndexedScreenPoint[] = [
      { index: 0, xPx: 0, yPx: 0 },
      { index: 1, xPx: 5, yPx: 0 },
      { index: 2, xPx: 10, yPx: 0 },
    ];
    expect(declutterScreenPoints(points, 8)).toEqual([
      { index: 0, xPx: 0, yPx: 0 },
      { index: 2, xPx: 10, yPx: 0 },
    ]);
  });

  it('respects an exact spacing boundary (strictly LESS-THAN the threshold is "too close")', () => {
    const points: IndexedScreenPoint[] = [
      { index: 0, xPx: 0, yPx: 0 },
      { index: 1, xPx: 20, yPx: 0 }, // EXACTLY 20px — not strictly < 20, so kept
    ];
    expect(declutterScreenPoints(points, 20)).toHaveLength(2);
  });

  it('self-resolves on zoom-in: the SAME two world anchors project further apart at higher zoom, so more of them clear the spacing threshold', () => {
    // Two anchors a fixed WORLD distance apart — `toScreen` stands in for
    // `projectToScreen` scaling linearly with zoom (a reasonable local
    // approximation near a small on-screen cluster).
    function toScreen(worldX: 0 | 1, zoom: number): IndexedScreenPoint {
      return { index: worldX, xPx: worldX * zoom, yPx: 0 };
    }
    const zoomedOut = [toScreen(0, 1), toScreen(1, 1)]; // 1px apart — same function, called independently — no hidden zoom state carried between calls
    const zoomedIn = [toScreen(0, 30), toScreen(1, 30)]; // 30px apart

    expect(declutterScreenPoints(zoomedOut, HANDLE_SPACING)).toHaveLength(1); // 1px apart: decluttered to 1 handle
    expect(declutterScreenPoints(zoomedIn, HANDLE_SPACING)).toHaveLength(2); // 30px apart: both clear the threshold and render
  });
});

describe('nearestScreenPointWithinRadius (T5 review item 3b)', () => {
  const points: IndexedScreenPoint[] = [
    { index: 0, xPx: 100, yPx: 100 },
    { index: 1, xPx: 104, yPx: 100 }, // 4px from index 0
  ];

  it('finds the nearest point within the radius', () => {
    expect(nearestScreenPointWithinRadius(points, 104, 100, 12)).toEqual(points[1]);
    expect(nearestScreenPointWithinRadius(points, 100, 100, 12)).toEqual(points[0]);
  });

  it('returns null when nothing is within the radius', () => {
    expect(nearestScreenPointWithinRadius(points, 500, 500, 12)).toBeNull();
  });

  it('returns null for an empty point list', () => {
    expect(nearestScreenPointWithinRadius([], 0, 0, 12)).toBeNull();
  });

  it('picks a click near an UNDRAWN (declutter-hidden) anchor over the drawn one — this is the exact claim ui/MarginOverlay.tsx\'s pick-priority interception depends on: it queries the FULL anchor set here, never the decluttered render subset', () => {
    // Two anchors 4px apart — declutterScreenPoints (threshold 20) would
    // render only index 0's handle; index 1 has no handle `<div>` at all.
    const rendered = declutterScreenPoints(points, HANDLE_SPACING);
    expect(rendered).toEqual([points[0]]); // confirm index 1 really is undrawn

    // A click precisely at index 1's (undrawn) position, searched against
    // the FULL `points` list (not `rendered`), still finds it.
    expect(nearestScreenPointWithinRadius(points, 104, 100, 12)).toEqual(points[1]);
  });

  it('a point exactly AT the radius boundary counts as within it (<=, not strict <)', () => {
    expect(nearestScreenPointWithinRadius([{ index: 0, xPx: 12, yPx: 0 }], 0, 0, 12)).toEqual({
      index: 0,
      xPx: 12,
      yPx: 0,
    });
  });
});
